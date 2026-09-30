import { Ceiling, type ByeFrame, type DiscoveryDocument, type HelloFrame } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import {
  BACKOFF_LADDER_MS,
  BYE_WAIT_MS,
  ESTABLISH_TIMEOUT_MS,
  HEALTHY_RESET_MS,
  PROBE_TIMEOUT_MS,
  REFRESH_CHECK_MS,
  REFRESH_WITHIN_MS,
  STARTING_POLL_MS,
  WATCHDOG_MS,
  actionOf,
  backoffDelay,
  initialMachine,
  reduce,
  type DiscoveryAnswer,
  type Effect,
  type MachineInput,
  type MachineState,
} from "./state-machine.js";

/**
 * The connection state machine as a pure function (docs/specs/client-runtime.md,
 * "The connection state machine and reconnect"): inputs in, a state and the
 * effects a runner performs out. No socket, no timer: `now` and the jitter
 * draw are given with each input.
 */

const ID = "0192f1d2-3c4b-7a5e-8f60-718293a4b5c6";
const OTHER = "0192f1d2-3c4b-7a5e-8f60-000000000000";
const DAY = 24 * 60 * 60 * 1000;
/** The client's protocol integer here: any, so the environment can be on either side of it. */
const CLIENT = 3;

const document = (overrides: Partial<DiscoveryDocument> = {}): DiscoveryDocument => ({
  environmentId: ID,
  environmentName: "desk",
  harnessVersion: "1.0.0",
  protocolVersion: CLIENT,
  capabilities: [],
  authPolicy: "tailnet",
  readiness: "ready",
  ...overrides,
});

const hello = (overrides: Partial<HelloFrame> = {}): HelloFrame => ({
  type: "hello",
  protocolVersion: CLIENT,
  capabilities: [],
  environmentId: ID,
  environmentName: "desk",
  clientSessionId: "client-session-1",
  scopes: ["read"],
  ceiling: Ceiling.parse("bypassPermissions"),
  serverTime: new Date(0).toISOString(),
  ...overrides,
});

const bye = (reason: ByeFrame["reason"], fields: Partial<ByeFrame> = {}): ByeFrame => ({ type: "bye", reason, ...fields });

/** Feeds a machine inputs at a time the test moves, keeping the last transition's effects. */
const drive = (options: { kind?: "local" | "paired"; blocked?: MachineState["blocked"]; capabilities?: readonly string[]; expiresAt?: number | null } = {}) => {
  let state = initialMachine({
    environmentId: ID,
    protocolVersion: CLIENT,
    kind: options.kind ?? "paired",
    name: "desk",
    blocked: options.blocked ?? null,
    capabilities: options.capabilities ?? [],
  });
  let effects: readonly Effect[] = [];
  let now = 0;
  const d = {
    get state() {
      return state;
    },
    get effects() {
      return effects;
    },
    get now() {
      return now;
    },
    at(ms: number) {
      now = ms;
      return d;
    },
    feed(input: MachineInput, random = 0.5) {
      const next = reduce(state, input, { now, random });
      state = next.state;
      effects = next.effects;
      return d;
    },
    start(network = { online: true, foreground: true }, hasCache = false) {
      return d.feed({ type: "start", enabled: true, network, hasCache });
    },
    discovered(answer: DiscoveryAnswer, random = 0.5) {
      return d.feed({ type: "discovery-result", attempt: state.attempt, answer }, random);
    },
    /** From wherever the machine is: discovery answers ready, the socket opens, `hello` comes. */
    connect(expiresAt: number | null = options.expiresAt === undefined ? now + 30 * DAY : options.expiresAt) {
      d.discovered({ kind: "document", document: document() });
      return d.feed({ type: "hello", attempt: state.attempt, hello: hello(), expiresAt });
    },
    ready() {
      return d.start().connect();
    },
  };
  return d;
};

const armed = (effects: readonly Effect[], timer: string) =>
  effects.flatMap((e) => (e.type === "arm-timer" && e.timer === timer ? [e.ms] : []));
const has = (effects: readonly Effect[], type: Effect["type"]) => effects.some((e) => e.type === type);
const notices = (effects: readonly Effect[]) => effects.flatMap((e) => (e.type === "notice" ? [e.notice] : []));

