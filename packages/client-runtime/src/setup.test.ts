import type { EnvironmentStatus, StepResult } from "@agent-harness/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { after } from "../test/environments.js";
import { noticeEvent } from "../test/events.js";
import { subscription, type Scripted } from "../test/scripted.js";
import { attentionResult, doneResult, skippedResult } from "../test/setup.js";
import { createRuntimeWithSeams } from "./internal.js";
import type { Runtime } from "./runtime.js";
import { fakeWire, flush, type FakeWire } from "./testing/fake-wire.js";
import { fakeShell, inMemoryPlatform, manualClock, type InMemoryDocumentStore } from "./testing/in-memory-platform.js";

/**
 * `projections.setup` through the fake wire (#570; the Set up
 * specification, "Results, the cache and the subscription"; ADR 0031):
 * the eleven steps with each registered step's latest result, filled from
 * the environment stream's snapshot and its `setup.result-changed`
 * notices, this client's own `setup.check` pending after half a second on
 * the manual clock, the fallback for an environment without the `setup`
 * flag, and the environment unreachable or its service down.
 */

const STATUS: EnvironmentStatus = { readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false };

/** A runtime paired with one scripted environment offering `capabilities` (preset `setup`), its environment stream held by the test. */
const paired = async (options: { readonly capabilities?: readonly string[]; readonly skewMs?: number } = {}) => {
  const clock = manualClock();
  const wire: FakeWire = fakeWire({ clock, name: "desk", capabilities: [...(options.capabilities ?? ["setup"])] });
  wire.answer("sessions.subscribe", () => undefined);
  wire.answer("environment.subscribe", () => undefined);
  const platform = inMemoryPlatform({ clock, fetch: wire.fetch, webSocket: wire.webSocket });
  const { runtime } = createRuntimeWithSeams(platform);
  onTestFinished(() => runtime.close());
  await runtime.start();
  const adding = runtime.connections.add({ link: wire.link });
  await wire.server.accept({ serverTime: new Date(clock.now().getTime() + (options.skewMs ?? 0)).toISOString() });
  (await subscription(wire, "sessions.subscribe")).synchronized(0);
  const environment: Scripted = await subscription(wire, "environment.subscribe");
  return { clock, wire, platform, runtime, env: wire.environmentId, environment, adding };
};

/** The `setup.check` requests the client has sent on its latest socket. */
const checksSent = (wire: FakeWire) => wire.server.received().filter((frame) => frame.type === "request" && frame.method === "setup.check");

/** Each step's id, whether it is registered, and its result's state, reason and staleness, as the projection has them now. */
const rows = (runtime: Runtime, env: string) =>
  runtime.projections.setup(env).read().steps.map((step) => ({
    id: step.id,
    registered: step.registered,
    result: step.result === null ? null : { state: step.result.state, reason: step.result.reason, stale: step.result.stale },
  }));

const unregistered = (id: string) => ({ id, registered: false, result: null });

/** The steps reading pending now. */
const pending = (runtime: Runtime, env: string) => runtime.projections.setup(env).read().steps.flatMap((step) => (step.pending ? [step.id] : []));

/** One step's result as the projection has it now. */
const resultOf = (runtime: Runtime, env: string, id: string) => runtime.projections.setup(env).read().steps.find((step) => step.id === id)?.result ?? null;

/** Answers each `setup.check` only when the test says: `answer` with results, or `fail` with an error code. */
const heldChecks = (wire: FakeWire) => {
  const waiting: ((body: { result: { results: StepResult[] } } | { error: { code: string; message: string; data: Record<string, unknown> } }) => void)[] = [];
  wire.answer("setup.check", () => new Promise((resolve) => waiting.push(resolve)));
  return {
    answer: (results: StepResult[]) => waiting.shift()?.({ result: { results } }),
    fail: (code: string) => waiting.shift()?.({ error: { code, message: `The check failed: ${code}.`, data: {} } }),
  };
};

