import { PROTOCOL_VERSION } from "@agent-harness/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import type { InternalOptions } from "./internal.js";
import { createRuntimeWithSeams } from "./internal.js";
import type { Runtime } from "./runtime.js";
import { fakeWire, flush, type FakeWireOptions } from "./testing/fake-wire.js";
import { fakeShell, inMemoryPlatform, manualClock, type InMemoryPlatformOptions } from "./testing/in-memory-platform.js";

/**
 * The fake-wire suite (docs/specs/client-runtime.md, "Testing Decisions",
 * the second seam): the runtime against a scripted environment, frame by
 * frame, under the manual clock. What it asserts is what a renderer sees:
 * the connection's phase, `retryAt`, `unreachableSince`, its action, the
 * notices; and what the environment sees: sockets opened, frames sent.
 */

const DAY = 24 * 60 * 60 * 1000;

interface Setup {
  readonly wire?: Partial<Omit<FakeWireOptions, "clock">>;
  readonly platform?: InMemoryPlatformOptions;
  readonly runtime?: InternalOptions;
}

/** A runtime on the in-memory platform over a fake wire, started. */
const started = async (setup: Setup = {}) => {
  const clock = setup.platform?.clock ?? manualClock();
  const wire = fakeWire({ clock, ...setup.wire });
  const platform = inMemoryPlatform({ clock, fetch: wire.fetch, webSocket: wire.webSocket, ...setup.platform });
  const { runtime, seams } = createRuntimeWithSeams(platform, setup.runtime);
  onTestFinished(() => runtime.close());
  const starting = runtime.start();
  return { clock, wire, platform, runtime, seams, starting };
};

/** A runtime paired with the fake environment and ready. */
const paired = async (setup: Setup = {}) => {
  const s = await started(setup);
  await s.starting;
  const adding = s.runtime.connections.add({ link: s.wire.link });
  await s.wire.server.accept();
  expect(await adding).toMatchObject({ status: "paired" });
  expect(record(s.runtime).phase).toBe("ready");
  return s;
};

const record = (runtime: Runtime) => {
  const [only, ...rest] = runtime.connections.list.read();
  if (!only || rest.length > 0) throw new Error(`Expected one connection, found ${runtime.connections.list.read().length}.`);
  return only;
};

const view = (runtime: Runtime) => {
  const [only] = runtime.projections.environments.read();
  if (!only) throw new Error("No environment is listed.");
  return only;
};

/** How long until the connection's next attempt, on the manual clock. */
const untilRetry = (runtime: Runtime, now: Date) => {
  const { retryAt } = record(runtime);
  if (retryAt === null) throw new Error(`No retry is scheduled (phase ${record(runtime).phase}).`);
  return Date.parse(retryAt) - now.getTime();
};

describe("the watchdog", () => {
  it("answers ping with pong, and on 45 seconds of silence after it replaces the socket at once", async () => {
    const { wire, clock, runtime, seams } = await paired();
    const lost: string[] = [];
    seams.onClose((id) => void lost.push(id));

    // Before any ping the silence is not watched.
    clock.advance(60_000);
    await flush();
    expect(wire.opened()).toBe(1);

    wire.server.ping();
    expect(await wire.server.expect("pong")).toEqual({ type: "pong" });
    wire.server.silence();
    clock.advance(44_999);
    await flush();
    expect(record(runtime).phase).toBe("ready");

    clock.advance(1);
    await flush();
    expect(wire.opened()).toBe(2);
    expect(record(runtime)).toMatchObject({ phase: "connecting", unreachableSince: clock.now().toISOString() });
    expect(lost).toEqual([wire.environmentId]);

    await wire.server.accept();
    await flush();
    expect(record(runtime)).toMatchObject({ phase: "ready", unreachableSince: null });
  });
});

