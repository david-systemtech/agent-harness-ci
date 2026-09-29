import { randomUUID } from "node:crypto";
import { registry } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { end, fakeAdapter, runCommand, say, type FakeAdapter, type FakeAdapterOptions } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";
import type { ProcessEnvironmentScope, ProcessEnvironmentSupplier } from "./process-environment.js";

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

const events = (t: TestEnvironment, sessionId: string) => t.env.log.readStream({ kind: "session", id: sessionId });
const ended = (t: TestEnvironment, sessionId: string) => events(t, sessionId).filter((event) => event.type === "run.ended");
/** What the session's runs said, as their `assistant.text` recorded it. */
const texts = (t: TestEnvironment, sessionId: string): unknown[] =>
  events(t, sessionId).flatMap((event) => (event.type === "assistant.text" ? [event.payload["text"]] : []));

/** Starts a run on the session and waits for its end. */
const runTo = async (t: TestEnvironment, client: WireClient, sessionId: string, text = "Fix the receipts") => {
  const before = ended(t, sessionId).length;
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text }));
  if (answer.result === undefined) throw new Error(`runs.start was refused: ${JSON.stringify(answer.receipt)}`);
  await vi.waitFor(() => expect(ended(t, sessionId)).toHaveLength(before + 1));
  return answer.result;
};

/**
 * A supplier a test registers: its part of the key names its generation,
 * which `next` raises; each spawn is supplied `variables`. It records the
 * scope it was asked each key and each supply for, and how many times each
 * spawn's release was called.
 */
const testSupplier = (variables: Readonly<Record<string, string>>, name = "test") => {
  const asked = { keys: [] as ProcessEnvironmentScope[], supplies: [] as ProcessEnvironmentScope[], releases: [] as number[] };
  let generation = 1;
  const supplier: ProcessEnvironmentSupplier = {
    name,
    key: (scope) => {
      asked.keys.push(scope);
      return `generation ${generation}`;
    },
    supply: (scope) => {
      const spawn = asked.supplies.push(scope) - 1;
      asked.releases[spawn] = 0;
      return { variables, release: () => void (asked.releases[spawn] = (asked.releases[spawn] ?? 0) + 1) };
    },
  };
  return { supplier, asked, next: () => void (generation += 1) };
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

  it("gives the process a registered supplier's variables, asked once per spawn, and a command the provider runs has them", async () => {
    const t = await start();
    const { supplier, asked } = testSupplier({ HARNESS_TEST_TOKEN: "token-for-tests" });
    t.env.processEnvironments.register(supplier);
    const client = await t.client();
    const session = await create(client);
    t.adapter.nextScripts.push(async function* (controls) {
      const result = yield* runCommand(controls, 'test "$HARNESS_TEST_TOKEN" = token-for-tests && echo matched');
      yield say(`The command said ${result.stdout.trim()}`);
      yield end();
    });

    await runTo(t, client, session.id);
    await runTo(t, client, session.id, "And the refunds");

    const [first, second] = t.adapter.runs;
    expect(first?.input.processEnvironment.key).not.toBe("");
    expect(second?.input.processEnvironment.key).toBe(first?.input.processEnvironment.key);
    // Both runs went to the one process, spawned once and supplied once.
    expect(t.adapter.processesOf(session.id)).toHaveLength(1);
    expect(await t.adapter.processesOf(session.id)[0]?.supplied).toEqual({ HARNESS_TEST_TOKEN: "token-for-tests" });
    expect(asked.supplies).toEqual([{ sessionId: session.id, accountId: "claude-max", origin: "client" }]);
    expect(texts(t, session.id)).toContain("The command said matched");
  });
});
