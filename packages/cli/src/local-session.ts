import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BOOTSTRAP_GRANT_FILE,
  BOOTSTRAP_PATH,
  BootstrapError,
  BootstrapGrant,
  ClientSessionCredential,
  EnvironmentNotice,
  PROTOCOL_VERSION,
  WIRE_PATH,
  decodeFrame,
  encodeFrame,
  formatHostPort,
  registry,
  type Frame,
  type MethodName,
  type ParamsOf,
  type ResponseFrame,
  type ResponseOf,
  type WireError,
} from "@agent-harness/contracts";
import { HARNESS_VERSION, systemClock, type Clock, type Timer } from "@agent-harness/environment";

/**
 * The route every CLI verb that asks the environment on this machine
 * something takes (`pair`, the `update` verbs, `browser pair`, the `bank` verbs): the
 * bootstrap grant in the environment's data directory is exchanged for a
 * local client session, the verb makes its calls on the wire and hears the
 * environment's notices from then on when it waits on one, and the client
 * session is revoked before the verb exits, so no run leaves one behind.
 */

/** The network a verb uses: the platform's own, or a test's recording one. */
export interface Net {
  readonly fetch: typeof fetch;
  readonly WebSocket: typeof WebSocket;
}

/** Which environment: the one whose data directory holds the grant, at the port the grant names unless another is given. */
export interface LocalTarget {
  readonly dataDir: string;
  readonly port?: number | undefined;
}

/** A verb could not do its work on the local environment; the message says why, for people. */
export class LocalFailure extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalFailure";
  }
}

/** The environment answered a call with an error: the error as the wire carried it. */
export class LocalRefusal extends LocalFailure {
  readonly error: WireError;

  constructor(method: string, error: WireError) {
    super(`The environment refused ${method}: ${error.message}`);
    this.name = "LocalRefusal";
    this.error = error;
  }
}

/** How long one call may wait for its answer. */
export interface LocalCallOptions {
  /** How long the environment may stay silent while it works on this call; preset the route's timeout. A bank's landing waits minutes on its forge's check. */
  readonly timeoutMs?: number;
}

/** One call on the wire: the method's response, or a `LocalRefusal` thrown with the environment's error. */
export type LocalCall = <N extends MethodName>(method: N, params: ParamsOf<N>, options?: LocalCallOptions) => Promise<ResponseOf<N>>;

/**
 * Follows the environment's notices (`environment.subscribe`) from now on:
 * `hear` gets each notice the environment raises once the subscription is
 * live, and none it raised before, which the catch-up replays. Resolves once
 * it is live; a notice this CLI does not know is passed over. Once per verb.
 */
export type LocalNotices = (hear: (notice: EnvironmentNotice) => void) => Promise<void>;

/** What a verb's work is handed: its calls, and the environment's notices. */
export type LocalWork<T> = (call: LocalCall, notices: LocalNotices) => Promise<T>;

/** The notices a verb follows: the subscribe request's id, the subscription once the environment names it, and whether its catch-up is over. */
interface Following {
  readonly id: string;
  subscription?: string;
  live: boolean;
  readonly hear: (notice: EnvironmentNotice) => void;
  /** Settles the follow: live, or refused with the error. */
  readonly ready: (error?: Error) => void;
}

/** How long the verb waits for the environment at each step: the exchange, the hello, each answer. */
const WIRE_TIMEOUT_MS = 10_000;

/** How the route waits: a test shortens the timeout, and holds its clock to bound only the step it is about. */
export interface LocalSessionOptions {
  /** How long the environment may stay silent while the verb waits on it; preset ten seconds. */
  readonly timeoutMs?: number;
  /** What the timeout runs on, the exchange's and the wire's alike; preset the real clock. */
  readonly clock?: Pick<Clock, "setTimeout">;
}