/** A runtime paired with a scripted environment with the flag, whose snapshot held Account done and Permissions needing attention; the projection followed. */
const withResults = async () => {
  const made = await paired();
  made.environment.snapshot(3, { status: STATUS, setup: [doneResult("account"), attentionResult("permissions", "permissions.denylist", ["restore"])] });
  made.environment.synchronized(3);
  await made.adding;
  await flush();
  onTestFinished(made.runtime.projections.setup(made.env).subscribe(() => undefined));
  return made;
};

describe("projections.setup from the snapshot and the notices", () => {
  it("lists the eleven steps in order with their labels and home rows, fills from the snapshot's setup and applies each notice, with no call of its own", async () => {
    const { runtime, wire, env, environment, adding } = await paired();
    const setup = runtime.projections.setup(env);
    const seen: unknown[] = [];
    onTestFinished(setup.subscribe((view) => seen.push(view)));
    const permissions = attentionResult("permissions", "permissions.denylist", ["restore"]);
    environment.snapshot(3, { status: STATUS, setup: [doneResult("account"), permissions] });
    environment.synchronized(3);
    await adding;
    await flush();

    expect(setup.read().steps.map(({ id, label, home }) => [id, label, home])).toEqual([
      ["account", "Account", "accounts.accounts"],
      ["carry-over", "Carry over", "accounts.accounts"],
      ["your-machines", "Your machines", "environments.machines"],
      ["forges", "Forges", "access.forges"],
      ["key-manager", "Key manager", "access.key-managers"],
      ["memory-bank", "Memory bank", "knowledge.banks"],
      ["skills", "Skills", "knowledge.skills"],
      ["instructions", "Instructions", "knowledge.instructions"],
      ["browser", "Browser", "access.browser"],
      ["permissions", "Permissions", "access.permissions"],
      ["appearance", "Appearance", "appearance.theme"],
    ]);
    expect(setup.read().steps.find((step) => step.id === "permissions")?.result).toMatchObject({ ...permissions, stale: false });
    expect(rows(runtime, env)).toEqual([
      { id: "account", registered: true, result: { state: "done", reason: "account holds.", stale: false } },
      ...["carry-over", "your-machines", "forges", "key-manager", "memory-bank", "skills", "instructions", "browser"].map(unregistered),
      { id: "permissions", registered: true, result: { state: "needs-attention", reason: "permissions.denylist does not hold.", stale: false } },
      unregistered("appearance"),
    ]);
    expect(setup.read().counts).toEqual({ registered: 2, done: 1, needsAttention: 1, skipped: 0, attention: ["permissions"] });

    // The denylist put right on another client, and Appearance checked for the first time: two notices, and no call from here.
    environment.event(noticeEvent(4, env, "setup.result-changed", doneResult("permissions", { checkedAt: "2026-09-24T00:00:04.000Z" })));
    environment.event(noticeEvent(5, env, "setup.result-changed", doneResult("appearance", { reason: "The theme holds." })));
    await flush();
    expect(rows(runtime, env).filter((row) => row.registered)).toEqual([
      { id: "account", registered: true, result: { state: "done", reason: "account holds.", stale: false } },
      { id: "permissions", registered: true, result: { state: "done", reason: "permissions holds.", stale: false } },
      { id: "appearance", registered: true, result: { state: "done", reason: "The theme holds.", stale: false } },
    ]);
    expect(setup.read().counts).toEqual({ registered: 3, done: 3, needsAttention: 0, skipped: 0, attention: [] });
    expect(seen.length).toBeGreaterThan(0);
    expect(checksSent(wire)).toEqual([]);
  });
});