describe("the backoff ladder", () => {
  it("lengthens each rung by the draw's share of 25 percent", () => {
    expect(backoffDelay(1, 0.5)).toBe(1125);
    expect(backoffDelay(3, 0.5)).toBe(4500);
    expect(backoffDelay(6, 1)).toBe(37_500);
  });

  it("is 1, 2, 4, 8, 16 then 30 seconds, each with up to 25 percent jitter", () => {
    const expected = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000];
    expect(BACKOFF_LADDER_MS).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
    expected.forEach((base, i) => {
      for (const random of [0, 0.25, 0.5, 0.999999]) {
        const delay = backoffDelay(i + 1, random);
        expect(delay).toBeGreaterThanOrEqual(base);
        expect(delay).toBeLessThanOrEqual(base * 1.25);
      }
      expect(backoffDelay(i + 1, 0)).toBe(base);
    });
  });

  it("waits each rung after each failure, in the jitter's bounds, and parks nothing while online", () => {
    const d = drive().ready();
    d.feed({ type: "close", attempt: d.state.attempt }, 0.9);
    const delays: number[] = [];
    for (let failure = 0; failure < 7; failure++) {
      expect(d.state.phase).toBe("backoff");
      const [delay] = armed(d.effects, "retry");
      if (delay === undefined) throw new Error("no retry armed");
      delays.push(delay);
      expect(d.state.retryAt).toBe(d.now + delay);
      d.at(d.now + delay).feed({ type: "timer", timer: "retry" });
      expect(d.state.phase).toBe("connecting");
      expect(d.effects).toContainEqual({ type: "poll-discovery", attempt: d.state.attempt });
      d.discovered({ kind: "unreachable", message: "nothing answered" });
    }
    const bases = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    delays.forEach((delay, i) => {
      expect(delay).toBeGreaterThanOrEqual(bases[i] as number);
      expect(delay).toBeLessThanOrEqual((bases[i] as number) * 1.25);
    });
  });

  it("resets after 30 seconds healthy, and not before", () => {
    const d = drive().ready();
    d.feed({ type: "close", attempt: d.state.attempt }, 0);
    d.at(d.now + 1000).feed({ type: "timer", timer: "retry" }).connect();
    expect(armed(d.effects, "healthy")).toEqual([HEALTHY_RESET_MS]);

    // Dropped again before 30 seconds: the ladder goes on.
    d.feed({ type: "close", attempt: d.state.attempt }, 0);
    expect(armed(d.effects, "retry")).toEqual([2000]);

    d.at(d.now + 2000).feed({ type: "timer", timer: "retry" }).connect();
    d.at(d.now + HEALTHY_RESET_MS).feed({ type: "timer", timer: "healthy" });
    d.feed({ type: "close", attempt: d.state.attempt }, 0);
    expect(armed(d.effects, "retry")).toEqual([1000]);
  });
});

describe("an attempt", () => {
  it("reads discovery, then opens the socket; a 15-second establishment timeout runs from opening it to hello", () => {
    const d = drive().start();
    expect(d.state.phase).toBe("connecting");
    expect(d.effects).toContainEqual({ type: "poll-discovery", attempt: d.state.attempt });

    d.discovered({ kind: "document", document: document() });
    expect(d.effects).toContainEqual({ type: "open-socket", attempt: d.state.attempt });
    expect(armed(d.effects, "establish")).toEqual([ESTABLISH_TIMEOUT_MS]);

    d.at(ESTABLISH_TIMEOUT_MS).feed({ type: "timer", timer: "establish" }, 0);
    expect(d.effects).toContainEqual({ type: "close-socket", lost: false });
    expect(d.state).toMatchObject({ phase: "backoff", retryAt: ESTABLISH_TIMEOUT_MS + 1000 });
  });

  it("is ready on hello alone: the socket and hello are good, and the record is filled", () => {
    const d = drive().start().connect();
    expect(d.state).toMatchObject({ phase: "ready", blocked: null, retryAt: null });
    expect(d.effects).toContainEqual({ type: "attach" });
    expect(d.effects).toContainEqual({ type: "cancel-timer", timer: "establish" });
  });

  it("drops an answer to an attempt that is over", () => {
    const d = drive().start();
    const stale = d.state.attempt;
    d.feed({ type: "retryNow" });
    const before = d.state;
    d.feed({ type: "discovery-result", attempt: stale, answer: { kind: "document", document: document() } });
    expect(d.state).toBe(before);
    expect(d.effects).toEqual([]);
  });

  it("blocks different-environment on a hello naming another environment, and closes the socket", () => {
    const d = drive().start();
    d.discovered({ kind: "document", document: document() });
    d.feed({ type: "hello", attempt: d.state.attempt, hello: hello({ environmentId: OTHER, environmentName: "impostor" }), expiresAt: null });
    expect(d.state).toMatchObject({ phase: "blocked", blocked: "different-environment", name: "desk" });
    expect(d.effects).toContainEqual({ type: "close-socket", lost: false });
    expect(has(d.effects, "attach")).toBe(false);
  });

  it("blocks different-environment on discovery naming another environment, before any token is sent", () => {
    const d = drive().start();
    d.discovered({ kind: "document", document: document({ environmentId: OTHER }) });
    expect(d.state).toMatchObject({ phase: "blocked", blocked: "different-environment" });
    expect(has(d.effects, "open-socket")).toBe(false);
    expect(has(d.effects, "describe")).toBe(false);
  });

  it("blocks revoked when there is no token to send", () => {
    const d = drive().start();
    d.discovered({ kind: "document", document: document() });
    d.feed({ type: "no-token", attempt: d.state.attempt });
    expect(d.state).toMatchObject({ phase: "blocked", blocked: "revoked" });
  });
});

describe("the watchdog", () => {
  it("answers ping with pong and arms 45 seconds only after the first ping", () => {
    const d = drive().ready();
    expect(armed(d.effects, "watchdog")).toEqual([]);
    d.feed({ type: "ping", attempt: d.state.attempt });
    expect(d.effects).toContainEqual({ type: "send", frame: { type: "pong" } });
    expect(armed(d.effects, "watchdog")).toEqual([WATCHDOG_MS]);
    d.feed({ type: "ping", attempt: d.state.attempt });
    expect(armed(d.effects, "watchdog")).toEqual([WATCHDOG_MS]);
  });

  it("on expiry closes the socket and reconnects at once, as a transient failure", () => {
    const d = drive().ready();
    d.feed({ type: "ping", attempt: d.state.attempt });
    d.at(WATCHDOG_MS).feed({ type: "timer", timer: "watchdog" });
    expect(d.effects).toContainEqual({ type: "close-socket", lost: true });
    expect(d.effects).toContainEqual({ type: "poll-discovery", attempt: d.state.attempt });
    expect(armed(d.effects, "retry")).toEqual([]);
    expect(d.state).toMatchObject({ phase: "connecting", unreachableSince: WATCHDOG_MS });

    // The reconnect failing starts the ladder at its first rung.
    d.discovered({ kind: "unreachable", message: "gone" });
    expect(armed(d.effects, "retry")).toEqual([backoffDelay(1, 0.5)]);
  });

  it("a failed probe's reconnect starts the ladder at its first rung, even inside 30 seconds of a failure", () => {
    const d = drive().ready();
    d.feed({ type: "close", attempt: d.state.attempt });
    d.feed({ type: "timer", timer: "retry" }).connect();
    expect(d.state.failures).toBe(1);
    d.feed({ type: "network", network: { online: true, foreground: false } });
    d.feed({ type: "network", network: { online: true, foreground: true } });
    d.feed({ type: "probe-result", attempt: d.state.attempt, ok: false });
    d.discovered({ kind: "unreachable", message: "gone" }, 0);
    expect(armed(d.effects, "retry")).toEqual([1000]);
  });
});