describe("the backoff ladder", () => {
  it("retries a dropped socket at 1, 2, 4, 8, 16, then 30 seconds, each within its jitter, and resets after 30 seconds healthy", async () => {
    const { wire, clock, runtime } = await paired();
    const droppedAt = clock.now().toISOString();
    wire.server.drop();
    await flush();
    expect(record(runtime)).toMatchObject({ phase: "backoff", unreachableSince: droppedAt });
    expect(view(runtime)).toMatchObject({ phase: "backoff", unreachableSince: droppedAt, retryAt: record(runtime).retryAt });

    wire.discovery("unreachable");
    for (const base of [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]) {
      const delay = untilRetry(runtime, clock.now());
      expect(delay).toBeGreaterThanOrEqual(base);
      expect(delay).toBeLessThanOrEqual(base * 1.25);
      const reads = wire.discoveries();
      clock.advance(delay - 1);
      await flush();
      expect(wire.discoveries()).toBe(reads);
      clock.advance(1);
      await flush();
      expect(wire.discoveries()).toBe(reads + 1);
      expect(record(runtime)).toMatchObject({ phase: "backoff", unreachableSince: droppedAt });
    }

    wire.discovery({});
    clock.advance(untilRetry(runtime, clock.now()));
    await wire.server.accept();
    await flush();
    expect(record(runtime)).toMatchObject({ phase: "ready", retryAt: null, unreachableSince: null });

    // Dropped again inside 30 seconds, the ladder goes on from where it was.
    wire.server.drop();
    await flush();
    expect(untilRetry(runtime, clock.now())).toBeGreaterThanOrEqual(30_000);

    clock.advance(untilRetry(runtime, clock.now()));
    await wire.server.accept();
    await flush();
    clock.advance(30_000);
    wire.server.drop();
    await flush();
    const delay = untilRetry(runtime, clock.now());
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThanOrEqual(1250);
  });

  it("gives an attempt 15 seconds from opening the socket to hello", async () => {
    const { wire, clock, runtime } = await paired();
    wire.server.drop();
    await flush();
    clock.advance(untilRetry(runtime, clock.now()));
    await wire.server.expect("auth");
    expect(record(runtime).phase).toBe("connecting");

    clock.advance(14_999);
    await flush();
    expect(wire.open()).toBe(1);
    clock.advance(1);
    await flush();
    expect(wire.open()).toBe(0);
    expect(record(runtime).phase).toBe("backoff");
    const delay = untilRetry(runtime, clock.now());
    expect(delay).toBeGreaterThanOrEqual(2000);
    expect(delay).toBeLessThanOrEqual(2500);
  });
});

describe("the network signal", () => {
  it("parks the retry while offline instead of spending attempts, and tries at once on the wakeup", async () => {
    const { wire, clock, platform, runtime } = await paired();
    platform.network.setOnline(false);
    wire.server.drop();
    await flush();
    expect(record(runtime)).toMatchObject({ phase: "backoff", retryAt: null });

    clock.advance(10 * 60_000);
    await flush();
    expect(wire.opened()).toBe(1);

    platform.network.setOnline(true);
    await wire.server.accept();
    await flush();
    expect(wire.opened()).toBe(2);
    expect(record(runtime).phase).toBe("ready");
  });

  it("going offline parks a retry already scheduled", async () => {
    const { wire, clock, platform, runtime } = await paired();
    wire.server.drop();
    await flush();
    expect(record(runtime).retryAt).not.toBeNull();

    platform.network.setOnline(false);
    expect(record(runtime)).toMatchObject({ phase: "backoff", retryAt: null });
    clock.advance(10 * 60_000);
    await flush();
    expect(wire.opened()).toBe(1);

    platform.network.setOnline(true);
    await wire.server.accept();
    await flush();
    expect(record(runtime).phase).toBe("ready");
  });

  it("probes a connected socket on a foreground wakeup, and replaces it only when the probe fails", async () => {
    const { wire, clock, platform, runtime } = await paired();
    platform.network.setForeground(false);
    platform.network.setForeground(true);
    expect(await wire.server.expect("request")).toMatchObject({ method: "environment.status" });
    await flush();
    clock.advance(10_000);
    await flush();
    expect(wire.opened()).toBe(1);
    expect(record(runtime).phase).toBe("ready");

    wire.server.silence();
    platform.network.setForeground(false);
    platform.network.setForeground(true);
    await flush();
    clock.advance(5000);
    await flush();
    expect(wire.opened()).toBe(2);
    await wire.server.accept();
    await flush();
    expect(record(runtime).phase).toBe("ready");
  });
});

