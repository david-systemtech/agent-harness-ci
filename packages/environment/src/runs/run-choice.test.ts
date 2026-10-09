import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { registry, type ParamsOf, type ResponseOf } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { end, fakeAdapter, gate, say, type FakeAdapter, type FakeAdapterOptions, type Gate } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, get, refusal } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * A session's next-run model and effort are the session's own (#1961):
 * `sessions.setModel` records them, the summary's `runChoice` names them,
 * and a run whose command names no model goes out on them, after a client
 * relaunch and an environment restart alike. Through the primary seam: an
 * in-process environment with the scripted fake adapter (opus with
 * low, medium, high and max; sonnet with low, medium and high; haiku with
 * none) and a real client over a real WebSocket.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (adapter: FakeAdapterOptions | FakeAdapter = {}, options: Omit<TestEnvironmentOptions, "adapter"> = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ ...options, adapter: "descriptor" in adapter ? adapter : fakeAdapter(adapter) });
  onCleanup(() => t.close());
  return t;
};

const setModel = async (client: WireClient, sessionId: string, model: string, effort: string | null): Promise<ResponseOf<"sessions.setModel">> =>
  registry["sessions.setModel"].response.parse(await client.request("sessions.setModel", { commandId: randomUUID(), sessionId, model, effort }));

const setDefaultEffort = (client: WireClient, effort: string) =>
  client.request("settings.update", { commandId: randomUUID(), values: { "accounts.defaultEffort": effort } });

/** Starts a run and waits for the provider to be asked for it; resolves with what the run went out on. */
const runOn = async (t: TestEnvironment, client: WireClient, sessionId: string, extra: Partial<ParamsOf<"runs.start">> = {}) => {
  const before = t.adapter.runs.length;
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text: "Go", ...extra }));
  if (answer.result === undefined) throw new Error(`runs.start was not applied: ${JSON.stringify(answer.receipt)}`);
  const { input } = await t.adapter.reached(before + 1);
  return { model: input.model, effort: input.effort };
};

/** Waits until the session has no run live. */
const idle = (client: WireClient, sessionId: string) => vi.waitFor(async () => expect((await get(client, sessionId)).activity.state).toBe("idle"));

/** A script held open until its gate opens. */
const held = (gate: Gate) =>
  async function* () {
    yield say("Working");
    await gate.opened;
    yield end();
  };

describe("sessions.setModel", () => {
  it("keeps the model and effort chosen for a session through an environment restart, and the next run goes out on them", async () => {
    const dataDir = join(tempDir(), "data");
    const first = await startTestEnvironment({ adapter: fakeAdapter(), dataDir });
    const client = await first.client();
    const { id } = await create(client);
    const chosen = await setModel(client, id, "sonnet", "low");
    expect(chosen.receipt).toMatchObject({ status: "accepted", changed: true });
    expect(chosen.result?.summary.runChoice).toEqual({ model: "sonnet", effort: "low" });
    await first.close();

    const again = await start({}, { dataDir });
    const after = await again.client();
    expect((await get(after, id)).runChoice).toEqual({ model: "sonnet", effort: "low" });
    expect(await runOn(again, after, id)).toEqual({ model: "sonnet", effort: "low" });
  });

  it("keeps the model's own effort chosen for a session, whatever accounts.defaultEffort says, before a restart and after it", async () => {
    const dataDir = join(tempDir(), "data");
    const first = await startTestEnvironment({ adapter: fakeAdapter(), dataDir });
    const client = await first.client();
    await setDefaultEffort(client, "high");
    const { id } = await create(client);
    await setModel(client, id, "opus", null);
    expect(await runOn(first, client, id)).toEqual({ model: "opus", effort: null });
    await idle(client, id);
    await first.close();

    const again = await start({}, { dataDir });
    const after = await again.client();
    expect((await get(after, id)).runChoice).toEqual({ model: "opus", effort: null });
    expect(await runOn(again, after, id)).toEqual({ model: "opus", effort: null });
  });

  it("answers the choice the session already has with nothing appended", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    await setModel(client, id, "sonnet", "medium");
    const head = t.env.log.head();
    expect((await setModel(client, id, "sonnet", "medium")).receipt).toMatchObject({ status: "accepted", changed: false });
    expect(t.env.log.head()).toBe(head);
  });

  it("refuses a model the session's account does not list, an effort the model does not take, a session with a run live, and a session not here", async () => {
    const gateOpen = gate();
    const t = await start({ script: held(gateOpen) });
    const client = await t.client();
    const { id } = await create(client);
    const request = (sessionId: string, model: string, effort: string | null) =>
      client.request("sessions.setModel", { commandId: randomUUID(), sessionId, model, effort });
    expect(await refusal(request(id, "gpt", null))).toMatchObject({ code: "invalid_params" });
    expect(await refusal(request(id, "haiku", "high"))).toMatchObject({ code: "invalid_params" });
    const gone = randomUUID();
    expect((await setModel(client, gone, "sonnet", null)).receipt).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "session", sessionId: gone } } });
    await runOn(t, client, id);
    expect((await setModel(client, id, "sonnet", null)).receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "run_active", sessionId: id } } });
    expect((await get(client, id)).runChoice).toMatchObject({ model: "opus" });
    gateOpen.open();
  });
});

describe("a run with no model of its own", () => {
  it("goes out on the model and effort the latest run took, the model's own effort included, which the summary names", async () => {
    const t = await start();
    const client = await t.client();
    await setDefaultEffort(client, "high");
    const { id } = await create(client);
    expect(await runOn(t, client, id, { model: "sonnet", effort: "medium" })).toEqual({ model: "sonnet", effort: "medium" });
    await idle(client, id);
    expect((await get(client, id)).runChoice).toEqual({ model: "sonnet", effort: "medium" });
    expect(await runOn(t, client, id)).toEqual({ model: "sonnet", effort: "medium" });
    await idle(client, id);

    await setModel(client, id, "opus", null);
    await runOn(t, client, id);
    await idle(client, id);
    expect((await get(client, id)).runChoice).toEqual({ model: "opus", effort: null });
    expect(await runOn(t, client, id)).toEqual({ model: "opus", effort: null });
  });

  it("takes the default effort, not the session's, when its command names a model other than the session's", async () => {
    const t = await start();
    const client = await t.client();
    await setDefaultEffort(client, "high");
    const { id } = await create(client);
    await setModel(client, id, "sonnet", "low");
    expect(await runOn(t, client, id, { model: "opus" })).toEqual({ model: "opus", effort: "high" });
  });

  it("goes out from the environment's queue at the model's own effort the run before took, not at the default", async () => {
    const gateOpen = gate();
    const adapter = fakeAdapter({ capabilities: { providerQueue: false, steering: false } });
    adapter.nextScripts.push(held(gateOpen));
    const t = await start(adapter);
    const client = await t.client();
    await setDefaultEffort(client, "high");
    const { id } = await create(client);
    await setModel(client, id, "opus", null);
    expect(await runOn(t, client, id)).toEqual({ model: "opus", effort: null });
    await client.request("runs.send", { commandId: randomUUID(), sessionId: id, text: "And then" });
    gateOpen.open();
    const { input } = await t.adapter.reached(2);
    expect({ model: input.model, effort: input.effort }).toEqual({ model: "opus", effort: null });
  });
});