describe("bye", () => {
  it.each([
    ["revoked", "revoked"],
    ["unauthorized", "revoked"],
    ["expired", "expired"],
  ] as const)("%s blocks as %s, clears the token and raises a notice", (reason, blocked) => {
    const d = drive().ready();
    d.feed({ type: "bye", attempt: d.state.attempt, bye: bye(reason) });
    expect(d.state).toMatchObject({ phase: "blocked", blocked, bye: reason, retryAt: null });
    expect(d.effects).toContainEqual({ type: "clear-token" });
    expect(notices(d.effects)).toEqual([expect.objectContaining({ kind: blocked, message: expect.stringContaining("desk") })]);
    expect(armed(d.effects, "retry")).toEqual([]);
  });

  it("expired offers re-pair, on the notice and as the connection's action; revoked offers nothing", () => {
    const expired = drive().ready();
    expired.feed({ type: "bye", attempt: expired.state.attempt, bye: bye("expired") });
    expect(notices(expired.effects)[0]?.action).toBe("re-pair");
    expect(actionOf(expired.state)).toBe("re-pair");

    const revoked = drive().ready();
    revoked.feed({ type: "bye", attempt: revoked.state.attempt, bye: bye("revoked") });
    expect(notices(revoked.effects)[0]?.action).toBeNull();
    expect(actionOf(revoked.state)).toBeNull();

    // The local environment is never paired: its way back is the grant, on retryNow.
    const local = drive({ kind: "local" }).ready();
    local.feed({ type: "bye", attempt: local.state.attempt, bye: bye("expired") });
    expect(actionOf(local.state)).toBeNull();
    expect(notices(local.effects)[0]?.message).toContain("exchange the local grant again");
    expect(notices(local.effects)[0]?.message).not.toContain("pair again");
  });

  it("protocol naming the client's own version is a fault, retried on the ladder, not a version block", () => {
    const d = drive().ready();
    d.feed({ type: "bye", attempt: d.state.attempt, bye: bye("protocol", { protocolVersion: CLIENT }) }, 0);
    expect(d.state).toMatchObject({ phase: "backoff", blocked: null, bye: "protocol" });
    expect(armed(d.effects, "retry")).toEqual([1000]);
    expect(notices(d.effects)).toEqual([]);
  });

  it.each([
    [CLIENT + 1, "unsupported-client"],
    [CLIENT - 1, "protocol-mismatch"],
    [undefined, "protocol-mismatch"],
  ] as const)("protocol with the environment on %s blocks as %s", (theirs, blocked) => {
    const d = drive().ready();
    d.feed({ type: "bye", attempt: d.state.attempt, bye: bye("protocol", theirs === undefined ? {} : { protocolVersion: theirs }) });
    expect(d.state).toMatchObject({ phase: "blocked", blocked });
    expect(has(d.effects, "clear-token")).toBe(false);
    expect(notices(d.effects)).toEqual([expect.objectContaining({ kind: blocked })]);
  });

  it.each(["draining", "updating"] as const)(
    "%s waits five seconds, then follows the ladder while polling discovery for ready",
    (reason) => {
      const d = drive().ready();
      d.at(100).feed({ type: "bye", attempt: d.state.attempt, bye: bye(reason) }, 0);
      expect(d.state).toMatchObject({ phase: reason, retryAt: 100 + BYE_WAIT_MS, unreachableSince: 100 });
      expect(armed(d.effects, "retry")).toEqual([BYE_WAIT_MS]);
      expect(has(d.effects, "clear-token")).toBe(false);
      expect(notices(d.effects)).toEqual([]);

      d.at(d.state.retryAt as number).feed({ type: "timer", timer: "retry" });
      expect(d.state.phase).toBe(reason);
      expect(d.effects).toContainEqual({ type: "poll-discovery", attempt: d.state.attempt });
      d.discovered({ kind: "document", document: document({ readiness: "draining" }) });
      expect(d.state.phase).toBe(reason);
      expect(armed(d.effects, "retry")).toEqual([backoffDelay(1, 0.5)]);

      d.at(d.state.retryAt as number).feed({ type: "timer", timer: "retry" });
      // Updating restarts the environment, so nothing answering is part of it; a draining one still answers.
      d.discovered(reason === "updating" ? { kind: "unreachable", message: "restarting" } : { kind: "document", document: document({ readiness: "draining" }) });
      expect(d.state.phase).toBe(reason);
      expect(armed(d.effects, "retry")).toEqual([backoffDelay(2, 0.5)]);

      d.at(d.state.retryAt as number).feed({ type: "timer", timer: "retry" });
      const flags = document({ capabilities: ["self-update"], harnessVersion: "1.1.0" });
      d.discovered({ kind: "document", document: flags });
      expect(d.effects).toContainEqual({ type: "describe", document: flags });
      d.feed({ type: "hello", attempt: d.state.attempt, hello: hello({ capabilities: ["self-update"] }), expiresAt: null });
      expect(d.state).toMatchObject({ phase: "ready", bye: null, unreachableSince: null });
      expect(d.effects).toContainEqual({ type: "attach" });
    },
  );

  it("after draining, nothing answering is the local service down, or a paired environment gone", () => {
    const local = drive({ kind: "local" }).ready();
    local.feed({ type: "bye", attempt: local.state.attempt, bye: bye("draining") });
    local.at(BYE_WAIT_MS).feed({ type: "timer", timer: "retry" });
    local.discovered({ kind: "unreachable", message: "refused" });
    expect(local.state.phase).toBe("service-down");
    expect(actionOf(local.state)).toBe("service.start");

    const paired = drive().ready();
    paired.feed({ type: "bye", attempt: paired.state.attempt, bye: bye("draining") });
    paired.at(BYE_WAIT_MS).feed({ type: "timer", timer: "retry" });
    paired.discovered({ kind: "unreachable", message: "refused" });
    expect(paired.state.phase).toBe("backoff");
  });

  it("a discovery read that hangs is nothing answering: after draining the local service is down or the paired environment gone, after updating it is still updating, while starting the local service is down", () => {
    const hung = (d: ReturnType<typeof drive>) => d.at(d.now + ESTABLISH_TIMEOUT_MS).feed({ type: "timer", timer: "establish" });

    const local = drive({ kind: "local" }).ready();
    local.feed({ type: "bye", attempt: local.state.attempt, bye: bye("draining") });
    local.at(BYE_WAIT_MS).feed({ type: "timer", timer: "retry" });
    expect(local.state).toMatchObject({ phase: "draining", step: "discovery" });
    hung(local);
    expect(local.state).toMatchObject({ phase: "service-down", step: "idle" });
    expect(actionOf(local.state)).toBe("service.start");

    const paired = drive().ready();
    paired.feed({ type: "bye", attempt: paired.state.attempt, bye: bye("draining") });
    paired.at(BYE_WAIT_MS).feed({ type: "timer", timer: "retry" });
    hung(paired);
    expect(paired.state).toMatchObject({ phase: "backoff", step: "idle" });

    const updating = drive().ready();
    updating.feed({ type: "bye", attempt: updating.state.attempt, bye: bye("updating") });
    updating.at(BYE_WAIT_MS).feed({ type: "timer", timer: "retry" });
    hung(updating);
    expect(updating.state).toMatchObject({ phase: "updating", step: "idle" });

    const starting = drive({ kind: "local" }).start();
    starting.discovered({ kind: "document", document: document({ readiness: "starting" }) });
    starting.at(STARTING_POLL_MS).feed({ type: "timer", timer: "retry" });
    expect(starting.state).toMatchObject({ phase: "starting", step: "discovery" });
    hung(starting);
    expect(starting.state).toMatchObject({ phase: "service-down", step: "idle" });
    expect(actionOf(starting.state)).toBe("service.start");

    // A socket that opened and never said hello is a fault on the ladder, whatever came before.
    const dialing = drive().ready();
    dialing.feed({ type: "bye", attempt: dialing.state.attempt, bye: bye("draining") });
    dialing.at(BYE_WAIT_MS).feed({ type: "timer", timer: "retry" });
    dialing.discovered({ kind: "document", document: document() });
    expect(dialing.state.step).toBe("dialing");
    hung(dialing);
    expect(dialing.state).toMatchObject({ phase: "backoff", step: "idle" });
  });
});