describe("bye", () => {
  it.each([
    ["revoked", "revoked"],
    ["unauthorized", "revoked"],
    ["expired", "expired"],
  ] as const)("%s blocks as %s, clears the token and raises a notice", async (reason, blocked) => {
    const { wire, clock, platform, runtime } = await paired();
    wire.server.bye(reason);
    await flush();

    expect(record(runtime)).toMatchObject({ phase: "blocked", blocked, bye: reason, retryAt: null });
    expect(await platform.secrets.get(wire.environmentId)).toBeUndefined();
    expect(runtime.projections.notices.read()).toEqual([
      expect.objectContaining({ environmentId: wire.environmentId, kind: blocked, message: expect.stringContaining("fake") }),
    ]);
    clock.advance(10 * 60_000);
    await flush();
    expect(wire.opened()).toBe(1);
  });

  it("expired offers re-pair, which pairs the connection in place", async () => {
    const { wire, runtime } = await paired();
    wire.server.bye("expired");
    await flush();
    const [notice] = runtime.projections.notices.read();
    expect(notice?.action).toBe("re-pair");
    expect(view(runtime)).toMatchObject({ blocked: "expired", action: "re-pair" });

    const again = runtime.connections.add({ link: wire.link }, { rePair: wire.environmentId });
    await wire.server.accept();
    expect(await again).toEqual({ status: "paired", environmentId: wire.environmentId });
    expect(view(runtime)).toMatchObject({ phase: "ready", blocked: null, action: null });

    runtime.notices.dismiss(notice?.id ?? "");
    expect(runtime.projections.notices.read()).toEqual([]);
  });

  it.each(["draining", "updating"] as const)(
    "%s waits five seconds, then follows the ladder polling discovery for ready; the next hello brings the new flags",
    async (reason) => {
      const { wire, clock, runtime } = await paired();
      expect(runtime.capability(wire.environmentId, "self-update")).toMatchObject({ status: "absent", reason: "unsupported" });
      wire.discovery({ readiness: "draining" });
      wire.server.bye(reason);
      await flush();
      expect(record(runtime)).toMatchObject({ phase: reason, bye: reason, retryAt: new Date(clock.now().getTime() + 5000).toISOString() });
      expect(runtime.projections.notices.read()).toEqual([]);

      const reads = wire.discoveries();
      clock.advance(5000);
      await flush();
      expect(wire.discoveries()).toBe(reads + 1);
      expect(record(runtime).phase).toBe(reason);
      const first = untilRetry(runtime, clock.now());
      expect(first).toBeGreaterThanOrEqual(1000);
      expect(first).toBeLessThanOrEqual(1250);

      clock.advance(first);
      await flush();
      const second = untilRetry(runtime, clock.now());
      expect(second).toBeGreaterThanOrEqual(2000);
      expect(second).toBeLessThanOrEqual(2500);

      wire.discovery({ readiness: "ready", capabilities: ["self-update"], harnessVersion: "0.0.1-fake" });
      clock.advance(second);
      await wire.server.accept({ capabilities: ["self-update"] });
      await flush();
      expect(record(runtime)).toMatchObject({ phase: "ready", bye: null, descriptor: { capabilities: ["self-update"], harnessVersion: "0.0.1-fake" } });
      expect(runtime.capability(wire.environmentId, "self-update")).toEqual({ status: "present" });
    },
  );

  it.each([
    ["newer", "unsupported-client", "update-client"],
    ["older", "protocol-mismatch", null],
  ] as const)("protocol from an environment %s than this client blocks as %s", async (side, blocked, action) => {
    // The client speaks one more than this build, so an older environment is expressible.
    const client = PROTOCOL_VERSION + 1;
    const { wire, runtime } = await paired({ runtime: { protocolVersion: client }, wire: { protocolVersion: client } });
    wire.server.bye("protocol", { protocolVersion: side === "newer" ? client + 1 : client - 1 });
    await flush();
    expect(record(runtime)).toMatchObject({ phase: "blocked", blocked, action });
    expect(runtime.projections.notices.read()).toEqual([expect.objectContaining({ kind: blocked, action })]);
  });
});

