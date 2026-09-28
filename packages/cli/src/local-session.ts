import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BOOTSTRAP_GRANT_FILE,
  BOOTSTRAP_PATH,
  BootstrapError,
  BootstrapGrant,
  ClientSessionCredential,
  PROTOCOL_VERSION,
  WIRE_PATH,
  decodeFrame,
  encodeFrame,
  formatHostPort,
  registry,
  type MethodName,
  type ParamsOf,
  type ResponseFrame,
  type ResponseOf,
  type WireError,
} from "@agent-harness/contracts";
import { HARNESS_VERSION } from "@agent-harness/environment";

/**
 * The route every CLI verb that asks the environment on this machine
 * something takes (`pair`, the `update` verbs): the bootstrap grant in the
 * environment's data directory is exchanged for a local client session, the
 * verb makes its calls on the wire, and the client session is revoked
 * before the verb exits, so no run leaves one behind.
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

/** One call on the wire: the method's response, or a `LocalRefusal` thrown with the environment's error. */
export type LocalCall = <N extends MethodName>(method: N, params: ParamsOf<N>) => Promise<ResponseOf<N>>;

/** How long the verb waits for the environment at each step: the exchange, the hello, each answer. */
const WIRE_TIMEOUT_MS = 10_000;

/** How the route waits: a test shortens the timeout. */
export interface LocalSessionOptions {
  /** How long the environment may stay silent while the verb waits on it; preset ten seconds. */
  readonly timeoutMs?: number;
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
const exchangeGrant = async (origin: string, secret: string, label: string, net: Net, timeoutMs: number): Promise<ClientSessionCredential> => {
  let response: Response;
  try {
    response = await net.fetch(`${origin}${BOOTSTRAP_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, kind: "tui", label }),
      // The same bound as the wire phase, so a wedged environment fails the verb in seconds rather than minutes.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new LocalFailure(`The environment at ${origin} did not answer: ${(error as Error).message}`, { cause: error });
  }
  const body: unknown = await response.json().catch(() => undefined);
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
 * timeout while the verb waits on it fail the verb.
 */
const overWire = <T>(url: string, credential: ClientSessionCredential, net: Net, timeoutMs: number, work: (call: LocalCall) => Promise<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const ws = new net.WebSocket(url);
    /** The calls awaiting their answer, by request id. */
    const pending = new Map<string, (frame: ResponseFrame) => void>();
    let calls = 0;
    let outcome: Outcome<T> | undefined;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (ending: Outcome<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1000);
      if (ending.ok) resolve(ending.value);
      else reject(ending.error);
    };
    /** Fails the verb, unless its work failed first: that failure is the one reported. */
    const fail = (message: string) => settle(outcome?.ok === false ? outcome : { ok: false, error: new LocalFailure(message) });
    /** Waits for the environment's next word, failing the verb after the timeout. */
    const awaitAnswer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(`The environment at ${url} did not answer within ${timeoutMs / 1000} seconds.`), timeoutMs);
    };
    const send = (frame: Parameters<typeof encodeFrame>[0]) => ws.send(encodeFrame(frame));

    const call: LocalCall = (method, params) =>
      new Promise((resolveCall, rejectCall) => {
        if (settled || outcome !== undefined) return rejectCall(new LocalFailure(`${method} was called after the verb's work was done.`));
        const id = `call-${++calls}`;
        pending.set(id, (frame) => {
          if (frame.error) return rejectCall(new LocalRefusal(method, frame.error));
          const entry = registry[method];
          const answer = ("response" in entry ? entry.response : entry.result).safeParse(frame.result);
          if (!answer.success) return rejectCall(new LocalFailure(`The environment answered ${method} with something that is not its answer.`));
          resolveCall(answer.data as ResponseOf<typeof method>);
        });
        send({ type: "request", id, method, params: params as Record<string, unknown> });
        awaitAnswer();
      });

    /** The work is done: the verb revokes its own client session, and settles with the work's outcome once the environment says so. */
    const finish = (done: Outcome<T>) => {
      if (settled) return;
      outcome = done;
      send({ type: "request", id: "revoke", method: "access.sessions.revoke", params: { commandId: randomUUID(), clientSessionId: credential.clientSessionId } });
      awaitAnswer();
    };

    ws.addEventListener("open", () => {
      send({ type: "auth", token: credential.token, protocolVersion: PROTOCOL_VERSION, clientKind: "tui", harnessVersion: HARNESS_VERSION });
      awaitAnswer();
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
          clearTimeout(timer);
          return void Promise.resolve()
            .then(() => work(call))
            .then(
            (value) => finish({ ok: true, value }),
            (error: unknown) => finish({ ok: false, error }),
          );
        case "ping":
          return send({ type: "pong" });
        case "bye": {
          if (outcome !== undefined && frame.reason === "revoked") return settle(outcome);
          return fail(`The environment closed the socket (${frame.reason})${frame.message ? `: ${frame.message}` : "."}`);
        }
        case "response": {
          if (frame.id === "revoke") {
            // Refused as an error, or rejected in its receipt; accepted, the bye that follows settles it.
            const receipt = registry["access.sessions.revoke"].response.safeParse(frame.result).data?.receipt;
            const refusal = frame.error?.message ?? (receipt?.status === "rejected" ? receipt.error.message : undefined);
            return refusal === undefined ? undefined : fail(`The environment would not revoke this CLI's client session: ${refusal}`);
          }
          const waiting = pending.get(frame.id);
          if (waiting === undefined) return;
          pending.delete(frame.id);
          // Another call still in flight keeps the verb waiting on the environment, which may not go silent on it.
          if (pending.size > 0) awaitAnswer();
          else clearTimeout(timer);
          return waiting(frame);
        }
        default:
          return;
      }
    });
    ws.addEventListener("error", () => fail(`The environment at ${url} did not answer.`));
    ws.addEventListener("close", () => fail("The environment closed the socket before answering."));
  });

/**
 * Runs `work` on the environment whose data directory is `target.dataDir`,
 * as its own OS user: exchanges the bootstrap grant for a local client
 * session labelled `label`, opens the wire, hands `work` its calls, and
 * revokes that client session, so each run leaves none behind. Rejects with a
 * `LocalFailure` saying plainly why when no environment answers.
 */
export const withLocalSession = async <T>(
  target: LocalTarget,
  net: Net,
  label: string,
  work: (call: LocalCall) => Promise<T>,
  { timeoutMs = WIRE_TIMEOUT_MS }: LocalSessionOptions = {},
): Promise<T> => {
  const grant = readGrant(target.dataDir);
  const hostPort = formatHostPort(grant.address.host, target.port ?? grant.address.port);
  const credential = await exchangeGrant(`http://${hostPort}`, grant.secret, label, net, timeoutMs);
  return overWire(`ws://${hostPort}${WIRE_PATH}`, credential, net, timeoutMs, work);
};