describe("the protocol integer", () => {
  it("on discovery: the environment newer blocks unsupported-client, offering to update this client", () => {
    const d = drive().start();
    d.discovered({ kind: "document", document: document({ protocolVersion: CLIENT + 1 }) });
    expect(d.state).toMatchObject({ phase: "blocked", blocked: "unsupported-client" });
    expect(has(d.effects, "open-socket")).toBe(false);
    expect(notices(d.effects)).toEqual([
      expect.objectContaining({ kind: "unsupported-client", action: "update-client", message: expect.stringContaining("update this client") }),
    ]);
    expect(actionOf(d.state)).toBe("update-client");
  });

  it("on discovery: the environment older blocks protocol-mismatch, offering to update it only when it can update itself", () => {
    const older = CLIENT - 1;
    const plain = drive({ capabilities: [] }).start();
    plain.discovered({ kind: "document", document: document({ protocolVersion: older }) });
    expect(plain.state).toMatchObject({ phase: "blocked", blocked: "protocol-mismatch" });
    expect(notices(plain.effects)).toEqual([
      expect.objectContaining({ kind: "protocol-mismatch", action: null, message: expect.stringContaining("cannot update itself") }),
    ]);
    expect(notices(plain.effects)[0]?.message).not.toContain("update desk to");
    expect(actionOf(plain.state)).toBeNull();

    const selfUpdating = drive().start();
    selfUpdating.discovered({ kind: "document", document: document({ protocolVersion: older, capabilities: ["self-update"] }) });
    expect(notices(selfUpdating.effects)).toEqual([
      expect.objectContaining({ action: "update-environment", message: expect.stringContaining("update desk to this client's version") }),
    ]);
    expect(actionOf(selfUpdating.state)).toBe("update-environment");
  });

  it("on hello, both ways", () => {
    const newer = drive().start();
    newer.discovered({ kind: "document", document: document() });
    newer.feed({ type: "hello", attempt: newer.state.attempt, hello: hello({ protocolVersion: CLIENT + 1 }), expiresAt: null });
    expect(newer.state).toMatchObject({ phase: "blocked", blocked: "unsupported-client" });
    expect(newer.effects).toContainEqual({ type: "close-socket", lost: false });

    const older = drive().start();
    older.discovered({ kind: "document", document: document() });
    older.feed({ type: "hello", attempt: older.state.attempt, hello: hello({ protocolVersion: CLIENT - 1 }), expiresAt: null });
    expect(older.state).toMatchObject({ phase: "blocked", blocked: "protocol-mismatch" });
  });

  it("keeps the block, re-checks it on start and on retryNow, and clears it when the versions match again", () => {
    const d = drive({ blocked: "unsupported-client" });
    expect(d.state.phase).toBe("blocked");
    d.start();
    // Re-checking says blocked until discovery says otherwise.
    expect(d.state).toMatchObject({ phase: "blocked", blocked: "unsupported-client" });
    expect(d.effects).toContainEqual({ type: "poll-discovery", attempt: d.state.attempt });
    d.discovered({ kind: "document", document: document({ protocolVersion: CLIENT + 1 }) });
    expect(d.state).toMatchObject({ phase: "blocked", blocked: "unsupported-client" });
    // The same block again raises no second notice.
    expect(notices(d.effects)).toEqual([]);
    expect(armed(d.effects, "retry")).toEqual([]);

    d.feed({ type: "retryNow" });
    d.discovered({ kind: "document", document: document() });
    // Discovery agreeing is not enough: the block holds until `hello` agrees too.
    expect(d.state).toMatchObject({ phase: "blocked", blocked: "unsupported-client", step: "dialing" });
    expect(d.effects).toContainEqual({ type: "open-socket", attempt: d.state.attempt });
    d.feed({ type: "hello", attempt: d.state.attempt, hello: hello(), expiresAt: null });
    expect(d.state).toMatchObject({ phase: "ready", blocked: null });
  });

  it.each([
    ["nothing answers", (d: ReturnType<typeof drive>) => d.discovered({ kind: "unreachable", message: "refused" })],
    ["discovery is not a document", (d: ReturnType<typeof drive>) => d.discovered({ kind: "malformed", message: "HTTP 502" })],
    ["discovery says starting", (d: ReturnType<typeof drive>) => d.discovered({ kind: "document", document: document({ readiness: "starting" }) })],
    ["discovery says draining", (d: ReturnType<typeof drive>) => d.discovered({ kind: "document", document: document({ readiness: "draining" }) })],
    ["discovery never answers", (d: ReturnType<typeof drive>) => d.at(ESTABLISH_TIMEOUT_MS).feed({ type: "timer", timer: "establish" })],
    [
      "the socket closes before hello",
      (d: ReturnType<typeof drive>) => {
        d.discovered({ kind: "document", document: document() });
        d.feed({ type: "close", attempt: d.state.attempt });
      },
    ],
  ] as const)("a saved block whose re-check cannot finish (%s) stays blocked, quietly, with no retry and its action", (_, recheck) => {
    const d = drive({ blocked: "unsupported-client" }).start();
    recheck(d);
    expect(d.state).toMatchObject({ phase: "blocked", blocked: "unsupported-client", retryAt: null, step: "idle" });
    expect(armed(d.effects, "retry")).toEqual([]);
    expect(notices(d.effects)).toEqual([]);
    expect(actionOf(d.state)).toBe("update-client");
  });

  it("a saved revoked block stays blocked when its re-check cannot reach the environment", () => {
    const d = drive({ blocked: "revoked" }).start();
    d.discovered({ kind: "unreachable", message: "refused" });
    expect(d.state).toMatchObject({ phase: "blocked", blocked: "revoked", retryAt: null });
  });
});

