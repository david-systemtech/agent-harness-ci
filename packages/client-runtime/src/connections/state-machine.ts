import type { ByeFrame, ByeReason, DiscoveryDocument, Frame, HelloFrame } from "@agent-harness/contracts";
import type { LocalFailureReason } from "../bootstrap.js";
import { admitHello, checkDiscovery, compareProtocol } from "../discovery.js";
import type { NetworkState } from "../platform.js";
import type { BlockedReason, ConnectionKind, ConnectionPhase } from "./records.js";

/**
 * The connection state machine (docs/specs/client-runtime.md, "The connection
 * state machine and reconnect"), one per connection, as a pure function:
 * `reduce(state, input, context)` answers the next state and the effects a
 * runner (`runner.ts`) performs: it owns the socket and the timers on the
 * platform clock, and feeds back what happened as inputs. `now` and the
 * jitter draw come in `context`, so the ladder, the watchdog and the `bye`
 * rules are tested with neither a socket nor a clock.
 *
 * An attempt is: read discovery (after the grant exchange, for a local
 * connection without a token) and check readiness, protocol and the
 * environment id; read the token and open the socket, which sends `auth`;
 * take `hello`, checked for the id and protocol again. Every answer names
 * the attempt it belongs to, and an answer to an attempt that is over is
 * dropped: `attempt` is bumped whenever the machine lets go of one.
 */

/** The backoff ladder's rungs (chosen defaults after T3 Code's ladder); the last one repeats. */
export const BACKOFF_LADDER_MS = [1000, 2000, 4000, 8000, 16_000, 30_000] as const;
/** Each rung is lengthened by up to this fraction of itself. */
export const BACKOFF_JITTER = 0.25;
/** A connection ready this long puts the ladder back to its first rung. */
export const HEALTHY_RESET_MS = 30_000;
/** How long an attempt may take: to answer discovery, and from opening the socket to `hello`. */
export const ESTABLISH_TIMEOUT_MS = 15_000;
/** Silence after the first `ping` for this long is a dead socket (the environment pings every 15 seconds; a measured margin). */
export const WATCHDOG_MS = 45_000;
/** How long a foreground wakeup's probe waits for its answer. A chosen default. */
export const PROBE_TIMEOUT_MS = 5000;
/** How often discovery is polled while it answers `starting`, with no failure counted. */
export const STARTING_POLL_MS = 2000;
/** How long `bye: draining` or `bye: updating` is waited out before polling discovery. */
export const BYE_WAIT_MS = 5000;
/** An update taken across a protocol gap is waited for at most the widest deferral cap, 168 hours. */
export const PROTOCOL_UPDATE_WAIT_MS = 168 * 60 * 60 * 1000;
/** A token with less than this left is refreshed. */
export const REFRESH_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;
/** How often a connected socket checks whether its token is due a refresh. */
export const REFRESH_CHECK_MS = 24 * 60 * 60 * 1000;

/** The timers a connection runs, each at most once. */
export type TimerName = "retry" | "establish" | "watchdog" | "healthy" | "probe" | "refresh" | "update-wait";
const everyTimer = (): readonly TimerName[] => ["retry", "establish", "watchdog", "healthy", "probe", "refresh", "update-wait"];

/** What the machine waits on: nothing, a discovery read, the socket's `hello`, or nothing because the socket is open. */
export type Step = "idle" | "discovery" | "dialing" | "open";

/** What a connection offers David to do about where it is; the renderer maps each to a call. */
export type ConnectionAction = "re-pair" | "update-client" | "update-environment" | "service.start";

/** What the connection has to say to David: blocked, or its token refresh failing. */
export type ConnectionNoticeKind = "revoked" | "expired" | "unsupported-client" | "protocol-mismatch" | "refresh-failed";

export interface NoticeDraft {
  readonly kind: ConnectionNoticeKind;
  readonly message: string;
  readonly action: ConnectionAction | null;
}

