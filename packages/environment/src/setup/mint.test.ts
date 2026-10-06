import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registry, stepPrompt, type EventFrame, type Frame, type ParamsOf, type ResponseOf, type StepResult, type WorkspaceRequest } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { useCleanups } from "../../test/cleanups.js";
import { end, fakeAdapter, say, type FakeAdapter, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, get, refusal } from "../../test/sessions.js";
import { scriptedStep } from "../../test/setup-steps.js";
import type { WireClient } from "../../test/wire-client.js";
import type { StepSubject } from "./mint.js";
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

const { onCleanup, tempDir } = useCleanups();

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
const TEAM_BANK = { kind: "bank", id: "bank-2", label: "team-memory" } as const;

/** The note step: a registry of its own, its check finding NOTE.md in the workspace of the fake's latest run, which is a scratch one unless the step names another. */
const noteSteps = (adapter: FakeAdapter, workspace?: WorkspaceRequest, subjects: readonly StepSubject[] = [BANK]): SetupSteps => ({
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
  llmSteps: {
    instructions: {
      subjects: () => subjects,
      facts: (subject) => ({ name: subject?.label ?? "nothing" }),
      ...(workspace !== undefined && { workspace: () => workspace }),
    },
  },
});

/** A run that writes NOTE.md into its workspace and completes. */
const writesNote: Script = async function* ({ input }) {
  await writeFile(join(input.workspace.path, "NOTE.md"), "# A note\n");
  yield say("NOTE.md is written.");
  yield end();
};

const start = async (options: TestEnvironmentOptions & { readonly script?: Script; readonly workspace?: WorkspaceRequest; readonly subjects?: readonly StepSubject[] } = {}): Promise<TestEnvironment> => {
  const adapter = options.adapter ?? fakeAdapter({ ...(options.script !== undefined && { script: options.script }) });
  const t = await startTestEnvironment({ ...options, adapter, setupSteps: noteSteps(adapter, options.workspace, options.subjects) });
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

/** Follows the session's stream from its start to its `n`th event of `type`; answers the run that event names. */
const nth = async (client: WireClient, sessionId: string, type: "run.started" | "run.ended", n: number): Promise<string> => {
  const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId, afterSequence: 0 });
  for (let seen = 1; ; seen += 1) {
    const { event } = await client.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription && f.event.type === type);
    if (seen === n) return String(event.payload["runId"]);
  }
};

/** Waits for the session's `n`th run to end; answers its id. */
const runEnded = (client: WireClient, sessionId: string, n = 1): Promise<string> => nth(client, sessionId, "run.ended", n);

/** Waits for the session's `n`th run to start; answers its id. */
const runStarted = (client: WireClient, sessionId: string, n = 1): Promise<string> => nth(client, sessionId, "run.started", n);

/** A run that fails with the provider's error. */
const fails: Script = function* () {
  yield say("Working on NOTE.md.");
  yield end("error", { error: { message: "The provider is overloaded.", code: null } });
};

