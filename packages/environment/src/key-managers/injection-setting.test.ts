import { randomUUID } from "node:crypto";
import { registry, type SettingsPatch } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ProcessEnvironmentScope, ProcessEnvironmentSupplier } from "../adapter/process-environment.js";
import { useCleanups } from "../../test/cleanups.js";
import { fakeAdapter } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create } from "../../test/sessions.js";
import { updateSettings } from "../../test/shelf.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * The injection setting (key-managers spec, "Injection"; ADR 0011, ADR
 * 0028; #367) through the primary seam: an in-process environment with the
 * scripted fake adapter, which reports the variables its process was given,
 * a test supplier registered with the process environment (#307), and the
 * settings written over the wire as a client writes them. What is asserted
 * is whether the supplier was asked, what each process was given, and the
 * key each run was handed, never the resolver's own state.
 */

const { onCleanup } = useCleanups();

/** A second account on the fake adapter's provider, beside the preset `claude-max`. */
const WORK = "claude-work";

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const adapter = fakeAdapter();
  const t = await startTestEnvironment({
    adapter,
    accounts: [
      { id: "claude-max", provider: adapter.descriptor.provider },
      { id: WORK, provider: adapter.descriptor.provider },
    ],
    ...options,
  });
  onCleanup(() => t.close());
  return t;
};

const ended = (t: TestEnvironment, sessionId: string) => t.env.log.readStream({ kind: "session", id: sessionId }).filter((event) => event.type === "run.ended");

/** Starts a run on the session as a client does and waits for its end. */
const runTo = async (t: TestEnvironment, client: WireClient, sessionId: string, text = "Fix the receipts"): Promise<void> => {
  const before = ended(t, sessionId).length;
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text }));
  if (answer.result === undefined) throw new Error(`runs.start was refused: ${JSON.stringify(answer.receipt)}`);
  await vi.waitFor(() => expect(ended(t, sessionId)).toHaveLength(before + 1));
};

/** Sets settings over the wire, as an admin client does; throws unless the update was accepted. */
const set = async (client: WireClient, values: SettingsPatch): Promise<void> => {
  const answer = await updateSettings(client, values);
  if (answer.receipt.status !== "accepted") throw new Error(`settings.update was refused: ${JSON.stringify(answer.receipt)}`);
};

/** A supplier that records each scope it supplied, and gives every spawn one variable. */
const recordingSupplier = () => {
  const supplied: ProcessEnvironmentScope[] = [];
  const supplier: ProcessEnvironmentSupplier = {
    name: "test",
    key: () => "test",
    supply: (scope) => {
      supplied.push(scope);
      return { variables: { HARNESS_TEST_TOKEN: "token-for-tests" }, release: () => undefined };
    },
  };
  return { supplier, supplied };
};

/** An environment with the recording supplier registered, and a client. */
const withSupplier = async (options: TestEnvironmentOptions = {}) => {
  const t = await start(options);
  const { supplier, supplied } = recordingSupplier();
  t.env.processEnvironments.register(supplier);
  return { t, supplied, client: await t.client() };
};

/** What the session's latest process was given. */
const givenTo = async (t: TestEnvironment, sessionId: string): Promise<Readonly<Record<string, string>>> => {
  const process = t.adapter.processesOf(sessionId).at(-1);
  if (process === undefined) throw new Error(`Session ${sessionId} has no process.`);
  return process.supplied;
};

describe("the environment's credentials.injection", () => {
  it("allows by its preset: a run's process is given what the suppliers supply", async () => {
    const { t, client, supplied } = await withSupplier();
    const session = await create(client);

    await runTo(t, client, session.id);

    expect(await givenTo(t, session.id)).toEqual({ HARNESS_TEST_TOKEN: "token-for-tests" });
    expect(supplied).toHaveLength(1);
  });

  it("denies every run once set to deny: no supplier is asked and the process is given nothing", async () => {
    const { t, client, supplied } = await withSupplier();
    await set(client, { "credentials.injection": "deny" });
    const session = await create(client);

    await runTo(t, client, session.id);

    expect(await givenTo(t, session.id)).toEqual({});
    expect(supplied).toEqual([]);
  });
});