export interface MachineState {
  readonly environmentId: string;
  /** The protocol integer this client speaks. */
  readonly protocolVersion: number;
  readonly kind: ConnectionKind;
  /** The environment's name, for notices. */
  readonly name: string;
  /** Whether the environment's flags include `self-update`, as last seen. */
  readonly selfUpdate: boolean;
  readonly phase: ConnectionPhase;
  readonly blocked: BlockedReason | null;
  /** The reason of the last `bye`, until the next `hello`. */
  readonly bye: ByeReason | null;
  readonly step: Step;
  readonly attempt: number;
  /** Failures since the connection was last healthy for `HEALTHY_RESET_MS`: the ladder's rung. */
  readonly failures: number;
  /** When the next attempt is due; null when none is scheduled. */
  readonly retryAt: number | null;
  /** A retry waits for a wakeup because the network is offline. */
  readonly parked: boolean;
  readonly network: NetworkState;
  /** The environment has pinged this socket, so its silence is watched. */
  readonly watching: boolean;
  readonly probing: boolean;
  /** The connection has been ready since the runtime started, so a failure makes it unreachable. */
  readonly wasReady: boolean;
  readonly unreachableSince: number | null;
  /** When the token expires; null when not known. */
  readonly expiresAt: number | null;
  /** Why the last token refresh failed, until one succeeds. */
  readonly refreshFailed: string | null;
  /**
   * The environment took the update `update-environment` asked of it across a
   * protocol gap (`POST /api/update`): the block it was under is kept, and
   * only `hello` agreeing clears it, but the connection shows `updating` and
   * polls discovery through the restart, where a re-check of a block would
   * fall back to `blocked`. This deadline bounds the wait even while offline
   * or discovery never answers; null means no update wait is under way.
   */
  readonly updateDeadline: number | null;
}

export interface MachineConfig {
  readonly environmentId: string;
  readonly protocolVersion: number;
  readonly kind: ConnectionKind;
  readonly name: string;
  /** The block the record was saved with: re-checked on start. */
  readonly blocked: BlockedReason | null;
  /** The environment's flags as last seen. */
  readonly capabilities: readonly string[];
}

export const initialMachine = (config: MachineConfig): MachineState => ({
  environmentId: config.environmentId,
  protocolVersion: config.protocolVersion,
  kind: config.kind,
  name: config.name,
  selfUpdate: config.capabilities.includes("self-update"),
  phase: config.blocked === null ? "disabled" : "blocked",
  blocked: config.blocked,
  bye: null,
  step: "idle",
  attempt: 0,
  failures: 0,
  retryAt: null,
  parked: false,
  network: { online: true, foreground: true },
  watching: false,
  probing: false,
  wasReady: false,
  unreachableSince: null,
  expiresAt: null,
  refreshFailed: null,
  updateDeadline: null,
});

/** What discovery came to: the document, nothing answering, an answer that is not a document, or a failed grant exchange. */
export type DiscoveryAnswer =
  | { readonly kind: "document"; readonly document: DiscoveryDocument }
  | { readonly kind: "unreachable"; readonly message: string }
  | { readonly kind: "malformed"; readonly message: string }
  | { readonly kind: "grant-failed"; readonly reason: LocalFailureReason; readonly message: string };

export type RefreshOutcome = { readonly ok: true; readonly expiresAt: number } | { readonly ok: false; readonly message: string };