/** A run that works until it is interrupted, when the fake ends it. */
const holds: Script = async function* ({ signal }) {
  yield say("Working on NOTE.md.");
  await new Promise((resolve) => signal.addEventListener("abort", resolve));
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
  it("keeps a subject's failed run visible when a different subject's later session ends cleanly, targeting manual authoring and start over at the failed subject", async () => {
    const t = await start({ subjects: [BANK, TEAM_BANK], script: function* () { yield end(); } });
    t.adapter.nextScripts.push(fails);
    const client = await t.client();
    const failed = await minted(client, { step: "instructions", subject: BANK.id, variant: "first" });
    await runEnded(client, failed);
    const clean = await minted(client, { step: "instructions", subject: TEAM_BANK.id, variant: "first" });
    await runEnded(client, clean);
    const { results } = await client.request("setup.check", { step: "instructions" });
    expect(results[0]).toMatchObject({
      state: "needs-attention",
      reason: "The session's run failed: The provider is overloaded. NOTE.md is missing from the session's workspace.",
      actions: ["try-again", "write-it-myself", "start-over"],
      targets: [
        { action: "try-again", kind: "session", id: failed, label: "Set up: Instructions (david-memory)" },
        { action: "write-it-myself", ...BANK },
        { action: "start-over", ...BANK },
      ],
    });
  });

  it("records the step, subject and prompt variant on the minted session's stream, even when the prompt remains a draft", async () => {
    const t = await start({ accounts: [] });
    const client = await t.client();
    const sessionId = await minted(client, { step: "instructions", subject: BANK.id, variant: "revise" });
    const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId, afterSequence: 0 });
    const draft = await client.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription && f.event.type === "session.draft-set");
    const events = client.received.filter((f) => f.type === "event" && f.subscription === subscription);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({
      event: expect.objectContaining({ type: "setup.minted", payload: { step: "instructions", subject: BANK, variant: "revise" } }),
    })]));
    expect(draft.event.payload).toEqual({ draft: "Revise NOTE.md for david-memory." });
  });

  it("reads both subjects' stopped sessions, then a new draft supersedes only its own subject's session", async () => {
    const t = await start({ subjects: [BANK, TEAM_BANK], script: holds });
    t.adapter.nextScripts.push(fails);
    const client = await t.client();
    const failed = await minted(client, { step: "instructions", subject: BANK.id, variant: "first" });
    await runEnded(client, failed);
    const stopped = await minted(client, { step: "instructions", subject: TEAM_BANK.id, variant: "revise" });
    const runId = await runStarted(client, stopped);
    expect((await client.request("runs.interrupt", { commandId: randomUUID(), runId })).receipt.status).toBe("accepted");
    await runEnded(client, stopped);
    const both = (await client.request("setup.check", { step: "instructions" })).results[0];
    expect(both).toMatchObject({
      reason: "The session's run was stopped. The session's run failed: The provider is overloaded. NOTE.md is missing from the session's workspace.",
      actions: ["try-again", "write-it-myself", "start-over"],
      targets: [
        { action: "try-again", kind: "session", id: stopped },
        { action: "write-it-myself", ...TEAM_BANK },
        { action: "start-over", ...TEAM_BANK },
        { action: "try-again", kind: "session", id: failed },
        { action: "write-it-myself", ...BANK },
        { action: "start-over", ...BANK },
      ],
    });
    await minted(client, { step: "instructions", subject: TEAM_BANK.id, variant: "first", account: "missing-account" });
    const afterDraft = (await client.request("setup.check", { step: "instructions" })).results[0];
    expect(afterDraft).toMatchObject({
      reason: "The session's run failed: The provider is overloaded. NOTE.md is missing from the session's workspace.",
      targets: [
        { action: "try-again", kind: "session", id: failed },
        { action: "write-it-myself", ...BANK },
        { action: "start-over", ...BANK },
      ],
    });
  });

  it("records a subjectless mint explicitly and keeps older or hand-tagged sessions readable without inventing subject targets", async () => {
    const t = await start({ script: fails });
    const client = await t.client();
    const byHand = await create(client, { tags: ["setup", "instructions"], title: "Set up: Instructions (david-memory)" });
    await client.request("runs.start", { commandId: randomUUID(), sessionId: byHand.id, text: "Write NOTE.md." });
    await runEnded(client, byHand.id);
    const old = (await client.request("setup.check", { step: "instructions" })).results[0];
    expect(old?.targets).toEqual([{ action: "try-again", kind: "session", id: byHand.id, label: "Set up: Instructions (david-memory)" }]);

    const subjectless = await minted(client, { step: "instructions", variant: "first", account: "missing-account" });
    const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId: subjectless, afterSequence: 0 });
    const provenance = await client.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription && f.event.type === "setup.minted");
    expect(provenance.event.payload).toEqual({ step: "instructions", subject: null, variant: "first" });
    const afterDraft = (await client.request("setup.check", { step: "instructions" })).results[0];
    expect(afterDraft?.actions).toEqual([]);
    expect(afterDraft?.targets).toBeUndefined();
  });

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

  it("creates the session in the workspace the step names when it names one", async () => {
    const path = tempDir();
    const t = await start({ script: writesNote, workspace: { kind: "directory", path } });
    const client = await t.client();
    const sessionId = await minted(client, { step: "instructions", subject: BANK.id, variant: "first" });
    expect(await get(client, sessionId)).toMatchObject({ workspace: { kind: "directory", path } });
    await runEnded(client, sessionId);
    expect(existsSync(join(path, "NOTE.md"))).toBe(true);
  });

  it("takes the account, model and effort from the call, else the environment's defaults: the default account, the strongest of the default family and the default effort", async () => {
    const adapter = fakeAdapter({ script: writesNote });
    const t = await start({ adapter, accounts: [{ id: "claude-max", provider: adapter.descriptor.provider }, { id: "claude-team", provider: adapter.descriptor.provider }] });
    const client = await t.client();
    const settings = await client.request("settings.update", { commandId: randomUUID(), values: { "accounts.defaultModelFamily": "sonnet", "accounts.defaultEffort": "high" } });
    expect(settings.receipt).toMatchObject({ status: "accepted" });

    const byDefault = await minted(client, { step: "instructions", subject: BANK.id, variant: "first" });
    await runEnded(client, byDefault);
    expect(t.adapter.lastRun().input).toMatchObject({ sessionId: byDefault, account: { id: "claude-max" }, model: "sonnet", effort: "high" });

    const picked = await minted(client, { step: "instructions", subject: BANK.id, variant: "first", account: "claude-team", model: "opus", effort: "low" });
    await runEnded(client, picked);
    expect(t.adapter.lastRun().input).toMatchObject({ sessionId: picked, account: { id: "claude-team" }, model: "opus", effort: "low" });
  });

  it("holds the rendered prompt as the session's draft and starts no run when no account resolves, answering the session id all the same", async () => {
    const t = await start({ accounts: [] });
    const client = await t.client();
    const sessionId = await minted(client, { step: "instructions", subject: BANK.id, variant: "first" });
    expect(await get(client, sessionId)).toMatchObject({ draft: "Write NOTE.md for david-memory.", tags: ["instructions", "setup"], activity: { state: "idle" }, accountId: null });
    expect(t.adapter.runs).toEqual([]);
  });

  it("holds the prompt as the draft too when the account the call names is not here, or offers no model of the call's", async () => {
    const t = await start();
    const client = await t.client();
    for (const params of [{ account: "claude-gone" }, { model: "a-model-nobody-offers" }]) {
      const sessionId = await minted(client, { step: "instructions", subject: BANK.id, variant: "revise", ...params });
      expect((await get(client, sessionId)).draft, JSON.stringify(params)).toBe("Revise NOTE.md for david-memory.");
    }
    expect(t.adapter.runs).toEqual([]);
  });

  it("starts the revise prompt with the revise variant", async () => {
    const t = await start({ script: writesNote });
    const client = await t.client();
    const sessionId = await minted(client, { step: "instructions", subject: BANK.id, variant: "revise" });
    await runEnded(client, sessionId);
    expect(t.adapter.lastRun().input.prompt.map((message) => message.text)).toEqual(["Revise NOTE.md for david-memory."]);
  });

  it("starts over with a new session, the old one staying in the list", async () => {
    const t = await start({ script: writesNote });
    t.adapter.nextScripts.push(fails);
    const client = await t.client();
    const first = await minted(client, { step: "instructions", subject: BANK.id, variant: "first" });
    await runEnded(client, first);
    const again = await minted(client, { step: "instructions", subject: BANK.id, variant: "first" });
    expect(again).not.toBe(first);
    await runEnded(client, again);
    const listed = (await client.request("sessions.list", {})).sessions.map((session) => session.id);
    expect(listed).toEqual(expect.arrayContaining([first, again]));
    await triggerWindowPasses(t);
    expect(await noteResult(t, client)).toMatchObject({ state: "done", actions: ["revise"] });
  });

  it("refuses a subject the step does not have, not_found, and a step that names no prompt, conflict no_llm_step, minting nothing", async () => {
    const t = await start();
    const client = await t.client();
    const unknown = await mint(client, { step: "instructions", subject: "bank-9", variant: "first" });
    expect(unknown.receipt).toMatchObject({ status: "rejected", error: { code: "not_found", data: { kind: "subject", step: "instructions", subject: "bank-9" } } });
    for (const step of ["permissions", "appearance"] as const) {
      const plain = await mint(client, { step, variant: "first" });
      expect(plain.receipt, step).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "no_llm_step", step } } });
    }
    expect((await client.request("sessions.list", {})).sessions).toEqual([]);
    expect(t.adapter.runs).toEqual([]);
  });

  it("runs the session under the caller's ceiling as it is now, in the environment's default mode, and needs admin", async () => {
    const t = await start({ script: writesNote });
    const full = await t.client();
    const ordinary = await minted(full, { step: "instructions", subject: BANK.id, variant: "first" });
    await runEnded(full, ordinary);
    expect(t.adapter.lastRun().input).toMatchObject({ mode: "acceptEdits", ceiling: "bypassPermissions" });

    const planner = await t.client({ token: (await t.pair({ scopes: ["admin", "read"], ceiling: "plan" })).token });
    const planned = await minted(planner, { step: "instructions", subject: BANK.id, variant: "first" });
    await runEnded(full, planned);
    expect(t.adapter.lastRun().input).toMatchObject({ sessionId: planned, mode: "plan", ceiling: "plan" });

    const driver = await t.client({ token: (await t.pair({ scopes: ["read", "sessions:write", "runs:drive"] })).token });
    expect(await refusal(mint(driver, { step: "instructions", variant: "first" }))).toMatchObject({ code: "forbidden", data: { scope: "admin" } });
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
      reason: "Set up here.",
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

  it("after a run that failed, with the artefact missing, the step needs attention with the error, offering try-again targeting that session, write-it-myself and start-over; runs.send continues the same session, whose next clean end with the artefact makes it done", async () => {
    const t = await start({ script: writesNote });
    t.adapter.nextScripts.push(fails);
    const client = await t.client();
    const sessionId = await minted(client, { step: "instructions", subject: BANK.id, variant: "first" });
    await runEnded(client, sessionId);
    await triggerWindowPasses(t);
    expect(await noteResult(t, client)).toEqual({
      step: "instructions",
      state: "needs-attention",
      reason: "The session's run failed: The provider is overloaded. NOTE.md is missing from the session's workspace.",
      failing: ["instructions.note"],
      actions: ["try-again", "write-it-myself", "start-over"],
      targets: [
        { action: "try-again", kind: "session", id: sessionId, label: "Set up: Instructions (david-memory)" },
        { action: "write-it-myself", ...BANK },
        { action: "start-over", ...BANK },
      ],
      checkedAt: after(TRIGGER_WINDOW_MS),
    });

    // Try again: the same session continues where its run stopped.
    const sent = await client.request("runs.send", { commandId: randomUUID(), sessionId, text: "Continue where you stopped." });
    expect(sent.receipt).toMatchObject({ status: "accepted" });
    await runEnded(client, sessionId, 2);
    expect(t.adapter.lastRun().input).toMatchObject({ sessionId });
    await triggerWindowPasses(t);
    expect(await noteResult(t, client)).toMatchObject({ state: "done", actions: ["revise"], checkedAt: after(2 * TRIGGER_WINDOW_MS) });
  });

  it("after a run that was interrupted, with the artefact missing, the step needs attention saying the run was stopped, with the same three actions", async () => {
    const t = await start({ script: holds });
    const client = await t.client();
    const sessionId = await minted(client, { step: "instructions", subject: BANK.id, variant: "first" });
    const runId = await runStarted(client, sessionId);
    expect((await client.request("runs.interrupt", { commandId: randomUUID(), runId })).receipt).toMatchObject({ status: "accepted" });
    await runEnded(client, sessionId);
    await triggerWindowPasses(t);
    expect(await noteResult(t, client)).toMatchObject({
      state: "needs-attention",
      reason: "The session's run was stopped. NOTE.md is missing from the session's workspace.",
      actions: ["try-again", "write-it-myself", "start-over"],
      targets: [
        { action: "try-again", kind: "session", id: sessionId },
        { action: "write-it-myself", ...BANK },
        { action: "start-over", ...BANK },
      ],
    });
  });

  it("of any session tagged setup and the step, however it was tagged, checks the step again, and a run end of a session without the setup tag does not", async () => {
    const t = await start();
    const client = await t.client();
    const byHand = await create(client, { tags: ["Setup", "instructions"] });
    await client.request("runs.start", { commandId: randomUUID(), sessionId: byHand.id, text: "Write NOTE.md." });
    await runEnded(client, byHand.id);
    await triggerWindowPasses(t);
    expect(await noteResult(t, client)).toMatchObject({ checkedAt: after(TRIGGER_WINDOW_MS) });

    const untagged = await create(client, { tags: ["instructions"] });
    await client.request("runs.start", { commandId: randomUUID(), sessionId: untagged.id, text: "Write NOTE.md." });
    await runEnded(client, untagged.id);
    await triggerWindowPasses(t);
    expect(await noteResult(t, client)).toMatchObject({ checkedAt: after(TRIGGER_WINDOW_MS) });
  });
});