describe("this client's own check", () => {
  it("reads pending once half a second passes without its answer and stops at the answer, which it applies; a result published unasked never reads pending", async () => {
    const { runtime, wire, clock, env, environment } = await withResults();
    const checks = heldChecks(wire);

    const checking = runtime.setup.check(env, "permissions");
    await flush();
    expect(checksSent(wire).map((frame) => frame.type === "request" && frame.params)).toEqual([{ step: "permissions" }]);
    clock.advance(499);
    await flush();
    expect(pending(runtime, env)).toEqual([]);
    // Account's result changes on the environment meanwhile, unasked: it shows at once and never pending.
    environment.event(noticeEvent(4, env, "setup.result-changed", attentionResult("account", "account.signed-in", ["sign-in-again"], { checkedAt: after(499) })));
    clock.advance(1);
    await flush();
    expect(pending(runtime, env)).toEqual(["permissions"]);
    expect(resultOf(runtime, env, "account")).toMatchObject({ state: "needs-attention", checkedAt: after(499) });
    clock.advance(9_000);
    await flush();
    expect(pending(runtime, env)).toEqual(["permissions"]);

    // The answer finds what the cache held, so no notice comes: the answer itself is applied, with its checked-at.
    checks.answer([attentionResult("permissions", "permissions.denylist", ["restore"], { checkedAt: after(1) })]);
    expect(await checking).toMatchObject({ ok: true });
    expect(pending(runtime, env)).toEqual([]);
    expect(resultOf(runtime, env, "permissions")).toMatchObject({ state: "needs-attention", checkedAt: after(1), stale: false });
  });

  it("stops reading pending at the request's failure, keeping the result held", async () => {
    const { runtime, wire, clock, env } = await withResults();
    const checks = heldChecks(wire);
    const checking = runtime.setup.check(env, "account");
    clock.advance(500);
    await flush();
    expect(pending(runtime, env)).toEqual(["account"]);
    checks.fail("internal");
    expect(await checking).toMatchObject({ ok: false, error: { code: "internal" } });
    expect(pending(runtime, env)).toEqual([]);
    expect(resultOf(runtime, env, "account")).toMatchObject({ state: "done", checkedAt: after(0) });
  });

  it("asks about every step when it names none, and an answer that comes within half a second never reads pending", async () => {
    const { runtime, wire, clock, env } = await withResults();
    const checks = heldChecks(wire);
    const all = runtime.setup.check(env);
    clock.advance(500);
    await flush();
    expect(checksSent(wire).map((frame) => frame.type === "request" && frame.params)).toEqual([{}]);
    expect(pending(runtime, env)).toEqual(["account", "carry-over", "your-machines", "forges", "key-manager", "memory-bank", "skills", "instructions", "browser", "permissions", "appearance"]);
    checks.answer([doneResult("account", { checkedAt: after(500) }), doneResult("permissions", { checkedAt: after(500) })]);
    await all;
    expect(pending(runtime, env)).toEqual([]);
    expect(runtime.projections.setup(env).read().counts).toEqual({ registered: 2, done: 2, needsAttention: 0, skipped: 0, attention: [] });

    const seen: string[][] = [];
    onTestFinished(runtime.projections.setup(env).subscribe(() => seen.push(pending(runtime, env))));
    const quick = runtime.setup.check(env, "account");
    clock.advance(499);
    await flush();
    checks.answer([doneResult("account", { checkedAt: after(999) })]);
    await quick;
    clock.advance(1_000);
    await flush();
    expect(seen.flat()).toEqual([]);
  });
});