export type MachineInput =
  /** The runtime started, or David enabled the connection. `hasCache`: there is cached data it serves while unreachable. */
  | { readonly type: "start"; readonly enabled: boolean; readonly network: NetworkState; readonly hasCache: boolean }
  | { readonly type: "disable" }
  /** The runner handed the socket to the registry (to revoke the client session over it, on removal or a re-pair): let go of everything, quietly. */
  | { readonly type: "release" }
  /** Try at once. `fresh`: the ladder starts over, as after David started the local service. */
  | { readonly type: "retryNow"; readonly fresh?: boolean }
  | { readonly type: "discovery-result"; readonly attempt: number; readonly answer: DiscoveryAnswer }
  /** The connection has no token to send. */
  | { readonly type: "no-token"; readonly attempt: number }
  /** The socket said `hello`; `expiresAt` is its token's expiry as the runner knows it. */
  | { readonly type: "hello"; readonly attempt: number; readonly hello: HelloFrame; readonly expiresAt: number | null }
  /** A socket opened elsewhere (pairing) said `hello` and is the connection's now. */
  | { readonly type: "adopt"; readonly hello: HelloFrame; readonly expiresAt: number | null }
  | { readonly type: "ping"; readonly attempt: number }
  /** The environment took the update asked of it over `POST /api/update`, while the connection was blocked `protocol-mismatch`. */
  | { readonly type: "update-taken" }
  /** The socket closed after a `bye`. */
  | { readonly type: "bye"; readonly attempt: number; readonly bye: ByeFrame }
  /** The socket closed with no `bye`. */
  | { readonly type: "close"; readonly attempt: number }
  | { readonly type: "timer"; readonly timer: TimerName }
  | { readonly type: "network"; readonly network: NetworkState }
  | { readonly type: "probe-result"; readonly attempt: number; readonly ok: boolean }
  | { readonly type: "refresh-result"; readonly attempt: number; readonly result: RefreshOutcome };

export type Effect =
  /** Read discovery at the connection's address; for a local connection without a token, exchange the grant first. */
  | { readonly type: "poll-discovery"; readonly attempt: number }
  /** A discovery document of this environment: keep its name, version and flags on the record. */
  | { readonly type: "describe"; readonly document: DiscoveryDocument }
  /** Read the token and open the socket, which sends `auth`. */
  | { readonly type: "open-socket"; readonly attempt: number }
  /** The socket's `hello` was admitted: fill the record from it and hand its frames to the seams. */
  | { readonly type: "attach" }
  | { readonly type: "send"; readonly frame: Frame }
  /** A request on the open socket; any answer proves it. */
  | { readonly type: "probe"; readonly attempt: number }
  /** Close the socket or abandon its opening. `lost`: an open socket is given up as dead, which the seams hear of. */
  | { readonly type: "close-socket"; readonly lost: boolean }
  | { readonly type: "arm-timer"; readonly timer: TimerName; readonly ms: number }
  | { readonly type: "cancel-timer"; readonly timer: TimerName }
  | { readonly type: "refresh-token"; readonly attempt: number }
  | { readonly type: "clear-token" }
  | { readonly type: "notice"; readonly notice: NoticeDraft };

export interface MachineContext {
  /** Milliseconds since the epoch, on the platform clock. */
  readonly now: number;
  /** A draw in [0, 1) for the backoff's jitter. */
  readonly random: number;
}

export interface Transition {
  readonly state: MachineState;
  readonly effects: readonly Effect[];
}

/** The wait after the `failures`th failure in a row: its rung, lengthened by `random` times the jitter. */
export const backoffDelay = (failures: number, random: number): number => {
  const rung = Math.min(Math.max(failures, 1), BACKOFF_LADDER_MS.length) - 1;
  const base = BACKOFF_LADDER_MS[rung] as number;
  return Math.floor(base * (1 + BACKOFF_JITTER * Math.min(Math.max(random, 0), 1)));
};

/** What the connection offers David where it is: start the local service, re-pair, or update one side. */
export const actionOf = (state: MachineState): ConnectionAction | null => {
  if (state.phase === "service-down" && state.kind === "local") return "service.start";
  if (state.phase !== "blocked") return null;
  switch (state.blocked) {
    case "expired":
      return state.kind === "paired" ? "re-pair" : null;
    case "unsupported-client":
      return "update-client";
    case "protocol-mismatch":
      return state.selfUpdate ? "update-environment" : null;
    default:
      return null;
  }
};

const needsRefresh = (state: MachineState, now: number) => state.expiresAt === null || state.expiresAt - now < REFRESH_WITHIN_MS;

/** Whether a retry waits for a wakeup: offline, for a remote environment. The local one is on loopback, which going offline does not touch. */
const parks = (state: MachineState) => !state.network.online && state.kind !== "local";

/** A phase that says why the environment is not there, kept while discovery is read again. */
const saysWhy = (phase: ConnectionPhase) =>
  phase === "starting" || phase === "draining" || phase === "updating" || phase === "service-down" || phase === "blocked";