describe("the network signal", () => {
  it("offline parks a pending retry instead of spending attempts; a wakeup tries at once", () => {
    const d = drive().ready();
    d.feed({ type: "close", attempt: d.state.attempt });
    expect(d.state.retryAt).not.toBeNull();
    d.feed({ type: "network", network: { online: false, foreground: true } });
    expect(d.effects).toContainEqual({ type: "cancel-timer", timer: "retry" });
    expect(d.state).toMatchObject({ phase: "backoff", parked: true, retryAt: null });

    d.feed({ type: "network", network: { online: true, foreground: true } });
    expect(d.state).toMatchObject({ phase: "connecting", parked: false });
    expect(d.effects).toContainEqual({ type: "poll-discovery", attempt: d.state.attempt });
  });

  it("a failure while offline parks rather than arming the ladder", () => {
    const d = drive().ready();
    d.feed({ type: "network", network: { online: false, foreground: true } });
    expect(d.state.phase).toBe("ready");
    d.feed({ type: "close", attempt: d.state.attempt });
    expect(d.state).toMatchObject({ phase: "backoff", parked: true, retryAt: null });
    expect(armed(d.effects, "retry")).toEqual([]);
  });

  it("never parks the local connection, which is on loopback", () => {
    const d = drive({ kind: "local" }).start({ online: false, foreground: true });
    expect(d.state).toMatchObject({ phase: "connecting", parked: false });
    expect(d.effects).toContainEqual({ type: "poll-discovery", attempt: d.state.attempt });
    d.connect();
    d.feed({ type: "close", attempt: d.state.attempt }, 0);
    expect(d.state).toMatchObject({ phase: "backoff", parked: false, retryAt: d.now + 1000 });
    expect(armed(d.effects, "retry")).toEqual([1000]);
    d.feed({ type: "network", network: { online: false, foreground: true } });
    expect(d.state.retryAt).toBe(d.now + 1000);
    expect(d.effects).toEqual([]);
  });

  it("a foreground wakeup tries a service-down retry at once too, but not the wait after a bye", () => {
    const local = drive({ kind: "local" }).start();
    local.discovered({ kind: "unreachable", message: "refused" });
    local.feed({ type: "network", network: { online: true, foreground: false } });
    local.feed({ type: "network", network: { online: true, foreground: true } });
    expect(local.effects).toContainEqual({ type: "poll-discovery", attempt: local.state.attempt });

    const draining = drive().ready();
    draining.feed({ type: "bye", attempt: draining.state.attempt, bye: bye("draining") });
    draining.feed({ type: "network", network: { online: true, foreground: false } });
    draining.feed({ type: "network", network: { online: true, foreground: true } });
    expect(has(draining.effects, "poll-discovery")).toBe(false);
  });

  it("a wakeup never cuts short a parked wait after a bye or a starting poll: it waits them out again, and begins at once only from backoff", () => {
    for (const reason of ["draining", "updating"] as const) {
      // The bye comes while offline: the wait parks.
      const d = drive().ready();
      d.feed({ type: "network", network: { online: false, foreground: true } });
      d.feed({ type: "bye", attempt: d.state.attempt, bye: bye(reason) });
      expect(d.state).toMatchObject({ phase: reason, parked: true, retryAt: null });
      d.at(60_000).feed({ type: "network", network: { online: true, foreground: true } });
      expect(has(d.effects, "poll-discovery")).toBe(false);
      expect(d.state).toMatchObject({ phase: reason, parked: false, retryAt: 60_000 + BYE_WAIT_MS });
      expect(armed(d.effects, "retry")).toEqual([BYE_WAIT_MS]);

      // Offline during the armed five seconds: parked, and waited out again on the wakeup.
      const e = drive().ready();
      e.feed({ type: "bye", attempt: e.state.attempt, bye: bye(reason) });
      e.feed({ type: "network", network: { online: false, foreground: true } });
      expect(e.state).toMatchObject({ phase: reason, parked: true, retryAt: null });
      e.feed({ type: "network", network: { online: true, foreground: true } });
      expect(has(e.effects, "poll-discovery")).toBe(false);
      expect(armed(e.effects, "retry")).toEqual([BYE_WAIT_MS]);
    }

    const starting = drive().start();
    starting.discovered({ kind: "document", document: document({ readiness: "starting" }) });
    starting.feed({ type: "network", network: { online: false, foreground: true } });
    expect(starting.state).toMatchObject({ phase: "starting", parked: true });
    starting.feed({ type: "network", network: { online: true, foreground: true } });
    expect(has(starting.effects, "poll-discovery")).toBe(false);
    expect(armed(starting.effects, "retry")).toEqual([STARTING_POLL_MS]);
  });

  it("a network input that changes nothing answers the same state, so nothing is published", () => {
    const d = drive().ready();
    const before = d.state;
    d.feed({ type: "network", network: { ...before.network } });
    expect(d.state).toBe(before);
    expect(d.effects).toEqual([]);

    const disabled = drive();
    disabled.feed({ type: "disable" });
    const off = disabled.state;
    disabled.feed({ type: "network", network: { ...off.network } });
    expect(disabled.state).toBe(off);
  });

  it("starts parked when offline", () => {
    const d = drive().start({ online: false, foreground: true });
    expect(d.state).toMatchObject({ phase: "backoff", parked: true });
    expect(has(d.effects, "poll-discovery")).toBe(false);
  });

  it("a foreground wakeup on a connected socket probes it, and replaces it only when the probe fails", () => {
    const d = drive().ready();
    d.feed({ type: "network", network: { online: true, foreground: false } });
    expect(has(d.effects, "probe")).toBe(false);
    d.feed({ type: "network", network: { online: true, foreground: true } });
    expect(d.effects).toContainEqual({ type: "probe", attempt: d.state.attempt });
    expect(armed(d.effects, "probe")).toEqual([PROBE_TIMEOUT_MS]);

    d.feed({ type: "probe-result", attempt: d.state.attempt, ok: true });
    expect(d.state.phase).toBe("ready");
    expect(d.effects).toContainEqual({ type: "cancel-timer", timer: "probe" });
    expect(has(d.effects, "close-socket")).toBe(false);

    d.feed({ type: "network", network: { online: true, foreground: false } });
    d.feed({ type: "network", network: { online: true, foreground: true } });
    d.at(PROBE_TIMEOUT_MS).feed({ type: "timer", timer: "probe" });
    expect(d.effects).toContainEqual({ type: "close-socket", lost: true });
    expect(d.state.phase).toBe("connecting");
  });
});