describe("an environment without the setup flag", () => {
  /** A runtime paired with a scripted environment that offers no `setup` flag, whose snapshot carries no `setup`, answering every `setup.check` with Account done and Permissions needing attention. */
  const flagless = async () => {
    const made = await paired({ capabilities: [] });
    made.environment.snapshot(2, { status: STATUS });
    made.environment.synchronized(2);
    await made.adding;
    await flush();
    made.wire.answer("setup.check", () => ({ result: { results: [doneResult("account"), attentionResult("permissions", "permissions.denylist", ["restore"])] } }));
    return made;
  };

  it("is asked setup.check for every step when the projection is first followed, again on check, and again when it is followed afresh", async () => {
    const { runtime, wire, env } = await flagless();
    const setup = runtime.projections.setup(env);
    expect(setup.read().counts.registered).toBe(0);
    await flush();
    expect(checksSent(wire)).toEqual([]);

    const stop = setup.subscribe(() => undefined);
    await flush();
    expect(checksSent(wire).map((frame) => frame.type === "request" && frame.params)).toEqual([{}]);
    expect(rows(runtime, env).filter((row) => row.registered)).toEqual([
      { id: "account", registered: true, result: { state: "done", reason: "account holds.", stale: false } },
      { id: "permissions", registered: true, result: { state: "needs-attention", reason: "permissions.denylist does not hold.", stale: false } },
    ]);
    const second = setup.subscribe(() => undefined);
    await flush();
    expect(checksSent(wire)).toHaveLength(1);

    expect(await runtime.setup.check(env)).toMatchObject({ ok: true });
    expect(checksSent(wire)).toHaveLength(2);

    // Set up closed and opened again.
    stop();
    second();
    onTestFinished(setup.subscribe(() => undefined));
    await flush();
    expect(checksSent(wire)).toHaveLength(3);
  });

  it("followed while it cannot be reached, is asked once it is", async () => {
    const { runtime, wire, clock, env } = await flagless();
    wire.server.drop();
    await flush();
    onTestFinished(runtime.projections.setup(env).subscribe(() => undefined));
    await flush();
    expect(runtime.connections.list.read()[0]?.phase).toBe("backoff");

    clock.advance(1_250);
    await wire.server.accept();
    await flush();
    expect(checksSent(wire)).toEqual([]);
    (await subscription(wire, "sessions.subscribe")).synchronized(0);
    (await subscription(wire, "environment.subscribe")).synchronized(2);
    await flush();
    expect(runtime.connections.list.read()[0]?.phase).toBe("ready");
    expect(checksSent(wire).map((frame) => frame.type === "request" && frame.params)).toEqual([{}]);
    expect(runtime.projections.setup(env).read().counts).toEqual({ registered: 2, done: 1, needsAttention: 1, skipped: 0, attention: ["permissions"] });
  });
});

/** Each registered step's id, its result's state and checked-at, and whether it is stale. */
const held = (runtime: Runtime, env: string) =>
  runtime.projections.setup(env).read().steps.flatMap((step) => (step.result === null ? [] : [{ id: step.id, state: step.result.state, checkedAt: step.result.checkedAt, stale: step.result.stale }]));

