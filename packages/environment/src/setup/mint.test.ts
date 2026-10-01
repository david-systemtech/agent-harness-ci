import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registry, stepPrompt, type EventFrame, type Frame, type ParamsOf, type ResponseOf, type StepResult } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { useCleanups } from "../../test/cleanups.js";
import { end, fakeAdapter, say, type FakeAdapter, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { get } from "../../test/sessions.js";
import { scriptedStep } from "../../test/setup-steps.js";
import type { WireClient } from "../../test/wire-client.js";
import { TRIGGER_WINDOW_MS } from "./scheduler.js";
import type { SetupSteps } from "./service.js";

/**
 * `setup.mint` and the LLM step (ADR 0019; the Set up specification, "The
 * LLM step and minted sessions"; #584) through the primary seam: an
 * in-process environment with the scripted fake adapter on the manual
 * clock, and a registry of the test's own holding one LLM step, the note
 * step under the Instructions step's id, whose artefact is `NOTE.md` in the
 * scratch workspace of its latest run. What is asserted is what a client
 * sees: what `setup.mint` answers, the session it lists, what the run was
 * handed, and the step's result in the snapshot once a run end has checked
 * it again, with nobody asking.
 */

const { onCleanup } = useCleanups();

/** The note step's prompt: the note named by its subject, validated at version 2. */
const notePrompt = stepPrompt({
  id: "test-note",
  validator: { name: "note-validator", version: 2 },
  facts: z.object({ name: z.string() }),
  first: ({ name }) => `Write NOTE.md for ${name}.`,
  revise: ({ name }) => `Revise NOTE.md for ${name}.`,
  example: { name: "example" },
});

/** The note step's one subject. */
const BANK = { kind: "bank", id: "bank-1", label: "david-memory" } as const;

/** The note step: a registry of its own, its check finding NOTE.md in the workspace of the fake's latest run. */
const noteSteps = (adapter: FakeAdapter): SetupSteps => ({
  steps: [
    scriptedStep("instructions", {
      llm: "test-note",
      stateChecks: [{ id: "instructions.note", holds: "NOTE.md is written.", actions: [] }],
    }),
    scriptedStep("permissions", { stateChecks: [] }),
  ],
  stateChecks: {
    "instructions.note": () => {
      const run = adapter.runs.at(-1);
      return run !== undefined && existsSync(join(run.input.workspace.path, "NOTE.md")) ? true : { reason: "NOTE.md is missing from the session's workspace." };
    },
  },
  prompts: [notePrompt],
  authoring: {
    instructions: {
      subjects: () => [BANK],
      facts: (subject) => ({ name: subject?.label ?? "nothing" }),
    },
  },
});

/** A run that writes NOTE.md into its workspace and completes. */
const writesNote: Script = async function* ({ input }) {
  await writeFile(join(input.workspace.path, "NOTE.md"), "# A note\n");
  yield say("NOTE.md is written.");
  yield end();
};

const start = async (options: TestEnvironmentOptions & { readonly script?: Script } = {}): Promise<TestEnvironment> => {
  const adapter = options.adapter ?? fakeAdapter({ ...(options.script !== undefined && { script: options.script }) });
  const t = await startTestEnvironment({ ...options, adapter, setupSteps: noteSteps(adapter) });
  onCleanup(() => t.close());
  await t.env.setup.startPass;
  return t;
};

/** `setup.mint` with a fresh command id; resolves with its response. */
const mint = async (client: WireClient, params: Omit<ParamsOf<"setup.mint">, "commandId">): Promise<ResponseOf<"setup.mint">> =>
  client.request("setup.mint", { commandId: randomUUID(), ...params });

/** The session `setup.mint` answered, or fails the test with its receipt. */
const minted = async (client: WireClient, params: Omit<ParamsOf<"setup.mint">, "commandId">): Promise<string> => {
  const answer = await mint(client, params);
  expect(answer.receipt).toMatchObject({ status: "accepted" });
  if (answer.result === undefined) throw new Error("setup.mint answered no session.");
  return answer.result.sessionId;
};

/** Follows the session's stream from its start until its `n`th run has ended; answers that run's id. */
const runEnded = async (client: WireClient, sessionId: string, n = 1): Promise<string> => {
  const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId, afterSequence: 0 });
  for (let ended = 0; ; ) {
    const { event } = await client.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription && f.event.type === "run.ended");
    ended += 1;
    if (ended === n) return String(event.payload["runId"]);
  }
};