describe("service-down and starting", () => {
  it("a local environment with nothing listening is service-down with the action service.start, retried on the ladder", () => {
    const d = drive({ kind: "local" }).start();
    d.discovered({ kind: "unreachable", message: "refused" });
    expect(d.state).toMatchObject({ phase: "service-down" });
    expect(actionOf(d.state)).toBe("service.start");
    expect(armed(d.effects, "retry")).toEqual([backoffDelay(1, 0.5)]);

    // A failed grant exchange says the same.
    const grant = drive({ kind: "local" }).start();
    grant.discovered({ kind: "grant-failed", reason: "service-down", message: "no grant file" });
    expect(grant.state.phase).toBe("service-down");

    const paired = drive().start();
    paired.discovered({ kind: "unreachable", message: "refused" });
    expect(paired.state.phase).toBe("backoff");
    expect(actionOf(paired.state)).toBeNull();
  });

  it("discovery answering starting is polled every two seconds without counting failures", () => {
    const d = drive().start();
    for (let poll = 0; poll < 4; poll++) {
      d.discovered({ kind: "document", document: document({ readiness: "starting" }) });
      expect(d.state).toMatchObject({ phase: "starting", failures: 0 });
      expect(armed(d.effects, "retry")).toEqual([STARTING_POLL_MS]);
      d.at(d.now + STARTING_POLL_MS).feed({ type: "timer", timer: "retry" });
      expect(d.state.phase).toBe("starting");
    }
    d.connect();
    expect(d.state.phase).toBe("ready");
    d.feed({ type: "close", attempt: d.state.attempt }, 0);
    expect(armed(d.effects, "retry")).toEqual([1000]);
  });
});

