import { randomUUID } from "node:crypto";
import { registry } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { fakeAdapter, type FakeAdapter, type FakeAdapterOptions } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * The process environment through the primary seam (forge spec, "Per
 * provider process"; #307): an in-process environment with the scripted
 * fake adapter, which reports the variables its process was given and runs
 * a scripted command in them, driven by a real client. What is asserted is
 * what the fake was handed and what its process was given, what a test
 * supplier was asked and released, and what the log and the data directory
 * hold, never the registry's own state.
 */

const { onCleanup } = useCleanups();

const start = async (adapter: FakeAdapterOptions | FakeAdapter = {}, options: Omit<TestEnvironmentOptions, "adapter"> = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ ...options, adapter: "descriptor" in adapter ? adapter : fakeAdapter(adapter) });
  onCleanup(() => t.close());
  return t;
};

const ended = (t: TestEnvironment, sessionId: string) => t.env.log.readStream({ kind: "session", id: sessionId }).filter((event) => event.type === "run.ended");

/** Starts a run on the session and waits for its end. */
const runTo = async (t: TestEnvironment, client: WireClient, sessionId: string, text = "Fix the receipts") => {
  const before = ended(t, sessionId).length;
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text }));
  if (answer.result === undefined) throw new Error(`runs.start was refused: ${JSON.stringify(answer.receipt)}`);
  await vi.waitFor(() => expect(ended(t, sessionId)).toHaveLength(before + 1));
  return answer.result;
};

describe("a run's process environment", () => {
  it("has an empty key and adds nothing while no supplier is registered", async () => {
    const t = await start();
    const client = await t.client();
    const session = await create(client);

    await runTo(t, client, session.id);

    expect(t.adapter.lastRun().input.processEnvironment.key).toBe("");
    const [process] = t.adapter.processesOf(session.id);
    expect(await process?.supplied).toEqual({});
  });
});