const readGrant = (dataDir: string): BootstrapGrant => {
  const path = join(dataDir, BOOTSTRAP_GRANT_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new LocalFailure(`No environment is running on ${dataDir}: it has no bootstrap grant file.`);
    }
    throw new LocalFailure(`The bootstrap grant file ${path} could not be read: ${(error as Error).message}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LocalFailure(`The bootstrap grant file ${path} is not one an environment writes.`);
  }
  const grant = BootstrapGrant.safeParse(parsed);
  if (!grant.success) throw new LocalFailure(`The bootstrap grant file ${path} is not one an environment writes.`);
  return grant.data;
};

/** Exchanges the grant's secret for a local `tui` client session under `label`, which the verb revokes itself once its calls are done. */
const exchangeGrant = async (origin: string, secret: string, label: string, net: Net, timeoutMs: number, clock: Pick<Clock, "setTimeout">): Promise<ClientSessionCredential> => {
  // The same bound as the wire phase, so a wedged environment fails the verb in seconds rather than minutes; it
  // covers reading the answer too, and aborts with the error `AbortSignal.timeout` gives.
  const abort = new AbortController();
  const timer = clock.setTimeout(() => abort.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), timeoutMs);
  let response: Response;
  let body: unknown;
  try {
    try {
      response = await net.fetch(`${origin}${BOOTSTRAP_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret, kind: "tui", label }),
        signal: abort.signal,
      });
    } catch (error) {
      throw new LocalFailure(`The environment at ${origin} did not answer: ${(error as Error).message}`, { cause: error });
    }
    body = await response.json().catch(() => undefined);
  } finally {
    timer.cancel();
  }
  if (!response.ok) {
    const refusal = BootstrapError.safeParse(body);
    throw new LocalFailure(`The environment refused the bootstrap exchange: ${refusal.success ? refusal.data.message : `HTTP ${response.status}`}`);
  }
  const credential = ClientSessionCredential.safeParse(body);
  if (!credential.success) throw new LocalFailure(`The environment at ${origin} answered the bootstrap exchange with something that is not a client session.`);
  return credential.data;
};

/** What the verb's work came to: its value, or what it threw. */
type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/**
 * Authenticates on the wire, runs `work` once `hello` arrives, then revokes
 * its own client session, which the environment answers with `bye: revoked`
 * and the close; settles with what `work` came to, a failure included. A
 * refused revoke, a socket closed early and an environment silent for the
 * timeout while the verb waits on it fail the verb. An environment that goes
 * away (`bye: updating` or `draining`) once every call has its answer, but
 * before the work has settled, leaves the work to settle the verb (#1765).
 */