describe("hello", () => {
  it("naming another environment blocks different-environment and keeps the old cache", async () => {
    const { wire, runtime } = await paired();
    const cached = record(runtime);
    wire.server.drop();
    await flush();

    const retrying = runtime.connections.retryNow(wire.environmentId);
    await wire.server.accept({ environmentId: "0192f1d2-3c4b-7a5e-8f60-000000000000", environmentName: "impostor" });
    await retrying;

    expect(record(runtime)).toMatchObject({ phase: "blocked", blocked: "different-environment", descriptor: cached.descriptor, clientSessionId: cached.clientSessionId });
    expect(wire.open()).toBe(0);
    expect(runtime.projections.notices.read()).toEqual([]);
  });

  it("is ready on hello alone, before any stream is attached", async () => {
    const { wire, runtime } = await paired();
    expect(wire.server.received().filter((frame) => frame.type === "request")).toEqual([]);
    expect(record(runtime).phase).toBe("ready");
  });
});

describe("discovery", () => {
  it("answering starting is polled every two seconds without counting failures", async () => {
    const { wire, clock, runtime } = await paired();
    wire.discovery({ readiness: "starting" });
    wire.server.drop();
    await flush();
    clock.advance(untilRetry(runtime, clock.now()));
    await flush();
    expect(record(runtime)).toMatchObject({ phase: "starting" });

    for (let poll = 0; poll < 5; poll++) {
      expect(untilRetry(runtime, clock.now())).toBe(2000);
      const reads = wire.discoveries();
      clock.advance(2000);
      await flush();
      expect(wire.discoveries()).toBe(reads + 1);
      expect(record(runtime).phase).toBe("starting");
    }

    wire.discovery({});
    clock.advance(2000);
    await wire.server.accept();
    await flush();
    expect(record(runtime).phase).toBe("ready");
    // Only the drop counted: the next failure waits the second rung.
    wire.server.drop();
    await flush();
    expect(untilRetry(runtime, clock.now())).toBeGreaterThanOrEqual(2000);
    expect(untilRetry(runtime, clock.now())).toBeLessThanOrEqual(2500);
  });

  it.each([
    ["newer", PROTOCOL_VERSION + 1, "unsupported-client", "update-client", []],
    ["older", PROTOCOL_VERSION, "protocol-mismatch", null, []],
    ["older and able to update itself", PROTOCOL_VERSION, "protocol-mismatch", "update-environment", ["self-update"]],
  ] as const)(
    "with the environment %s blocks, keeps the block across a restart, and clears it once the versions match",
    async (_, theirs, blocked, action, capabilities) => {
      // The client is the newer side of an older environment by speaking one more than it.
      const client = blocked === "protocol-mismatch" ? PROTOCOL_VERSION + 1 : PROTOCOL_VERSION;
      const { wire, clock, platform, runtime } = await paired({ runtime: { protocolVersion: client }, wire: { protocolVersion: client } });
      wire.discovery({ protocolVersion: theirs, capabilities: [...capabilities] });
      await runtime.connections.retryNow(wire.environmentId);

      expect(record(runtime)).toMatchObject({ phase: "blocked", blocked, action });
      expect(view(runtime)).toMatchObject({ phase: "blocked", blocked, action });
      expect(runtime.projections.notices.read()).toEqual([
        expect.objectContaining({ kind: blocked, action, message: expect.stringContaining(blocked === "unsupported-client" ? "update this client" : "update fake") }),
      ]);
      clock.advance(10 * 60_000);
      await flush();
      expect(wire.opened()).toBe(1);

      // A restart re-checks the saved block against discovery.
      await runtime.close();
      const again = createRuntimeWithSeams(inMemoryPlatform({ clock, fetch: wire.fetch, webSocket: wire.webSocket, documents: platform.documents, secrets: platform.secrets }), {
        protocolVersion: client,
      }).runtime;
      onTestFinished(() => again.close());
      const reads = wire.discoveries();
      await again.start();
      expect(wire.discoveries()).toBe(reads + 1);
      expect(record(again)).toMatchObject({ phase: "blocked", blocked });
      expect(again.projections.notices.read()).toEqual([]);

      wire.discovery({ protocolVersion: client });
      const retrying = again.connections.retryNow(wire.environmentId);
      await wire.server.accept();
      await retrying;
      expect(record(again)).toMatchObject({ phase: "ready", blocked: null, action: null });
    },
  );
});

