import { STEP_ORDER, pastTimeWords, type EnvironmentStatus, type StepResult } from "@agent-harness/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { after } from "../test/environments.js";
import { noticeEvent } from "../test/events.js";
import { subscription, type Scripted } from "../test/scripted.js";
import { attentionResult, doneResult, skippedResult } from "../test/setup.js";
import { createRuntimeWithSeams } from "./internal.js";
import type { Runtime } from "./runtime.js";
import { fakeWire, flush, type FakeWire } from "./testing/fake-wire.js";
import { countsWords, rowHealth, stepLine, stepNote } from "./setup/checklist.js";
import { fakeShell, inMemoryDocuments, inMemoryPlatform, inMemorySecrets, MANUAL_CLOCK_START, manualClock, type InMemoryDocumentStore } from "./testing/in-memory-platform.js";
import { whenWords } from "./transcript/format.js";

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
    // Raw, as the environment sends them: a newer one's may not read as this build's `StepResult` (#693).
    answer: (results: readonly unknown[]) => waiting.shift()?.({ result: { results: results as StepResult[] } }),
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
  it("keeps scheduled reads neutral, excludes them from attention, and follows completion", async () => {
    const { runtime, env, environment, adding } = await paired();
    const pending = { ...doneResult("your-machines"), state: "pending", reason: "Waiting for the first release channel read." };
    environment.snapshot(3, { status: STATUS, setup: [doneResult("account"), pending] });
    environment.synchronized(3);
    await adding;
    await flush();
    const setup = runtime.projections.setup(env);
    expect(setup.read().counts).toEqual({ registered: 2, done: 1, needsAttention: 0, skipped: 0, attention: [] });
    expect(rowHealth(setup.read(), "environments.machines")).toBe("pending");
    expect(rowHealth(setup.read(), "setup.checklist")).toBe("pending");
    expect(countsWords(setup.read().counts)).toBe("1 done · 0 need a fix · 0 not set up · 1 checking");
    environment.event(noticeEvent(4, env, "setup.result-changed", doneResult("your-machines")));
    await flush();
    expect(rowHealth(setup.read(), "environments.machines")).toBe("done");
    expect(setup.read().counts.done).toBe(2);
  });

  it("lists the eleven steps in order with their labels, home rows and whether each may be skipped, fills from the snapshot's setup and applies each notice, with no call of its own", async () => {
    const { runtime, wire, env, environment, adding } = await paired();
    const setup = runtime.projections.setup(env);
    const seen: unknown[] = [];
    onTestFinished(setup.subscribe((view) => seen.push(view)));
    const permissions = attentionResult("permissions", "permissions.denylist", ["restore"]);
    environment.snapshot(3, { status: STATUS, setup: [doneResult("account"), permissions] });
    environment.synchronized(3);
    await adding;
    await flush();

    // Skippable as this build's registry says: Carry over, Forges, Key manager, Memory bank, Skills and Browser; a step it lacks is not (#573).
    expect(setup.read().steps.map(({ id, label, home, skippable }) => [id, label, home, skippable])).toEqual([
      ["account", "Account", "accounts.accounts", false],
      ["carry-over", "Carry over", "accounts.accounts", true],
      ["your-machines", "Your machines", "environments.machines", false],
      ["forges", "Forges", "access.forges", true],
      ["key-manager", "Key manager", "access.key-managers", true],
      ["memory-bank", "Memory bank", "knowledge.banks", true],
      ["skills", "Skills", "knowledge.skills", true],
      ["instructions", "Instructions", "knowledge.instructions", false],
      ["browser", "Browser", "access.browser", true],
      ["permissions", "Permissions", "access.permissions", false],
      ["appearance", "Appearance", "appearance.theme", false],
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

describe("the environment stream's results", () => {
  it("fold from the notices a replay from the cursor carries, with no snapshot", async () => {
    const { runtime, env, environment, adding } = await paired();
    environment.event(noticeEvent(1, env, "setup.result-changed", attentionResult("permissions", "permissions.denylist", ["restore"])));
    environment.event(noticeEvent(2, env, "setup.result-changed", doneResult("account")));
    environment.event(noticeEvent(3, env, "setup.result-changed", doneResult("permissions", { checkedAt: after(3_000) })));
    environment.synchronized(3);
    await adding;
    await flush();
    expect(rows(runtime, env).filter((row) => row.registered)).toEqual([
      { id: "account", registered: true, result: { state: "done", reason: "account holds.", stale: false } },
      { id: "permissions", registered: true, result: { state: "done", reason: "permissions holds.", stale: false } },
    ]);
  });

  it("read a newer environment's results of steps this build does not register, from the snapshot and the notices, and leave out one this build cannot read (#672)", async () => {
    const { runtime, platform, env, environment, adding } = await paired();
    // Skills has no entry in this build's registry; a step past the milestone-1 order is no step it knows.
    const sources = doneResult("skills", { reason: "Every source is pulled." });
    const later = { ...doneResult("account"), step: "housekeeping", reason: "Nothing to sweep." };
    environment.snapshot(3, { status: STATUS, setup: [doneResult("account"), sources, later] });
    environment.synchronized(3);
    await adding;
    await flush();
    expect(rows(runtime, env).filter((row) => row.registered)).toEqual([
      { id: "account", registered: true, result: { state: "done", reason: "account holds.", stale: false } },
      { id: "skills", registered: true, result: { state: "done", reason: "Every source is pulled.", stale: false } },
    ]);

    environment.event(noticeEvent(4, env, "setup.result-changed", attentionResult("skills", "skills.pulled", ["pull-now"], { checkedAt: after(4_000) })));
    await flush();
    expect(resultOf(runtime, env, "skills")).toMatchObject({ state: "needs-attention", actions: ["pull-now"], stale: false });
    expect(runtime.projections.setup(env).read().counts).toEqual({ registered: 2, done: 1, needsAttention: 1, skipped: 0, attention: ["skills"] });
    expect(platform.reported).toEqual([]);
  });

  it("read a newer environment's result offering a verb or naming a kind of item this build does not know, from the snapshot and a notice, leaving out only that part (#693)", async () => {
    const { runtime, platform, env, environment, adding } = await paired();
    const tool = { action: "install", kind: "tool", id: "gh", label: "gh" };
    const forges = {
      ...attentionResult("forges", "forges.gh", ["install"]),
      actions: ["install", "link-gh"],
      targets: [tool, { action: "link-gh", kind: "tool", id: "gh", label: "gh" }],
    };
    environment.snapshot(3, { status: STATUS, setup: [doneResult("account"), forges] });
    environment.synchronized(3);
    await adding;
    await flush();
    expect(resultOf(runtime, env, "forges")).toMatchObject({ state: "needs-attention", actions: ["install"], targets: [tool], stale: false });

    const skills = { ...attentionResult("skills", "skills.pulled", ["pull-now"], { checkedAt: after(4_000) }), targets: [{ action: "pull-now", kind: "skill-feed", id: "feed-1", label: "team feed" }] };
    environment.event(noticeEvent(4, env, "setup.result-changed", skills));
    await flush();
    expect(resultOf(runtime, env, "skills")).toMatchObject({ state: "needs-attention", reason: "skills.pulled does not hold.", actions: [], stale: false });
    expect(runtime.projections.setup(env).read().counts).toEqual({ registered: 3, done: 1, needsAttention: 2, skipped: 0, attention: ["forges", "skills"] });
    expect(platform.reported).toEqual([]);
  });

  /** A runtime that cached the environment stream at its snapshot at 3, restarted on a copy of its documents with `edit` applied to the cached state. */
  const reopened = async (edit: (state: Record<string, unknown>) => void) => {
    const clock = manualClock();
    const wire = fakeWire({ clock, name: "desk", capabilities: ["setup"] });
    for (const method of ["sessions.subscribe", "environment.subscribe"]) wire.answer(method, () => undefined);
    const documents = inMemoryDocuments();
    const secrets = inMemorySecrets();
    const runtimeOn = () => {
      const platform = inMemoryPlatform({ clock, documents, secrets, fetch: wire.fetch, webSocket: wire.webSocket });
      const { runtime } = createRuntimeWithSeams(platform);
      onTestFinished(() => runtime.close());
      return { platform, runtime };
    };
    const first = runtimeOn();
    await first.runtime.start();
    const adding = first.runtime.connections.add({ link: wire.link });
    await wire.server.accept();
    (await subscription(wire, "sessions.subscribe")).synchronized(0);
    const environment = await subscription(wire, "environment.subscribe");
    environment.snapshot(3, { status: STATUS, setup: [doneResult("account")] });
    environment.synchronized(3);
    await adding;
    await first.runtime.close();

    // The stream's document: `{format, sequence, snapshot}`, the kind's stored form `{status, setup}` in it.
    const key = `streams.${wire.environmentId}.environment`;
    const document = structuredClone(documents.entries()[key]) as { sequence: number; snapshot: Record<string, unknown> };
    expect(document.sequence).toBe(3);
    edit(document.snapshot);
    await documents.set(key, document);

    const again = runtimeOn();
    const starting = again.runtime.start();
    await wire.server.accept();
    (await subscription(wire, "sessions.subscribe")).synchronized(0);
    const resumed = await subscription(wire, "environment.subscribe");
    await starting;
    return { again, afterSequence: resumed.params["afterSequence"] };
  };

  it("read from a cached document this build wrote, and the stream resubscribes from its cursor", async () => {
    const { again, afterSequence } = await reopened(() => undefined);
    expect(afterSequence).toBe(3);
    expect(again.platform.reported).toEqual([]);
  });

  it("are none in a cached document from before them, which does not read, so the stream subscribes from nothing rather than read as never checked what was", async () => {
    const { again, afterSequence } = await reopened((state) => {
      delete state["setup"];
    });
    expect(afterSequence).toBe(0);
    expect(again.platform.reported).toHaveLength(1);
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

  it("reads as asked a result its check changed, which the environment notices too, and as followed one a later check noticed with the same checked-at (#671)", async () => {
    const { runtime, wire, env, environment } = await withResults();
    const checks = heldChecks(wire);
    const fixed = doneResult("permissions", { reason: "The denylist holds its presets.", checkedAt: after(1) });
    const checking = runtime.setup.check(env, "permissions");
    await flush();
    // The check put the denylist right: the environment notices it, and answers it.
    environment.event(noticeEvent(4, env, "setup.result-changed", fixed));
    await flush();
    expect(resultOf(runtime, env, "permissions")).toMatchObject({ state: "done", asked: false });
    checks.answer([fixed]);
    expect(await checking).toMatchObject({ ok: true });
    expect(resultOf(runtime, env, "permissions")).toMatchObject({ state: "done", checkedAt: after(1), asked: true });

    // Another client's check, on a clock that has not moved: the stream's shows, followed.
    environment.event(noticeEvent(5, env, "setup.result-changed", attentionResult("permissions", "permissions.denylist", ["restore"], { checkedAt: after(1) })));
    await flush();
    expect(resultOf(runtime, env, "permissions")).toMatchObject({ state: "needs-attention", checkedAt: after(1), asked: false });
  });

  it("applies a newer environment's answer whole, its results of steps this build does not register beside the rest, each aged against the preset cadence (#672)", async () => {
    const { runtime, wire, clock, env } = await withResults();
    const checks = heldChecks(wire);
    const all = runtime.setup.check(env);
    await flush();
    // An environment that registers every step of the order, the ones this build's registry lacks included.
    const skills = attentionResult("skills", "skills.pulled", ["pull-now"], { checkedAt: after(1) });
    checks.answer(STEP_ORDER.map((step) => (step === "skills" ? skills : doneResult(step, { checkedAt: after(1) }))));
    expect(await all).toMatchObject({ ok: true });
    const view = runtime.projections.setup(env).read();
    expect(view.steps.map((step) => [step.id, step.registered, step.result?.state])).toEqual([
      ["account", true, "done"],
      ["carry-over", true, "done"],
      ["your-machines", true, "done"],
      ["forges", true, "done"],
      ["key-manager", true, "done"],
      ["memory-bank", true, "done"],
      ["skills", true, "needs-attention"],
      ["instructions", true, "done"],
      ["browser", true, "done"],
      ["permissions", true, "done"],
      ["appearance", true, "done"],
    ]);
    expect(resultOf(runtime, env, "skills")).toMatchObject({ ...skills, asked: true, stale: false, olderThanCadence: false });
    expect(view.counts).toEqual({ registered: 11, done: 10, needsAttention: 1, skipped: 0, attention: ["skills"] });

    // No cadence of this build's own for it: it ages against the hour a step has unless it gives another, past which
    // the environment has checked it again unasked, so it reads as followed (#671).
    clock.advance(60 * 60_000);
    await flush();
    expect(resultOf(runtime, env, "skills")).toMatchObject({ asked: true, olderThanCadence: false });
    clock.advance(2);
    await flush();
    expect(resultOf(runtime, env, "skills")).toMatchObject({ asked: false, olderThanCadence: false });
  });

  it("applies a newer environment's answer whole, leaving out only what its vocabulary has and this build's lacks: a verb, a kind of item, a later milestone's step (#693)", async () => {
    const { runtime, wire, env } = await withResults();
    const checks = heldChecks(wire);
    const all = runtime.setup.check(env);
    await flush();
    const forgeAccount = { action: "sign-in-again", kind: "forge-account", id: "https://git.example.com", label: "david on git.example.com" };
    const calendar = { action: "sign-in-again", kind: "calendar-account", id: "calendar-work", label: "Work calendar" };
    const forges = {
      ...attentionResult("forges", "forges.identity", ["sign-in-again", "check-again"], { checkedAt: after(1) }),
      actions: ["rotate-token", "sign-in-again", "check-again"],
      targets: [calendar, forgeAccount],
    };
    // Restore names only a section of a kind this build does not know: offered on no section, it would restore another.
    const permissions = { ...attentionResult("permissions", "permissions.denylist", ["restore"], { checkedAt: after(1) }), targets: [{ action: "restore", kind: "denylist-folder", id: "paths", label: "Paths" }] };
    const housekeeping = { ...doneResult("account", { checkedAt: after(1) }), step: "housekeeping", reason: "Nothing to sweep." };
    checks.answer([doneResult("account", { checkedAt: after(1) }), forges, housekeeping, permissions]);

    expect(await all).toMatchObject({ ok: true });
    expect(resultOf(runtime, env, "forges")).toMatchObject({ state: "needs-attention", actions: ["sign-in-again", "check-again"], targets: [forgeAccount], stale: false });
    expect(resultOf(runtime, env, "permissions")).toMatchObject({ state: "needs-attention", reason: "permissions.denylist does not hold.", actions: [], checkedAt: after(1) });
    expect(resultOf(runtime, env, "permissions")).not.toHaveProperty("targets");
    expect(runtime.projections.setup(env).read().counts).toEqual({ registered: 3, done: 1, needsAttention: 2, skipped: 0, attention: ["forges", "permissions"] });
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

  it("waits for its answer past the request path's thirty seconds, as long as the longest check budget and those thirty seconds, then fails as timed out", async () => {
    const { runtime, wire, clock, env } = await withResults();
    const checks = heldChecks(wire);
    const slow = runtime.setup.check(env, "permissions");
    clock.advance(45_000);
    await flush();
    expect(pending(runtime, env)).toEqual(["permissions"]);
    checks.answer([doneResult("permissions", { checkedAt: after(45_000) })]);
    expect(await slow).toMatchObject({ ok: true });
    expect(resultOf(runtime, env, "permissions")).toMatchObject({ state: "done", checkedAt: after(45_000) });

    const unanswered = runtime.setup.check(env, "account");
    clock.advance(59_999);
    await flush();
    expect(pending(runtime, env)).toEqual(["account"]);
    clock.advance(1);
    expect(await unanswered).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(pending(runtime, env)).toEqual([]);
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

  it("reads a step missing only once an answer about every step leaves it out, never while its result is on its way or after a check of one step", async () => {
    const { runtime, wire, env } = await withResults();
    const missing = () => runtime.projections.setup(env).read().steps.flatMap((step) => (step.missing ? [step.id] : []));
    const checks = heldChecks(wire);
    expect(missing()).toEqual([]);

    const one = runtime.setup.check(env, "forges");
    checks.answer([doneResult("forges", { checkedAt: after(1) })]);
    await one;
    expect(missing()).toEqual([]);

    const all = runtime.setup.check(env);
    await flush();
    expect(missing()).toEqual([]);
    checks.answer([doneResult("account", { checkedAt: after(2) }), doneResult("forges", { checkedAt: after(2) }), doneResult("permissions", { checkedAt: after(2) })]);
    await all;
    expect(missing()).toEqual(["carry-over", "your-machines", "key-manager", "memory-bank", "skills", "instructions", "browser", "appearance"]);

    const again = runtime.setup.check(env);
    checks.answer((["account", "forges", "key-manager", "permissions"] as const).map((id) => doneResult(id, { checkedAt: after(3) })));
    await again;
    expect(missing()).toEqual(["carry-over", "your-machines", "memory-bank", "skills", "instructions", "browser", "appearance"]);
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

  /** Each registered step's id, its result's age, whether this client asked for it, and whether it is older than the step's cadence. */
  const ages = (runtime: Runtime, env: string) =>
    runtime.projections.setup(env).read().steps.flatMap((step) => (step.result === null ? [] : [[step.id, step.result.ageMs, step.result.asked, step.result.olderThanCadence]]));

  /** One registered step's line as a renderer words it now. */
  const lineOf = (runtime: Runtime, env: string, id: string) => {
    const step = runtime.projections.setup(env).read().steps.find((one) => one.id === id);
    return step === undefined ? undefined : stepLine(step, runtime.environmentNow(env));
  };

  /** That step's muted second line: when it was checked, or that nothing changed since. */
  const noteOf = (runtime: Runtime, env: string, id: string) => {
    const step = runtime.projections.setup(env).read().steps.find((one) => one.id === id);
    return step === undefined ? undefined : stepNote(step, runtime.environmentNow(env), "desk");
  };

  it("is counted on the environment's clock for a followed result, which reads unchanged since its checked-at and never older than its cadence, as nothing is heard of a re-check that finds nothing new (#671)", async () => {
    const { runtime, clock, env, environment, adding } = await paired({ skewMs: 10 * MINUTE });
    // Checked ten minutes ago as the environment tells the time, which runs ten minutes ahead of this client's.
    environment.snapshot(3, { status: STATUS, setup: [doneResult("your-machines"), skippedResult("forges")] });
    environment.synchronized(3);
    await adding;
    onTestFinished(runtime.projections.setup(env).subscribe(() => undefined));
    await flush();
    expect(ages(runtime, env)).toEqual([
      ["your-machines", 10 * MINUTE, false, false],
      ["forges", 10 * MINUTE, false, false],
    ]);
    const unchanged = `No change since ${whenWords(MANUAL_CLOCK_START, runtime.environmentNow(env))}.`;
    expect([lineOf(runtime, env, "your-machines"), noteOf(runtime, env, "your-machines")]).toEqual(["your-machines holds.", unchanged]);

    // Past Forges' fifteen minutes and Your machines' hour, with no event, each says the same.
    clock.advance(60 * MINUTE);
    await flush();
    expect([lineOf(runtime, env, "your-machines"), noteOf(runtime, env, "your-machines")]).toEqual(["your-machines holds.", unchanged]);
    expect(runtime.projections.setup(env).read().steps.find((step) => step.id === "forges")?.result).toMatchObject({ asked: false, olderThanCadence: false });
  });

  it("is counted on the environment's clock for an answer of this client's own, which past its step's cadence reads its age, counted again a minute at a time, on an environment without the setup flag", async () => {
    const { runtime, clock, env, environment, adding, wire } = await paired({ capabilities: [], skewMs: 10 * MINUTE });
    environment.snapshot(2, { status: STATUS });
    environment.synchronized(2);
    await adding;
    // Checked ten minutes ago as the environment tells the time, which runs ten minutes ahead of this client's.
    wire.answer("setup.check", () => ({ result: { results: [doneResult("your-machines"), skippedResult("forges")] } }));
    onTestFinished(runtime.projections.setup(env).subscribe(() => undefined));
    await flush();
    expect(ages(runtime, env)).toEqual([
      ["your-machines", 10 * MINUTE, true, false],
      ["forges", 10 * MINUTE, true, false],
    ]);
    expect([lineOf(runtime, env, "your-machines"), noteOf(runtime, env, "your-machines")]).toEqual(["your-machines holds.", undefined]);

    // Forges' cadence is fifteen minutes (its forge accounts' status); Your machines' the hour.
    clock.advance(5 * MINUTE + 1);
    await flush();
    expect(ages(runtime, env)).toEqual([
      ["your-machines", 15 * MINUTE + 1, true, false],
      ["forges", 15 * MINUTE + 1, true, true],
    ]);
    // Past its cadence, the age keeps being counted, a minute at a time.
    clock.advance(MINUTE);
    await flush();
    expect(ages(runtime, env)).toEqual([
      ["your-machines", 16 * MINUTE + 1, true, false],
      ["forges", 16 * MINUTE + 1, true, true],
    ]);
    expect([lineOf(runtime, env, "forges"), noteOf(runtime, env, "forges")]).toEqual(["Nothing is set up for forges.", "Last checked 16 min ago."]);
    clock.advance(44 * MINUTE);
    await flush();
    expect(ages(runtime, env)).toEqual([
      ["your-machines", 60 * MINUTE + 1, true, true],
      ["forges", 60 * MINUTE + 1, true, true],
    ]);
    expect([lineOf(runtime, env, "your-machines"), noteOf(runtime, env, "your-machines")]).toEqual(["your-machines holds.", "Last checked 1 h ago."]);
  });

  it("reads an answer of this client's own as followed once its step's cadence has passed on an environment with the setup flag, which has checked it again unasked by then (#671)", async () => {
    const { runtime, clock, env, wire } = await withResults();
    wire.answer("setup.check", () => ({ result: { results: [doneResult("forges", { checkedAt: after(MINUTE) })] } }));
    clock.advance(MINUTE);
    expect(await runtime.setup.check(env, "forges")).toMatchObject({ ok: true });
    expect(resultOf(runtime, env, "forges")).toMatchObject({ asked: true, olderThanCadence: false, stale: false });
    expect([lineOf(runtime, env, "forges"), noteOf(runtime, env, "forges")]).toEqual(["forges holds.", undefined]);

    clock.advance(15 * MINUTE);
    await flush();
    expect(resultOf(runtime, env, "forges")).toMatchObject({ asked: true, olderThanCadence: false });
    clock.advance(1);
    await flush();
    expect(resultOf(runtime, env, "forges")).toMatchObject({ asked: false, olderThanCadence: false, stale: false });
    expect([lineOf(runtime, env, "forges"), noteOf(runtime, env, "forges")]).toEqual(["forges holds.", `No change since ${whenWords(after(MINUTE), runtime.environmentNow(env))}.`]);
  });

  it("words a time its reason names as this client words a past time, in place of the environment's words for it, counted again a minute at a time while the result is followed (#1742)", async () => {
    const { runtime, clock, env, environment, adding } = await paired();
    const polledAt = "2026-09-23T22:00:00.000Z";
    const polled = attentionResult("your-machines", "your-machines.host-updater", ["check-again"], {
      reason: "The host-side updater last polled more than an hour ago, at 2026-09-23 22:00 UTC: check that it still runs.",
      times: [{ text: "more than an hour ago, at 2026-09-23 22:00 UTC", at: polledAt }],
    });
    environment.snapshot(3, { status: STATUS, setup: [polled] });
    environment.synchronized(3);
    await adding;
    onTestFinished(runtime.projections.setup(env).subscribe(() => undefined));
    await flush();
    const line = () => lineOf(runtime, env, "your-machines");
    expect(line()).toBe(`The host-side updater last polled ${pastTimeWords(polledAt, runtime.environmentNow(env))}: check that it still runs.`);
    expect(line()).toMatch(/^The host-side updater last polled 2 h ago, at [^:]+:\d\d: /);
    expect(line()).not.toContain("UTC");

    // Nothing is heard while nothing changes, yet the age the line says moves on.
    clock.advance(60 * MINUTE);
    await flush();
    expect(line()).toMatch(/^The host-side updater last polled 3 h ago, at /);
  });
});
