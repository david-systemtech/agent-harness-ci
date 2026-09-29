import type { StepResult } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import { added } from "../../test/key-manager-connections.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * The Key manager step's check (key-managers spec, "The Key manager step";
 * setup spec, "Skipped"; ADR 0028, ADR 0031; #367) through the primary
 * seam: an in-process environment and a real client over a real WebSocket.
 * What is asserted is what `setup.check` answers a client. The step's
 * other state checks, which read what a verification finds, are #383's.
 */

const { onCleanup } = useCleanups();

const start = async (): Promise<TestEnvironment> => {
  const t = await startTestEnvironment();
  onCleanup(() => t.close());
  return t;
};

/** The one result `setup.check` answers for the Key manager step. */
const checkKeyManager = async (client: WireClient): Promise<StepResult> => {
  const { results } = await client.request("setup.check", { step: "key-manager" });
  expect(results.map((result) => result.step)).toEqual(["key-manager"]);
  return results[0] as StepResult;
};

describe("the Key manager step", () => {
  it("answers skipped with key-manager.present's line while no connection is on the environment, never forcing one", async () => {
    const t = await start();
    const client = await t.client();

    expect(await checkKeyManager(client)).toMatchObject({
      state: "skipped",
      reason: "No key-manager connection is on this environment.",
      failing: [],
      actions: [],
    });
  });

  it("is no longer skipped once a connection is on the environment, a connection awaiting its sign-in included", async () => {
    const t = await start();
    const client = await t.client();
    await added(client, { address: "https://bao.example.test:8200", method: "token" });

    expect(await checkKeyManager(client)).toMatchObject({
      state: "done",
      reason: "At least one key-manager connection is on this environment.",
      failing: [],
    });
  });
});