describe("unreachableSince", () => {
  it("is set at the first failure after ready, kept through later ones, and cleared on ready", () => {
    const d = drive().start();
    d.discovered({ kind: "unreachable", message: "nothing" });
    expect(d.state.unreachableSince).toBeNull();

    d.at(10_000).feed({ type: "timer", timer: "retry" }).connect();
    d.at(20_000).feed({ type: "close", attempt: d.state.attempt });
    expect(d.state.unreachableSince).toBe(20_000);
    d.at(22_000).feed({ type: "timer", timer: "retry" }).discovered({ kind: "unreachable", message: "nothing" });
    expect(d.state.unreachableSince).toBe(20_000);
    d.at(30_000).feed({ type: "timer", timer: "retry" }).connect();
    expect(d.state.unreachableSince).toBeNull();
  });

  it("is set at start when the cache has data", () => {
    const d = drive();
    d.at(5).start({ online: true, foreground: true }, true);
    expect(d.state.unreachableSince).toBe(5);
    d.connect();
    expect(d.state.unreachableSince).toBeNull();
  });
});

describe("token refresh", () => {
  it("runs on connect when fewer than seven days remain, and not otherwise", () => {
    const fresh = drive().start().connect(30 * DAY);
    expect(has(fresh.effects, "refresh-token")).toBe(false);
    expect(armed(fresh.effects, "refresh")).toEqual([REFRESH_CHECK_MS]);

    const due = drive().start().connect(REFRESH_WITHIN_MS - 1);
    expect(due.effects).toContainEqual({ type: "refresh-token", attempt: due.state.attempt });

    const unknown = drive().start().connect(null);
    expect(has(unknown.effects, "refresh-token")).toBe(true);
  });

  it("checks daily while connected", () => {
    const d = drive().start().connect(10 * DAY);
    d.at(REFRESH_CHECK_MS).feed({ type: "timer", timer: "refresh" });
    expect(has(d.effects, "refresh-token")).toBe(false);
    expect(armed(d.effects, "refresh")).toEqual([REFRESH_CHECK_MS]);
    d.at(4 * REFRESH_CHECK_MS).feed({ type: "timer", timer: "refresh" });
    expect(d.effects).toContainEqual({ type: "refresh-token", attempt: d.state.attempt });
    d.feed({ type: "refresh-result", attempt: d.state.attempt, result: { ok: true, expiresAt: d.now + 30 * DAY } });
    expect(d.state).toMatchObject({ expiresAt: d.now + 30 * DAY, refreshFailed: null });
  });

  it("reports a failure on the connection once, and never closes a healthy socket", () => {
    const d = drive().start().connect(DAY);
    d.feed({ type: "refresh-result", attempt: d.state.attempt, result: { ok: false, message: "forbidden" } });
    expect(d.state).toMatchObject({ phase: "ready", refreshFailed: "forbidden" });
    expect(has(d.effects, "close-socket")).toBe(false);
    expect(notices(d.effects)).toEqual([expect.objectContaining({ kind: "refresh-failed", message: expect.stringContaining("forbidden") })]);

    d.at(REFRESH_CHECK_MS).feed({ type: "timer", timer: "refresh" });
    d.feed({ type: "refresh-result", attempt: d.state.attempt, result: { ok: false, message: "forbidden" } });
    expect(notices(d.effects)).toEqual([]);
    d.feed({ type: "refresh-result", attempt: d.state.attempt, result: { ok: true, expiresAt: d.now + 30 * DAY } });
    expect(d.state.refreshFailed).toBeNull();
  });
});

describe("enable, disable and retryNow", () => {
  it("disabled drops the socket and stops retrying; retryNow does nothing then", () => {
    const d = drive().ready();
    d.feed({ type: "disable" });
    expect(d.state).toMatchObject({ phase: "disabled", retryAt: null, unreachableSince: null });
    expect(d.effects).toContainEqual({ type: "close-socket", lost: false });
    d.feed({ type: "retryNow" });
    expect(d.state.phase).toBe("disabled");
    expect(d.effects).toEqual([]);
  });

  it("start while disabled stays disabled", () => {
    const d = drive().feed({ type: "start", enabled: false, network: { online: true, foreground: true }, hasCache: true });
    expect(d.state.phase).toBe("disabled");
    expect(d.effects.filter((e) => e.type !== "cancel-timer")).toEqual([]);
  });

  it("a fresh retryNow starts the ladder over", () => {
    const d = drive({ kind: "local" }).start();
    for (let i = 0; i < 6; i++) d.discovered({ kind: "unreachable", message: "refused" }).feed({ type: "timer", timer: "retry" });
    d.discovered({ kind: "unreachable", message: "refused" }, 0);
    expect(armed(d.effects, "retry")).toEqual([30_000]);
    d.feed({ type: "retryNow", fresh: true });
    d.discovered({ kind: "unreachable", message: "refused" }, 0);
    expect(armed(d.effects, "retry")).toEqual([1000]);
  });

  it("retryNow tries at once from backoff, even offline", () => {
    const d = drive().ready();
    d.feed({ type: "network", network: { online: false, foreground: true } });
    d.feed({ type: "close", attempt: d.state.attempt });
    d.feed({ type: "retryNow" });
    expect(d.effects).toContainEqual({ type: "poll-discovery", attempt: d.state.attempt });
  });
});