describe("an environment this client cannot reach", () => {
  it("reads unreachable since the connection lost it, every result it holds stale with its checked-at, and fresh again once its stream is live", async () => {
    const { runtime, wire, clock, env } = await withResults();
    wire.answer("setup.check", () => ({ result: { results: [attentionResult("permissions", "permissions.denylist", ["restore"], { checkedAt: after(1_000) })] } }));
    clock.advance(1_000);
    await runtime.setup.check(env, "permissions");
    expect(runtime.projections.setup(env).read().reach).toEqual({ status: "reachable" });

    clock.advance(4_000);
    wire.server.drop();
    await flush();
    expect(runtime.projections.setup(env).read().reach).toEqual({ status: "unreachable", phase: "backoff", since: after(5_000) });
    expect(held(runtime, env)).toEqual([
      { id: "account", state: "done", checkedAt: after(0), stale: true },
      { id: "permissions", state: "needs-attention", checkedAt: after(1_000), stale: true },
    ]);
    expect(runtime.projections.setup(env).read().counts).toEqual({ registered: 2, done: 1, needsAttention: 1, skipped: 0, attention: ["permissions"] });

    // Reached again: still stale while the stream catches up, fresh once it is live.
    clock.advance(1_250);
    await wire.server.accept();
    (await subscription(wire, "sessions.subscribe")).synchronized(0);
    const environment = await subscription(wire, "environment.subscribe");
    await flush();
    expect(runtime.projections.setup(env).read().reach).toEqual({ status: "reachable" });
    expect(held(runtime, env).map((row) => row.stale)).toEqual([true, false]);
    environment.synchronized(3);
    await flush();
    expect(held(runtime, env).map((row) => row.stale)).toEqual([false, false]);
  });

  it("with the local environment's service down, reads service down from a restarted client's cache, stale, offering start-service, which connections.startService answers", async () => {
    const clock = manualClock();
    const wire = fakeWire({ clock, name: "desk", capabilities: ["setup"] });
    for (const method of ["sessions.subscribe", "environment.subscribe"]) wire.answer(method, () => undefined);
    const shell = fakeShell();
    const local = (documents?: InMemoryDocumentStore) => {
      const platform = inMemoryPlatform({ clock, kind: "desktop", grant: wire.grant, shell, fetch: wire.fetch, webSocket: wire.webSocket, ...(documents && { documents }) });
      const { runtime } = createRuntimeWithSeams(platform);
      onTestFinished(() => runtime.close());
      return { platform, runtime };
    };
    const env = wire.environmentId;

    const first = local();
    const starting = first.runtime.start();
    await wire.server.accept();
    (await subscription(wire, "sessions.subscribe")).synchronized(0);
    const environment = await subscription(wire, "environment.subscribe");
    environment.snapshot(3, { status: STATUS, setup: [doneResult("account"), attentionResult("permissions", "permissions.denylist", ["restore"])] });
    environment.synchronized(3);
    await starting;
    await flush();
    expect(held(first.runtime, env).map((row) => row.stale)).toEqual([false, false]);
    await first.runtime.close();

    clock.advance(60_000);
    wire.discovery("unreachable");
    const again = local(first.platform.documents);
    await again.runtime.start();
    const setup = again.runtime.projections.setup(env);
    onTestFinished(setup.subscribe(() => undefined));
    expect(setup.read().reach).toEqual({ status: "service-down", since: after(60_000), action: "start-service" });
    expect(held(again.runtime, env)).toEqual([
      { id: "account", state: "done", checkedAt: after(0), stale: true },
      { id: "permissions", state: "needs-attention", checkedAt: after(0), stale: true },
    ]);

    wire.discovery({});
    const startingService = again.runtime.connections.startService(env);
    await wire.server.accept();
    (await subscription(wire, "sessions.subscribe")).synchronized(0);
    (await subscription(wire, "environment.subscribe")).synchronized(3);
    await startingService;
    await flush();
    expect(shell.calls).toContainEqual(["service.start"]);
    expect(setup.read().reach).toEqual({ status: "reachable" });
    expect(held(again.runtime, env).map((row) => row.stale)).toEqual([false, false]);
    expect(checksSent(wire)).toEqual([]);
  });
});

describe("each result's age", () => {
  const MINUTE = 60_000;

  /** Each registered step's id, its result's age and whether that is older than the step's cadence. */
  const ages = (runtime: Runtime, env: string) =>
    runtime.projections.setup(env).read().steps.flatMap((step) => (step.result === null ? [] : [[step.id, step.result.ageMs, step.result.olderThanCadence]]));

  it("is counted on the environment's clock, and passes the step's cadence as that time passes, with no event", async () => {
    const { runtime, clock, env, environment, adding } = await paired({ skewMs: 10 * MINUTE });
    // Checked ten minutes ago as the environment tells the time, which runs ten minutes ahead of this client's.
    environment.snapshot(3, { status: STATUS, setup: [doneResult("account"), skippedResult("forges")] });
    environment.synchronized(3);
    await adding;
    onTestFinished(runtime.projections.setup(env).subscribe(() => undefined));
    await flush();
    expect(ages(runtime, env)).toEqual([
      ["account", 10 * MINUTE, false],
      ["forges", 10 * MINUTE, false],
    ]);

    // Forges' cadence is fifteen minutes (its forge accounts' status); Account's the hour.
    clock.advance(5 * MINUTE + 1);
    await flush();
    expect(ages(runtime, env)).toEqual([
      ["account", 15 * MINUTE + 1, false],
      ["forges", 15 * MINUTE + 1, true],
    ]);
    // Past its cadence, the age keeps being counted, a minute at a time.
    clock.advance(MINUTE);
    await flush();
    expect(ages(runtime, env)).toEqual([
      ["account", 16 * MINUTE + 1, false],
      ["forges", 16 * MINUTE + 1, true],
    ]);
    clock.advance(44 * MINUTE);
    await flush();
    expect(ages(runtime, env)).toEqual([
      ["account", 60 * MINUTE + 1, true],
      ["forges", 60 * MINUTE + 1, true],
    ]);
  });
});