/** The manual clock's time `ms` after its start. */
const after = (ms: number): string => new Date(Date.parse(MANUAL_CLOCK_START) + ms).toISOString();

/** Moves the clock past a trigger's window, then lets the check it started finish: the note step's check answers at once. */
const triggerWindowPasses = async (t: TestEnvironment): Promise<void> => {
  t.clock.advance(TRIGGER_WINDOW_MS);
  await new Promise((resolve) => setImmediate(resolve));
};

/** The note step's result as the snapshot carries it, cached by the last check that ran, whoever started it. */
const noteResult = async (t: TestEnvironment, client: WireClient): Promise<StepResult | undefined> => {
  const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: t.env.log.head() + 100 });
  const frame = await client.next((f): f is Extract<Frame, { type: "snapshot" }> => f.type === "snapshot" && f.subscription === subscription);
  return registry["environment.subscribe"].result.parse(frame.payload).setup?.find((result) => result.step === "instructions");
};

describe("setup.mint", () => {
  it("creates a session in a scratch workspace of its own, tagged setup and the step, titled for the step and its subject, and starts its first run with the step's first prompt rendered from the subject's facts", async () => {
    const t = await start({ script: writesNote });
    const client = await t.client();
    const sessionId = await minted(client, { step: "instructions", subject: BANK.id, variant: "first" });

    await runEnded(client, sessionId);
    const summary = await get(client, sessionId);
    expect(summary).toMatchObject({ title: "Set up: Instructions (david-memory)", tags: ["instructions", "setup"], workspace: { kind: "scratch" }, draft: null });
    expect(t.adapter.lastRun().input).toMatchObject({ sessionId, account: { id: "claude-max" } });
    expect(t.adapter.lastRun().input.prompt.map((message) => message.text)).toEqual(["Write NOTE.md for david-memory."]);
  });
});

describe("a minted session's run end", () => {
  it("checks the step again with nobody asking: with the artefact written, the step is done and offers revise, targeting its subject, the one action a done result carries", async () => {
    const t = await start({ script: writesNote });
    const client = await t.client();
    expect(await noteResult(t, client)).toMatchObject({ state: "needs-attention", checkedAt: MANUAL_CLOCK_START });

    const sessionId = await minted(client, { step: "instructions", subject: BANK.id, variant: "first" });
    await runEnded(client, sessionId);
    await triggerWindowPasses(t);
    expect(await noteResult(t, client)).toEqual({
      step: "instructions",
      state: "done",
      reason: "NOTE.md is written.",
      failing: [],
      actions: ["revise"],
      targets: [{ action: "revise", ...BANK }],
      checkedAt: after(TRIGGER_WINDOW_MS),
    });
  });

  it("after a clean end with the artefact still missing, the step needs attention naming what is missing, with no authoring action", async () => {
    const t = await start();
    const client = await t.client();
    const sessionId = await minted(client, { step: "instructions", subject: BANK.id, variant: "first" });
    await runEnded(client, sessionId);
    await triggerWindowPasses(t);
    expect(await noteResult(t, client)).toEqual({
      step: "instructions",
      state: "needs-attention",
      reason: "NOTE.md is missing from the session's workspace.",
      failing: ["instructions.note"],
      actions: [],
      checkedAt: after(TRIGGER_WINDOW_MS),
    });
  });
});