describe("an update taken across a protocol gap", () => {
  /** A machine blocked `protocol-mismatch` whose environment can update itself, as `update-environment` offers. */
  const blocked = () => drive({ blocked: "protocol-mismatch", capabilities: ["self-update"] }).start();

  it("shows updating while the block waits for a hello that agrees, polling discovery and raising nothing", () => {
    const d = blocked();
    d.discovered({ kind: "document", document: document({ protocolVersion: CLIENT - 1 }) });
    expect(d.state).toMatchObject({ phase: "blocked", blocked: "protocol-mismatch" });

    d.at(100).feed({ type: "update-taken" });
    expect(d.state).toMatchObject({ phase: "updating", blocked: "protocol-mismatch", retryAt: 100 + BYE_WAIT_MS, failures: 0 });
    expect(armed(d.effects, "retry")).toEqual([BYE_WAIT_MS]);
    expect(notices(d.effects)).toEqual([]);
    expect(actionOf(d.state)).toBeNull();

    // The old environment still answers, a run keeping it from restarting: still updating, polled again, no failure counted.
    d.at(d.state.retryAt as number).feed({ type: "timer", timer: "retry" });
    d.discovered({ kind: "document", document: document({ protocolVersion: CLIENT - 1 }) });
    expect(d.state).toMatchObject({ phase: "updating", blocked: "protocol-mismatch", failures: 0 });
    expect(armed(d.effects, "retry")).toEqual([BYE_WAIT_MS]);
    expect(notices(d.effects)).toEqual([]);
  });

  it("stays updating through the restart: nothing answering, starting, draining, and a discovery read that hangs", () => {
    const d = blocked();
    d.feed({ type: "update-taken" });
    const round = (answer: DiscoveryAnswer | "hangs") => {
      d.at(d.state.retryAt as number).feed({ type: "timer", timer: "retry" });
      if (answer === "hangs") d.feed({ type: "timer", timer: "establish" });
      else d.discovered(answer);
      expect(d.state).toMatchObject({ phase: "updating", blocked: "protocol-mismatch" });
      expect(d.state.retryAt).not.toBeNull();
      expect(notices(d.effects)).toEqual([]);
    };
    round({ kind: "unreachable", message: "restarting" });
    round({ kind: "malformed", message: "half a document" });
    round({ kind: "document", document: document({ readiness: "starting" }) });
    round({ kind: "document", document: document({ readiness: "draining" }) });
    round("hangs");
  });

  it("clears the block once hello agrees, and the connection is ready", () => {
    const d = blocked();
    d.feed({ type: "update-taken" });
    d.at(d.state.retryAt as number).feed({ type: "timer", timer: "retry" });
    d.discovered({ kind: "document", document: document({ harnessVersion: "1.1.0" }) });
    expect(d.state).toMatchObject({ phase: "updating", blocked: "protocol-mismatch", step: "dialing" });
    expect(d.effects).toContainEqual({ type: "open-socket", attempt: d.state.attempt });

    d.feed({ type: "hello", attempt: d.state.attempt, hello: hello(), expiresAt: null });
    expect(d.state).toMatchObject({ phase: "ready", blocked: null, bye: null });
    expect(d.effects).toContainEqual({ type: "attach" });
  });

  it("is blocked again, with no new notice, when a retry David asks for finds the old protocol still there", () => {
    const d = blocked();
    d.feed({ type: "update-taken" });
    d.feed({ type: "retryNow" });
    expect(d.state.phase).toBe("blocked");
    d.discovered({ kind: "document", document: document({ protocolVersion: CLIENT - 1, capabilities: ["self-update"] }) });
    expect(d.state).toMatchObject({ phase: "blocked", blocked: "protocol-mismatch" });
    expect(notices(d.effects)).toEqual([]);
    expect(actionOf(d.state)).toBe("update-environment");
  });

  it("is blocked as it was when the restarted environment speaks a protocol the client does not", () => {
    const d = blocked();
    d.feed({ type: "update-taken" });
    d.at(d.state.retryAt as number).feed({ type: "timer", timer: "retry" });
    d.discovered({ kind: "document", document: document({ protocolVersion: CLIENT + 1 }) });
    expect(d.state).toMatchObject({ phase: "blocked", blocked: "unsupported-client" });
    expect(notices(d.effects)).toEqual([expect.objectContaining({ kind: "unsupported-client" })]);
  });

  it("is taken by no other state: a ready, a disabled or an otherwise blocked connection ignores it", () => {
    const ready = drive().ready();
    ready.feed({ type: "update-taken" });
    expect(ready.state.phase).toBe("ready");
    const revoked = drive({ blocked: "revoked" }).start();
    revoked.feed({ type: "update-taken" });
    expect(revoked.state).toMatchObject({ phase: "blocked", blocked: "revoked" });
  });
});