const overWire = <T>(
  url: string,
  credential: ClientSessionCredential,
  net: Net,
  { timeoutMs, clock }: Required<LocalSessionOptions>,
  work: LocalWork<T>,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const ws = new net.WebSocket(url);
    /** The calls awaiting their answer, by request id, each with how long it may wait. */
    const pending = new Map<string, { readonly answer: (frame: ResponseFrame) => void; readonly timeoutMs: number }>();
    let calls = 0;
    let following: Following | undefined;
    let greeted = false;
    let outcome: Outcome<T> | undefined;
    /** What the environment's going-away bye said, heard after every call's answer and before the work settled: no call or notice is answered after it. */
    let goneAway: string | undefined;
    let settled = false;
    let timer: Timer | undefined;

    const settle = (ending: Outcome<T>) => {
      if (settled) return;
      settled = true;
      timer?.cancel();
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1000);
      if (ending.ok) resolve(ending.value);
      else reject(ending.error);
    };
    /** Fails the verb, unless its work failed first: that failure is the one reported. */
    const fail = (message: string) => settle(outcome?.ok === false ? outcome : { ok: false, error: new LocalFailure(message) });
    /**
     * The timeout's one rule, applied after every step: while the verb waits on
     * the environment (the connection and its hello, a call's answer, the
     * notices' catch-up, the revoke and its bye) the wait starts again, and
     * silence for the timeout fails the verb; while only the verb's own work
     * runs, waiting on a notice included, nothing is waited on. A call in
     * flight with a longer wait of its own lengthens it while it is.
     */
    const rearm = () => {
      timer?.cancel();
      const waiting = !greeted || pending.size > 0 || following?.live === false || outcome !== undefined;
      const waitMs = Math.max(timeoutMs, ...[...pending.values()].map((entry) => entry.timeoutMs));
      if (waiting && !settled) timer = clock.setTimeout(() => fail(`The environment at ${url} did not answer within ${waitMs / 1000} seconds.`), waitMs);
    };
    const send = (frame: Parameters<typeof encodeFrame>[0]) => ws.send(encodeFrame(frame));

    const call: LocalCall = (method, params, options = {}) =>
      new Promise((resolveCall, rejectCall) => {
        if (settled || outcome !== undefined) return rejectCall(new LocalFailure(`${method} was called after the verb's work was done.`));
        if (goneAway !== undefined) return rejectCall(new LocalFailure(goneAway));
        const id = `call-${++calls}`;
        const answer = (frame: ResponseFrame) => {
          if (frame.error) return rejectCall(new LocalRefusal(method, frame.error));
          const entry = registry[method];
          const parsed = ("response" in entry ? entry.response : entry.result).safeParse(frame.result);
          if (!parsed.success) return rejectCall(new LocalFailure(`The environment answered ${method} with something that is not its answer.`));
          resolveCall(parsed.data as ResponseOf<typeof method>);
        };
        pending.set(id, { answer, timeoutMs: options.timeoutMs ?? timeoutMs });
        send({ type: "request", id, method, params: params as Record<string, unknown> });
        rearm();
      });

    const notices: LocalNotices = (hear) =>
      new Promise((resolveNotices, rejectNotices) => {
        if (settled || outcome !== undefined) return rejectNotices(new LocalFailure("The notices were asked for after the verb's work was done."));
        if (goneAway !== undefined) return rejectNotices(new LocalFailure(goneAway));
        if (following !== undefined) return rejectNotices(new LocalFailure("The notices are followed once per verb."));
        following = { id: "notices", live: false, hear, ready: (error) => (error === undefined ? resolveNotices() : rejectNotices(error)) };
        // From the start of the log: what catch-up replays is passed over, and the notices after it are heard.
        send({ type: "request", id: following.id, method: "environment.subscribe", params: { afterSequence: 0 } });
        rearm();
      });

    /** A frame of the notices' subscription: catch-up passed over until it is live, then each notice heard while the work runs. */
    const followed = (frame: Extract<Frame, { subscription: string }>) => {
      if (following === undefined || frame.subscription !== following.subscription) return;
      switch (frame.type) {
        case "synchronized":
          following.live = true;
          rearm();
          return following.ready();
        case "event": {
          if (!following.live || outcome !== undefined) return;
          const notice = EnvironmentNotice.safeParse(frame.event);
          return notice.success ? following.hear(notice.data) : undefined;
        }
        case "end":
          return outcome === undefined ? fail(`The environment stopped sending its notices (${frame.reason}).`) : undefined;
        default:
          return;
      }
    };

    /** The work is done: the verb revokes its own client session, and settles with the work's outcome once the environment says so. */
    const finish = (done: Outcome<T>) => {
      if (settled) return;
      // The environment went away already: its socket carries no revoke, and the client session goes unrevoked as at a bye after the work.
      if (goneAway !== undefined) return settle(done);
      outcome = done;
      send({ type: "request", id: "revoke", method: "access.sessions.revoke", params: { commandId: randomUUID(), clientSessionId: credential.clientSessionId } });
      rearm();
    };

    ws.addEventListener("open", () => {
      send({ type: "auth", token: credential.token, protocolVersion: PROTOCOL_VERSION, clientKind: "tui", harnessVersion: HARNESS_VERSION });
      rearm();
    });
    ws.addEventListener("message", (event) => {
      let frame;
      try {
        frame = decodeFrame(String(event.data));
      } catch {
        return fail("The environment sent a frame this CLI cannot read.");
      }
      switch (frame.type) {
        case "hello":
          greeted = true;
          rearm();
          return void Promise.resolve()
            .then(() => work(call, notices))
            .then(
            (value) => finish({ ok: true, value }),
            (error: unknown) => finish({ ok: false, error }),
          );
        case "ping":
          return send({ type: "pong" });
        case "bye": {
          if (outcome !== undefined && frame.reason === "revoked") return settle(outcome);
          // The environment went away after the work was done (an update the work asked for drains at once): the
          // client session goes unrevoked, and the environment revokes a local session an hour after its connection closed.
          const said = `The environment closed the socket (${frame.reason})${frame.message ? `: ${frame.message}` : "."}`;
          if (frame.reason === "updating" || frame.reason === "draining") {
            if (outcome !== undefined) return settle(outcome);
            // The answer that made it go can come in the same read as this bye, ahead of the work hearing it (#1765): with no
            // call or notice left to wait on, the work settles the verb, and a call or notices it asks for from here fail with
            // this bye. Before the hello the work has not run, so the bye fails the verb.
            if (greeted && pending.size === 0 && following === undefined) {
              goneAway = said;
              return rearm();
            }
          }
          return fail(said);
        }
        case "subscribed":
          if (following?.id === frame.id) following.subscription = frame.subscription;
          return;
        case "snapshot":
        case "event":
        case "synchronized":
        case "end":
          return followed(frame);
        case "response": {
          if (following?.id === frame.id && frame.error) {
            const refused = following;
            following = undefined;
            rearm();
            return refused.ready(new LocalRefusal("environment.subscribe", frame.error));
          }
          if (frame.id === "revoke") {
            // Refused as an error, or rejected in its receipt; accepted, the bye that follows settles it.
            const receipt = registry["access.sessions.revoke"].response.safeParse(frame.result).data?.receipt;
            const refusal = frame.error?.message ?? (receipt?.status === "rejected" ? receipt.error.message : undefined);
            return refusal === undefined ? rearm() : fail(`The environment would not revoke this CLI's client session: ${refusal}`);
          }
          const waiting = pending.get(frame.id);
          if (waiting === undefined) return;
          pending.delete(frame.id);
          rearm();
          return waiting.answer(frame);
        }
        default:
          return;
      }
    });
    // After a going-away bye the socket's end tells nothing: the work settles the verb.
    ws.addEventListener("error", () => {
      if (goneAway === undefined) fail(`The environment at ${url} did not answer.`);
    });
    ws.addEventListener("close", () => {
      if (goneAway === undefined) fail("The environment closed the socket before answering.");
    });
    // The connection and its hello are waited on from the start.
    rearm();
  });

/**
 * Runs `work` on the environment whose data directory is `target.dataDir`,
 * as its own OS user: exchanges the bootstrap grant for a local client
 * session labelled `label`, opens the wire, hands `work` its calls and the
 * environment's notices, and revokes that client session, so each run leaves none behind. Rejects with a
 * `LocalFailure` saying plainly why when no environment answers.
 */
export const withLocalSession = async <T>(
  target: LocalTarget,
  net: Net,
  label: string,
  work: LocalWork<T>,
  { timeoutMs = WIRE_TIMEOUT_MS, clock = systemClock }: LocalSessionOptions = {},
): Promise<T> => {
  const grant = readGrant(target.dataDir);
  const hostPort = formatHostPort(grant.address.host, target.port ?? grant.address.port);
  const credential = await exchangeGrant(`http://${hostPort}`, grant.secret, label, net, timeoutMs, clock);
  return overWire(`ws://${hostPort}${WIRE_PATH}`, credential, net, { timeoutMs, clock }, work);
};