describe("the local environment", () => {
  it("stays listed as service-down, retried on the ladder, and startService starts it through the shell", async () => {
    const clock = manualClock();
    const wire = fakeWire({ clock, name: "desk" });
    const shell = fakeShell();
    const platform = (documents?: ReturnType<typeof inMemoryPlatform>["documents"]) =>
      inMemoryPlatform({ clock, kind: "tui", grant: wire.grant, shell, fetch: wire.fetch, webSocket: wire.webSocket, ...(documents && { documents }) });

    const first = platform();
    const seen = createRuntimeWithSeams(first).runtime;
    onTestFinished(() => seen.close());
    const starting = seen.start();
    await wire.server.accept();
    await starting;
    expect(record(seen)).toMatchObject({ kind: "local", phase: "ready" });
    await seen.close();

    wire.discovery("unreachable");
    const { runtime } = createRuntimeWithSeams(platform(first.documents));
    onTestFinished(() => runtime.close());
    await runtime.start();
    expect(record(runtime)).toMatchObject({ kind: "local", phase: "service-down", action: "service.start" });
    expect(view(runtime)).toMatchObject({ phase: "service-down", action: "service.start" });
    const delay = untilRetry(runtime, clock.now());
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThanOrEqual(1250);

    wire.discovery({});
    const startingService = runtime.connections.startService(wire.environmentId);
    await wire.server.accept();
    await startingService;
    expect(shell.calls).toContainEqual(["service.start", undefined]);
    expect(record(runtime)).toMatchObject({ phase: "ready", action: null });
  });

  it("startService is refused without a shell service, and for a paired connection", async () => {
    const { wire, runtime } = await paired();
    await expect(runtime.connections.startService(wire.environmentId)).rejects.toThrow(/not this machine's local environment/);

    const clock = manualClock();
    const local = fakeWire({ clock });
    const noShell = createRuntimeWithSeams(inMemoryPlatform({ clock, kind: "tui", grant: local.grant, fetch: local.fetch, webSocket: local.webSocket })).runtime;
    onTestFinished(() => noShell.close());
    const starting = noShell.start();
    await local.server.accept();
    await starting;
    await expect(noShell.connections.startService(local.environmentId)).rejects.toThrow(/service start/);
  });
});

describe("token refresh", () => {
  it("runs daily while connected once fewer than seven days remain, keeping the new token and its expiry", async () => {
    const { wire, clock, platform, runtime } = await paired();
    const first = await platform.secrets.get(wire.environmentId);
    expect(wire.server.received().filter((f) => f.type === "request")).toEqual([]);

    for (let day = 1; day <= 23; day++) clock.advance(DAY);
    await flush();
    expect(wire.server.received().filter((f) => f.type === "request")).toEqual([]);

    clock.advance(DAY);
    expect(await wire.server.expect("request")).toMatchObject({ method: "access.sessions.refresh", params: { commandId: expect.any(String) } });
    await flush();
    const token = await platform.secrets.get(wire.environmentId);
    expect(token).not.toBe(first);
    expect(token).toBe(wire.credential()?.token);
    expect(record(runtime)).toMatchObject({ phase: "ready", expiresAt: wire.credential()?.expiresAt, refreshFailed: null });
  });

  it("runs on connect when fewer than seven days remain", async () => {
    const { wire, clock, platform } = await paired();
    // Offline for 25 days: no socket, so no daily check.
    platform.network.setOnline(false);
    wire.server.drop();
    await flush();
    clock.advance(25 * DAY);
    platform.network.setOnline(true);
    await wire.server.accept();
    expect(await wire.server.expect("request")).toMatchObject({ method: "access.sessions.refresh" });
  });

  it("reports a failure on the connection and never closes a healthy socket", async () => {
    const { wire, clock, runtime } = await paired();
    wire.answer("access.sessions.refresh", () => ({ error: { code: "forbidden", message: "This client session lacks the read scope.", data: {} } }));
    clock.advance(24 * DAY);
    await flush();

    expect(record(runtime)).toMatchObject({ phase: "ready", refreshFailed: "This client session lacks the read scope." });
    expect(view(runtime).refreshFailed).toBe("This client session lacks the read scope.");
    expect(runtime.projections.notices.read()).toEqual([expect.objectContaining({ kind: "refresh-failed" })]);
    expect(wire.opened()).toBe(1);
    expect(wire.open()).toBe(1);
  });
});
