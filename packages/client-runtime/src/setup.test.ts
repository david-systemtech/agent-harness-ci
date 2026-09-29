import type { EnvironmentStatus } from "@agent-harness/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { noticeEvent } from "../test/events.js";
import { subscription, type Scripted } from "../test/scripted.js";
import { attentionResult, doneResult } from "../test/setup.js";
import { createRuntimeWithSeams } from "./internal.js";
import type { Runtime } from "./runtime.js";
import { fakeWire, flush, type FakeWire } from "./testing/fake-wire.js";
import { inMemoryPlatform, manualClock } from "./testing/in-memory-platform.js";

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
const paired = async (options: { readonly capabilities?: readonly string[] } = {}) => {
  const clock = manualClock();
  const wire: FakeWire = fakeWire({ clock, name: "desk", capabilities: [...(options.capabilities ?? ["setup"])] });
  wire.answer("sessions.subscribe", () => undefined);
  wire.answer("environment.subscribe", () => undefined);
  const platform = inMemoryPlatform({ clock, fetch: wire.fetch, webSocket: wire.webSocket });
  const { runtime } = createRuntimeWithSeams(platform);
  onTestFinished(() => runtime.close());
  await runtime.start();
  const adding = runtime.connections.add({ link: wire.link });
  await wire.server.accept();
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
