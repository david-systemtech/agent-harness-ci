import { describe, expect, it } from "vitest";
import { registry } from "@agent-harness/contracts";
import { useCleanups } from "../../test/cleanups.js";
import { bootstrapExchange, startTestEnvironment } from "../../test/helper.js";
import { lateCheck, scriptedStep } from "../../test/setup-steps.js";
import { connectClient } from "../../test/wire-client.js";
import type { Address } from "./http.js";

const { onCleanup, tempDir } = useCleanups();

describe("the test environment's start pass", () => {
  it("finishes Set up before returning a log head that a late start result could move", async () => {
    const late = lateCheck();
    const dataDir = tempDir();
    let address: Address | undefined;
    let returned = false;
    const starting = startTestEnvironment({
      dataDir,
      hooks: { beforeStep: (_step, progress) => { address = progress.address; } },
      setupSteps: {
        steps: [scriptedStep("account", { stateChecks: [{ id: "account.late", holds: "Signed in.", actions: [] }] })],
        stateChecks: { "account.late": late.checker },
      },
    }).then((t) => {
      onCleanup(() => t.close());
      returned = true;
      return t;
    });
    const call = await late.call(1);
    try {
      if (address === undefined) throw new Error("The environment has not bound its listener.");
      // A real socket can open while the check is held: production startup
      // remains asynchronous, but the test helper must not return yet.
      const credential = await bootstrapExchange(address, dataDir);
      const client = await connectClient(address, { token: credential.token });
      onCleanup(() => client.close());
      expect(returned).toBe(false);
    } finally {
      call.answer(true);
      await starting;
    }
    const t = await starting;
    const head = t.env.log.head();
    await t.env.setup.startPass;
    expect(t.env.log.head()).toBe(head);
    const client = await t.client();
    const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: t.env.log.head() + 100 });
    const frame = await client.next((f) => f.type === "snapshot" && f.subscription === subscription);
    if (frame.type !== "snapshot") throw new Error("Expected the environment snapshot.");
    expect(registry["environment.subscribe"].result.parse(frame.payload).setup).toMatchObject([{ step: "account", state: "done" }]);
  });
});