export const reduce = (state: MachineState, input: MachineInput, context: MachineContext): Transition => {
  const out: Effect[] = [];
  const { now } = context;

  /** Lets go of the socket, every timer and the attempt in flight. */
  const halt = (s: MachineState, lost = false): MachineState => {
    if (s.step === "dialing" || s.step === "open") out.push({ type: "close-socket", lost: lost && s.step === "open" });
    for (const timer of everyTimer()) out.push({ type: "cancel-timer", timer });
    return { ...s, step: "idle", attempt: s.attempt + 1, retryAt: null, parked: false, watching: false, probing: false };
  };

  const unreachable = (s: MachineState): MachineState => (s.unreachableSince === null && s.wasReady ? { ...s, unreachableSince: now } : s);

  /** Starts an attempt on a halted machine: discovery first. */
  const begin = (s: MachineState): MachineState => {
    out.push({ type: "poll-discovery", attempt: s.attempt }, { type: "arm-timer", timer: "establish", ms: ESTABLISH_TIMEOUT_MS });
    return { ...s, phase: saysWhy(s.phase) ? s.phase : "connecting", step: "discovery" };
  };

  /**
   * Waits `ms` for the next attempt, in `phase`. Offline, a remote
   * connection parks until a wakeup instead; the local one, on loopback,
   * never does.
   */
  const wait = (s: MachineState, phase: ConnectionPhase, ms: number): MachineState => {
    if (parks(s)) return { ...s, phase, parked: true, retryAt: null };
    out.push({ type: "arm-timer", timer: "retry", ms });
    return { ...s, phase, parked: false, retryAt: now + ms };
  };

  /** Whether a failure is a block being re-checked: a block held, and no update taken across the gap to wait out. */
  const rechecking = (s: MachineState): boolean => s.blocked !== null && s.updateDeadline === null;

  /** A re-check of a block that could not finish: back to blocked, quietly, with no retry; only discovery and `hello` agreeing clear it. */
  const reblock = (s: MachineState): MachineState => ({ ...unreachable(halt(s)), phase: "blocked" });

  /** A failure a retry may cure: one more rung of the ladder, waited in `phase`. A block being re-checked stays blocked. */
  const fail = (s: MachineState, phase: ConnectionPhase): MachineState => {
    if (rechecking(s)) return reblock(s);
    const halted = unreachable(halt(s));
    const failures = halted.failures + 1;
    return wait({ ...halted, failures }, phase, backoffDelay(failures, context.random));
  };

  /** Discovery says `starting`: polled every two seconds with no failure counted, the phase `updating` kept through an update's restart. A block being re-checked stays blocked. */
  const starting = (s: MachineState): MachineState => {
    if (rechecking(s)) return reblock(s);
    // An environment starting again after `bye: updating`, or after the update taken across a protocol gap, is still updating.
    return wait(unreachable(halt(s)), s.phase === "updating" ? "updating" : "starting", STARTING_POLL_MS);
  };

  /** A declared dead socket: closed, and replaced at once as a transient failure; if the replacement fails, the ladder starts at its first rung. */
  const lose = (s: MachineState): MachineState => begin({ ...unreachable(halt(s, true)), phase: "connecting", failures: 0 });

  const noticeFor = (s: MachineState, reason: BlockedReason, theirs: number | undefined): NoticeDraft | undefined => {
    const versions = theirs === undefined ? "" : ` ${s.name} speaks protocol ${theirs} and this client ${s.protocolVersion}:`;
    // The local environment is never paired: a retry exchanges its grant for a new client session.
    const way = s.kind === "local" ? "retry to exchange the local grant again" : "pair again to reconnect";
    switch (reason) {
      case "revoked":
        return { kind: "revoked", message: `This client's session on ${s.name} was revoked; ${way}.`, action: null };
      case "expired":
        return {
          kind: "expired",
          message: `This client's session on ${s.name} expired; ${way}.`,
          action: s.kind === "paired" ? "re-pair" : null,
        };
      case "unsupported-client":
        return { kind: "unsupported-client", message: `${s.name} is newer than this client.${versions} update this client.`, action: "update-client" };
      case "protocol-mismatch":
        return s.selfUpdate
          ? {
              kind: "protocol-mismatch",
              message: `${s.name} is older than this client.${versions} update ${s.name} to this client's version.`,
              action: "update-environment",
            }
          : {
              kind: "protocol-mismatch",
              message: `${s.name} is older than this client.${versions} ${s.name} cannot update itself from here; update it on its own machine, or use a client of its version.`,
              action: null,
            };
      case "different-environment":
        return undefined;
    }
  };

  /** Blocks until something changes: no retry. Revoked and expired clear the token; a block new to the record raises a notice. */
  const block = (s: MachineState, reason: BlockedReason, theirs?: number): MachineState => {
    const halted = unreachable(halt(s));
    if (reason === "revoked" || reason === "expired") out.push({ type: "clear-token" });
    const notice = halted.blocked === reason ? undefined : noticeFor(halted, reason, theirs);
    if (notice) out.push({ type: "notice", notice });
    return { ...halted, phase: "blocked", blocked: reason, updateDeadline: null };
  };

  /** Where nothing answering leaves the connection. */
  const unanswered = (s: MachineState): ConnectionPhase => {
    if (s.phase === "updating") return "updating";
    return s.kind === "local" ? "service-down" : "backoff";
  };

  const learn = (s: MachineState, name: string, capabilities: readonly string[]): MachineState => ({
    ...s,
    name,
    selfUpdate: capabilities.includes("self-update"),
  });

  /** A `hello` on the socket this attempt opened (or one adopted): ready, or blocked when it names another environment or protocol. */
  const greet = (s: MachineState, frame: HelloFrame, expiresAt: number | null): MachineState => {
    const refusal = admitHello(frame, s.environmentId, s.protocolVersion);
    if (refusal) {
      const known = frame.environmentId === s.environmentId ? learn(s, frame.environmentName, frame.capabilities) : s;
      return block(known, refusal.reason, frame.protocolVersion);
    }
    out.push(
      { type: "cancel-timer", timer: "establish" },
      { type: "cancel-timer", timer: "update-wait" },
      { type: "attach" },
      { type: "arm-timer", timer: "healthy", ms: HEALTHY_RESET_MS },
      { type: "arm-timer", timer: "refresh", ms: REFRESH_CHECK_MS },
    );
    const ready: MachineState = {
      ...learn(s, frame.environmentName, frame.capabilities),
      phase: "ready",
      step: "open",
      blocked: null,
      updateDeadline: null,
      bye: null,
      retryAt: null,
      parked: false,
      watching: false,
      probing: false,
      wasReady: true,
      unreachableSince: null,
      expiresAt,
    };
    if (needsRefresh(ready, now)) out.push({ type: "refresh-token", attempt: ready.attempt });
    return ready;
  };

  /** A failed grant exchange, in the phases' words. */
  const grantFailed = (s: MachineState, reason: LocalFailureReason): MachineState => {
    switch (reason) {
      case "service-down":
        return fail(s, unanswered(s));
      case "starting":
        return starting(s);
      case "draining":
        return fail(s, s.phase === "updating" ? "updating" : "draining");
      case "unsupported-client":
      case "protocol-mismatch":
        return block(s, reason);
      case "refused":
        return fail(s, "backoff");
    }
  };

  const discovered = (s: MachineState, answer: DiscoveryAnswer): MachineState => {
    switch (answer.kind) {
      case "unreachable":
        return fail(s, unanswered(s));
      case "malformed":
        return fail(s, s.phase === "updating" ? "updating" : "backoff");
      case "grant-failed":
        return grantFailed(s, answer.reason);
      case "document": {
        const { document } = answer;
        let known = s;
        if (document.environmentId === s.environmentId) {
          out.push({ type: "describe", document });
          known = learn(s, document.environmentName, document.capabilities);
        }
        const check = checkDiscovery(document, { protocolVersion: s.protocolVersion, environmentId: s.environmentId });
        if (check.ok) {
          // A block clears only on `hello`: until then a re-check says blocked, so the record never shows a reason beside another phase.
          out.push({ type: "open-socket", attempt: known.attempt }, { type: "arm-timer", timer: "establish", ms: ESTABLISH_TIMEOUT_MS });
          const phase = known.updateDeadline !== null ? "updating" : known.blocked === null ? "connecting" : "blocked";
          return { ...known, phase, step: "dialing" };
        }
        switch (check.reason) {
          case "starting":
            return starting(known);
          case "draining":
            return fail(known, known.phase === "updating" ? "updating" : "draining");
          case "protocol-mismatch":
            // The old environment still answers: the update it took waits for idle, or for the restart it will bring.
            if (known.updateDeadline !== null) return wait(unreachable(halt(known)), "updating", BYE_WAIT_MS);
            return block(known, check.reason, document.protocolVersion);
          default:
            return block(known, check.reason, document.protocolVersion);
        }
      }
    }
  };

  const byeSaid = (s: MachineState, frame: ByeFrame): MachineState => {
    const said = { ...s, bye: frame.reason };
    switch (frame.reason) {
      case "revoked":
      case "unauthorized":
        return block(said, "revoked");
      case "expired":
        return block(said, "expired");
      case "protocol": {
        const theirs = frame.protocolVersion;
        if (theirs === undefined) return block(said, "protocol-mismatch");
        // The same version on both sides is no version gap: a fault on the environment's side, retried on the ladder.
        const gap = compareProtocol(theirs, s.protocolVersion);
        return gap ? block(said, gap.reason, theirs) : fail(said, "backoff");
      }
      case "draining":
      case "updating":
        return rechecking(s) ? reblock(said) : wait(unreachable(halt(said)), frame.reason, BYE_WAIT_MS);
    }
  };

  const fired = (s: MachineState, timer: TimerName): MachineState => {
    switch (timer) {
      case "update-wait":
        return s.updateDeadline !== null && now >= s.updateDeadline ? block(s, "protocol-mismatch") : s;
      case "retry":
        return s.step === "idle" && s.phase !== "disabled" ? begin(halt(s)) : s;
      case "establish":
        // A discovery read that never answers is nothing answering, phased like an unreachable one; a socket that never says `hello` is a fault on the ladder.
        if (s.step === "discovery") return fail(s, unanswered(s));
        if (s.step === "dialing") return fail(s, s.phase === "updating" ? "updating" : "backoff");
        return s;
      case "watchdog":
        return s.step === "open" ? lose(s) : s;
      case "probe":
        return s.step === "open" && s.probing ? lose(s) : s;
      case "healthy":
        return s.step === "open" ? { ...s, failures: 0 } : s;
      case "refresh":
        if (s.step !== "open") return s;
        if (needsRefresh(s, now)) out.push({ type: "refresh-token", attempt: s.attempt });
        out.push({ type: "arm-timer", timer: "refresh", ms: REFRESH_CHECK_MS });
        return s;
    }
  };

  const live = (attempt: number, ...steps: Step[]) => attempt === state.attempt && steps.includes(state.step);

  const next = ((): MachineState => {
    switch (input.type) {
      case "start": {
        const halted = { ...halt(state), network: input.network, unreachableSince: input.hasCache ? now : null };
        if (!input.enabled) return { ...halted, phase: "disabled", unreachableSince: null };
        if (parks(halted)) return { ...halted, phase: halted.blocked === null ? "backoff" : "blocked", parked: true };
        return begin(halted);
      }
      case "disable":
        return { ...halt(state), phase: "disabled", failures: 0, unreachableSince: null, updateDeadline: null };
      case "release":
        return { ...halt(state), phase: state.blocked === null ? "connecting" : "blocked", updateDeadline: null };
      case "retryNow": {
        if (state.phase === "disabled") return state;
        // David asking to try again gives up waiting on the update taken: the block is re-checked as it was.
        const asked = state.updateDeadline !== null ? { ...state, updateDeadline: null, phase: "blocked" as const } : state;
        return begin(halt(input.fresh ? { ...asked, failures: 0 } : asked));
      }
      case "update-taken":
        if (state.phase !== "blocked" || state.blocked !== "protocol-mismatch") return state;
        return wait(unreachable(halt({ ...state, updateDeadline: now + PROTOCOL_UPDATE_WAIT_MS, failures: 0 })), "updating", BYE_WAIT_MS);
      case "discovery-result":
        return live(input.attempt, "discovery") ? discovered(state, input.answer) : state;
      case "no-token":
        return live(input.attempt, "dialing") ? block(state, "revoked") : state;
      case "hello":
        return live(input.attempt, "dialing") ? greet(state, input.hello, input.expiresAt) : state;
      case "adopt":
        return greet(halt(state), input.hello, input.expiresAt);
      case "ping":
        if (!live(input.attempt, "open")) return state;
        out.push({ type: "send", frame: { type: "pong" } }, { type: "arm-timer", timer: "watchdog", ms: WATCHDOG_MS });
        return state.watching ? state : { ...state, watching: true };
      case "bye":
        return live(input.attempt, "dialing", "open") ? byeSaid(state, input.bye) : state;
      case "close":
        return live(input.attempt, "dialing", "open") ? fail({ ...state, bye: null }, "backoff") : state;
      case "timer":
        return fired(state, input.timer);
      case "network": {
        const was = state.network;
        const network = input.network;
        // Nothing moved: the same state, so the runner publishes nothing.
        if (network.online === was.online && network.foreground === was.foreground) return state;
        const s = { ...state, network };
        if (state.phase === "disabled") return s;
        if (!network.online) {
          if (s.retryAt === null || !parks(s)) return s;
          out.push({ type: "cancel-timer", timer: "retry" });
          return { ...s, retryAt: null, parked: true };
        }
        const foregrounded = network.foreground && !was.foreground;
        if (!was.online || foregrounded) {
          if (s.parked) {
            // A parked wait after `bye: draining` or `updating`, or a parked `starting` poll, is waited out again from now, never cut
            // short (the timer was cancelled when it parked); only a ladder retry (`backoff`, `service-down`) or a block's re-check begins at once.
            if (s.phase === "starting") return wait(s, "starting", STARTING_POLL_MS);
            if (s.phase === "draining" || s.phase === "updating") return wait(s, s.phase, BYE_WAIT_MS);
            return begin(halt(s));
          }
          if (s.step === "open" && foregrounded && !s.probing) {
            out.push({ type: "probe", attempt: s.attempt }, { type: "arm-timer", timer: "probe", ms: PROBE_TIMEOUT_MS });
            return { ...s, probing: true };
          }
          // A retry waiting out the ladder is tried at once; the five seconds after `bye: draining` or `updating`, and the `starting` polls, are not cut short.
          if ((s.phase === "backoff" || s.phase === "service-down") && s.retryAt !== null) return begin(halt(s));
        }
        return s;
      }
      case "probe-result":
        if (!live(input.attempt, "open") || !state.probing) return state;
        if (!input.ok) return lose(state);
        out.push({ type: "cancel-timer", timer: "probe" });
        return { ...state, probing: false };
      case "refresh-result": {
        if (!live(input.attempt, "open")) return state;
        const { result } = input;
        if (result.ok) return { ...state, expiresAt: result.expiresAt, refreshFailed: null };
        if (state.refreshFailed === null) {
          out.push({
            type: "notice",
            notice: {
              kind: "refresh-failed",
              message: `Refreshing this client's session on ${state.name} failed (${result.message}); the connection stays up and it is tried again daily.`,
              action: null,
            },
          });
        }
        return { ...state, refreshFailed: result.message };
      }
    }
  })();
  // `halt` cancels every timer as an attempt ends. Re-arm this wait for the
  // time left, so polling, a hanging attempt or going offline cannot renew it.
  if (next.updateDeadline !== null) out.push({ type: "arm-timer", timer: "update-wait", ms: Math.max(0, next.updateDeadline - now) });
  return { state: next, effects: out };
};
