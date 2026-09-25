import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  registry,
  type Mode,
  type ParamsOf,
  type PromptAnsweredPayload,
  type PromptOpenedPayload,
  type ResponseOf,
  type RunPolicyResolvedPayload,
  type ToolDecisionPayload,
} from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START, manualClock } from "../../test/clock.js";
import { ask, end, fakeAdapter, say, toldText, type FakeAdapter, type FakeAdapterOptions, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, get } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";
import type { AdapterEvent, PromptDetail, PromptKind } from "../adapter/contract.js";
import type { EventEnvelope as LogEvent } from "../event-log/event-log.js";
import type { RunActor } from "./resolver.js";

/**
 * Unattended runs and the automatic decisions (#131; permissions spec,
 * "Attended and unattended runs; the unattended default", "Prompts, parked
 * prompts and the TTL", "Events"; ADR 0006, ADR 0007) through the primary
 * seam: an in-process environment with the scripted fake adapter under the
 * manual clock, runs started by a client session over the wire or by a
 * routine, a bot or the completions surface through the environment's own
 * start. What is asserted is what a client sees on the session's stream and
 * the environment's, and what the fake provider was told.
 */

const { onCleanup, tempDir } = useCleanups();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The instant `ms` after the manual clock's start. */
const at = (ms: number): string => new Date(Date.parse(MANUAL_CLOCK_START) + ms).toISOString();

const UNATTENDED_DENIAL = "Denied: nobody is present to approve this. Continue without it and say what you could not do.";
const UNATTENDED_ANSWER = "nobody is present; proceed with your best judgement";

const start = async (adapter: FakeAdapterOptions | FakeAdapter = {}, options: Omit<TestEnvironmentOptions, "adapter"> = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ ...options, adapter: "descriptor" in adapter ? adapter : fakeAdapter(adapter) });
  onCleanup(() => t.close());
  return t;
};

type Command = "runs.start" | "permissions.prompts.answer" | "permissions.settings.set";

const send = async <N extends Command>(client: WireClient, method: N, params: Omit<ParamsOf<N>, "commandId"> & { commandId?: string }): Promise<ResponseOf<N>> =>
  registry[method].response.parse(await client.request(method, { commandId: randomUUID(), ...params } as ParamsOf<N>)) as ResponseOf<N>;

/** A run a client session starts over the wire: attended. */
const startRun = async (client: WireClient, sessionId: string, text = "Fix the receipts", mode?: Mode) => {
  const answer = await send(client, "runs.start", { sessionId, text, ...(mode !== undefined && { mode }) });
  if (answer.result === undefined) throw new Error(`runs.start was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result;
};

const routine = (name = "nightly-receipts", ceiling: Mode = "bypassPermissions"): RunActor => ({ kind: "routine", name, ceiling, clientSessionId: null });
const bot = (name = "triage", ceiling: Mode = "bypassPermissions"): RunActor => ({ kind: "bot", name, ceiling, clientSessionId: null });
const program = (ceiling: Mode = "bypassPermissions", attended = false): RunActor => ({ kind: "completions", attended, ceiling, clientSessionId: null });

/** A run an actor that is no client session starts, through the environment's own start. */
const startAs = (t: TestEnvironment, sessionId: string, actor: RunActor, text = "Fix the receipts", mode?: Mode) =>
  t.env.startRun({ sessionId, actor, text, ...(mode !== undefined && { mode }) });

const setSettings = (client: WireClient, values: ParamsOf<"permissions.settings.set">["values"], acknowledgeBypass?: true) =>
  send(client, "permissions.settings.set", { values, ...(acknowledgeBypass !== undefined && { acknowledgeBypass }) });

const eventsOf = (t: TestEnvironment, sessionId: string) => t.env.log.readStream({ kind: "session", id: sessionId });
const ofType = (t: TestEnvironment, sessionId: string, type: string) => eventsOf(t, sessionId).filter((event) => event.type === type);
const payloadsOf = <P>(t: TestEnvironment, sessionId: string, type: string): P[] => ofType(t, sessionId, type).map((event) => event.payload as P);

const untilOpened = async (t: TestEnvironment, sessionId: string, count = 1): Promise<PromptOpenedPayload[]> => {
  await vi.waitFor(() => expect(ofType(t, sessionId, "prompt.opened")).toHaveLength(count));
  return payloadsOf<PromptOpenedPayload>(t, sessionId, "prompt.opened");
};

const untilEnded = async (t: TestEnvironment, sessionId: string, runId: string): Promise<LogEvent> => {
  await vi.waitFor(() => expect(ofType(t, sessionId, "run.ended").some((event) => event.payload["runId"] === runId)).toBe(true));
  return ofType(t, sessionId, "run.ended").find((event) => event.payload["runId"] === runId) as LogEvent;
};

const answered = (t: TestEnvironment, sessionId: string) => payloadsOf<PromptAnsweredPayload>(t, sessionId, "prompt.answered");
const decisions = (t: TestEnvironment, sessionId: string) => payloadsOf<ToolDecisionPayload>(t, sessionId, "tool.decision");
const policyOf = (t: TestEnvironment, sessionId: string, runId: string) =>
  payloadsOf<RunPolicyResolvedPayload>(t, sessionId, "run.policy.resolved").find((policy) => policy.runId === runId);

/** What the fake provider's runs said they were told, in order. */
const told = (t: TestEnvironment, sessionId: string): string[] =>
  payloadsOf<{ text: string }>(t, sessionId, "assistant.text")
    .map((payload) => payload.text)
    .filter((text) => text.startsWith("Told "));

/** The prompt notices on the environment's stream. */
const promptNotices = (t: TestEnvironment) =>
  t.env.log
    .readStream({ kind: "environment", id: t.env.id })
    .map((event) => event.type)
    .filter((type) => type.startsWith("prompt."));

const permission: PromptDetail = { toolName: "Bash", toolCallId: "toolu_1", input: { command: "sudo apt install jq" }, summary: "Claude wants to run sudo apt install jq" };
const denylisted: PromptDetail = { toolName: "Read", toolCallId: "toolu_2", input: { file_path: "~/.ssh/id_rsa" }, reason: "~/.ssh is on the denylist (paths)" };
const question: PromptDetail = {
  toolName: "AskUserQuestion",
  toolCallId: "toolu_3",
  input: { questions: [] },
  questions: [{ header: "Library", question: "Which date library?", options: [{ label: "date-fns", description: "" }], multiSelect: false }],
};
const plan: PromptDetail = { toolName: "ExitPlanMode", toolCallId: "toolu_4", input: { plan: "1. Read" }, plan: "1. Read" };
const DETAIL: Readonly<Record<PromptKind, PromptDetail>> = { permission, denylist: denylisted, question, plan };

const started = (toolCallId: string, name = "Bash", input: Record<string, string> = { command: "ls" }): AdapterEvent => ({
  type: "tool.started",
  payload: { toolCallId, name, input, title: null, agentId: null, parentToolCallId: null },
});
const ended = (toolCallId: string, status: "ok" | "error" | "cancelled" = "ok"): AdapterEvent => ({
  type: "tool.ended",
  payload: { toolCallId, status, output: status === "ok" ? "done" : "denied", durationMs: 1 },
});

/** A run that makes one tool call, asks about it through the broker, and ends it as the answer says. */
const prompted = (kind: PromptKind, detail: PromptDetail = DETAIL[kind]): Script =>
  async function* ({ context, input }) {
    const id = detail.toolCallId as string;
    yield started(id, detail.toolName ?? "Tool", { what: "input" });
    const decision = await context.broker.request({ sessionId: input.sessionId, runId: input.runId, kind, detail, promptId: id });
    yield say(toldText(decision));
    yield ended(id, decision.decision === "allow" ? "ok" : "error");
    yield end();
  };

describe("attendance", () => {
  it("is recorded in run.policy.resolved: attended for a client session's run, unattended for a routine's, a bot's or the completions surface's", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const attended = await startRun(client, id);
    await untilEnded(t, id, attended.runId);
    expect(policyOf(t, id, attended.runId)).toMatchObject({ actorKind: "client", actorName: null, attended: true });

    for (const [actor, kind, name] of [
      [routine("nightly-receipts"), "routine", "nightly-receipts"],
      [bot("triage"), "bot", "triage"],
      [program(), "completions", null],
    ] as const) {
      const { runId } = startAs(t, id, actor);
      await untilEnded(t, id, runId);
      expect(policyOf(t, id, runId), kind).toMatchObject({ actorKind: kind, actorName: name, attended: false });
    }
    // Only a completions request says a person is present, for itself.
    const { runId } = startAs(t, id, program("bypassPermissions", true));
    await untilEnded(t, id, runId);
    expect(policyOf(t, id, runId)).toMatchObject({ actorKind: "completions", attended: true });
  });

  it("is fixed at the run's start: a client disconnecting changes nothing, and its run's prompt still parks for a person", async () => {
    const adapter = fakeAdapter();
    const t = await start(adapter);
    const client = await t.client();
    const { id } = await create(client);
    let gateOpen!: () => void;
    const disconnected = new Promise<void>((resolve) => (gateOpen = resolve));
    adapter.nextScripts.push(ask("permission", permission, { promptId: "toolu_1", before: disconnected }));
    const { runId } = await startRun(client, id);
    await client.close();
    gateOpen();

    const [opened] = await untilOpened(t, id);
    expect(opened).toMatchObject({ runId, promptId: "toolu_1" });
    expect(answered(t, id)).toEqual([]);
    expect(policyOf(t, id, runId)).toMatchObject({ attended: true });
    expect(promptNotices(t)).toEqual(["prompt.parked"]);
    const later = await t.client();
    await send(later, "permissions.prompts.answer", { promptId: "toolu_1", decision: "allow" });
    await untilEnded(t, id, runId);
    expect(told(t, id)).toEqual([toldText({ decision: "allow" })]);
  });
});

describe("the unattended default", () => {
  it("is the mode of an unattended run that names none: permissions.unattended.mode, preset acceptEdits, recorded as applied", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = startAs(t, id, routine());
    await untilEnded(t, id, runId);
    expect(policyOf(t, id, runId)).toMatchObject({
      attended: false,
      mode: { requested: null, effective: "acceptEdits", ceiling: "bypassPermissions", clamped: false, clampReason: null },
      unattendedDefaultApplied: true,
    });
    expect(t.adapter.lastRun().input.mode).toBe("acceptEdits");
  });

  it("follows the setting once bypassPermissions is acknowledged, clamped to the run's ceiling, still recorded as applied", async () => {
    const t = await start();
    const client = await t.client();
    await setSettings(client, { "permissions.unattended.mode": "bypassPermissions" }, true);
    const { id } = await create(client);

    const high = startAs(t, id, bot("triage", "bypassPermissions"));
    await untilEnded(t, id, high.runId);
    expect(policyOf(t, id, high.runId)).toMatchObject({ mode: { requested: null, effective: "bypassPermissions" }, unattendedDefaultApplied: true });
    expect(t.adapter.lastRun().input.mode).toBe("bypassPermissions");

    // A default lowered to the ceiling is not a clamp (#129): the run reports the ceiling, unclamped.
    const low = startAs(t, id, program("acceptEdits"));
    await untilEnded(t, id, low.runId);
    expect(policyOf(t, id, low.runId)).toMatchObject({
      mode: { requested: null, effective: "acceptEdits", ceiling: "acceptEdits", clamped: false, clampReason: null },
      unattendedDefaultApplied: true,
    });
    expect(t.adapter.lastRun().input.mode).toBe("acceptEdits");
  });

  it("does not apply to an unattended run that names a mode, which is clamped like any request", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = startAs(t, id, routine("nightly-receipts", "acceptEdits"), "Go", "bypassPermissions");
    await untilEnded(t, id, runId);
    expect(policyOf(t, id, runId)).toMatchObject({
      mode: { requested: "bypassPermissions", effective: "acceptEdits", ceiling: "acceptEdits", clamped: true, clampReason: "ceiling" },
      unattendedDefaultApplied: false,
    });
  });
});

describe("a prompt on an unattended run", () => {
  it.each(["permission", "denylist", "plan"] as const)(
    "of kind %s is denied at once with the message the model reads, recorded as opened and answered by the unattended rule, and the run continues",
    async (kind) => {
      const t = await start({ script: prompted(kind) });
      const client = await t.client();
      const { id } = await create(client);
      const { runId } = startAs(t, id, routine());

      const run = await untilEnded(t, id, runId);
      expect(run.payload).toMatchObject({ reason: "completed" });
      const [opened] = payloadsOf<PromptOpenedPayload>(t, id, "prompt.opened");
      expect(opened).toMatchObject({ runId, promptId: DETAIL[kind].toolCallId, kind });
      expect(answered(t, id)).toEqual([
        {
          runId,
          promptId: DETAIL[kind].toolCallId,
          decision: "deny",
          message: UNATTENDED_DENIAL,
          answers: null,
          updatedInput: null,
          mode: null,
          remember: null,
          decidedBy: { auto: "unattended" },
          delivery: "live",
        },
      ]);
      // One transaction: the answer follows its opening directly, and nothing parked.
      const types = eventsOf(t, id).map((event) => event.type);
      expect(types[types.indexOf("prompt.opened") + 1]).toBe("prompt.answered");
      // No automatic decision interrupts a run: the provider is handed a deny with the message, and goes on.
      expect(told(t, id)).toEqual([toldText({ decision: "deny", message: UNATTENDED_DENIAL })]);
      expect(t.adapter.lastRun().interrupted).toBe(false);
      expect(promptNotices(t)).toEqual([]);
      expect(await get(client, id)).toMatchObject({ parkedPromptCount: 0 });
      expect((await client.request("permissions.prompts.list", {})).prompts).toEqual([]);
    },
  );

  it("of kind question is answered at once with the unattended answer, recorded by the unattended rule, and the run continues", async () => {
    const t = await start({ script: prompted("question") });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = startAs(t, id, bot());

    expect((await untilEnded(t, id, runId)).payload).toMatchObject({ reason: "completed" });
    expect(answered(t, id)).toEqual([expect.objectContaining({ promptId: "toolu_3", decision: "deny", message: UNATTENDED_ANSWER, decidedBy: { auto: "unattended" } })]);
    expect(told(t, id)).toEqual([toldText({ decision: "deny", message: UNATTENDED_ANSWER })]);
    expect(promptNotices(t)).toEqual([]);
  });

  it("is denied the same way for a completions request that did not say a person is present, and parks for one that did", async () => {
    const adapter = fakeAdapter();
    adapter.nextScripts.push(prompted("permission"), prompted("permission", { ...permission, toolCallId: "toolu_9" }));
    const t = await start(adapter);
    const client = await t.client();
    const { id } = await create(client);
    const unattended = startAs(t, id, program());
    await untilEnded(t, id, unattended.runId);
    expect(answered(t, id)).toEqual([expect.objectContaining({ decidedBy: { auto: "unattended" } })]);

    const attended = startAs(t, id, program("bypassPermissions", true));
    await untilOpened(t, id, 2);
    expect(answered(t, id)).toHaveLength(1);
    expect(promptNotices(t)).toEqual(["prompt.parked"]);
    await send(client, "permissions.prompts.answer", { promptId: "toolu_9", decision: "allow" });
    await untilEnded(t, id, attended.runId);
  });
});

describe("a run in bypassPermissions", () => {
  it("has a residual permission prompt denied at once by the bypass rule on an attended run, while a question on the same run parks", async () => {
    const script: Script = async function* ({ context, input }) {
      const denied = await context.broker.request({ sessionId: input.sessionId, runId: input.runId, kind: "permission", detail: permission, promptId: "toolu_1" });
      yield say(toldText(denied));
      const asked = await context.broker.request({ sessionId: input.sessionId, runId: input.runId, kind: "question", detail: question, promptId: "toolu_3" });
      yield say(toldText(asked));
      yield end();
    };
    const t = await start({ script });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id, "Go", "bypassPermissions");

    await untilOpened(t, id, 2);
    expect(policyOf(t, id, runId)).toMatchObject({ attended: true, mode: { effective: "bypassPermissions" } });
    const [bypassed] = answered(t, id);
    expect(bypassed).toMatchObject({ promptId: "toolu_1", decision: "deny", decidedBy: { auto: "bypass" }, delivery: "live" });
    expect(bypassed?.message).toMatch(/^Denied: /);
    expect(told(t, id)).toEqual([toldText({ decision: "deny", message: bypassed?.message as string })]);
    // The question waits for a person, in bypass as in every mode.
    expect(answered(t, id)).toHaveLength(1);
    expect((await client.request("permissions.prompts.list", {})).prompts.map((prompt) => prompt.promptId)).toEqual(["toolu_3"]);
    expect(promptNotices(t)).toEqual(["prompt.parked"]);
    await send(client, "permissions.prompts.answer", { promptId: "toolu_3", decision: "allow", answers: { "Which date library?": "date-fns" } });
    await untilEnded(t, id, runId);
  });

  it("does not deny a denylist prompt of an attended run: a person may allow it", async () => {
    const t = await start({ script: prompted("denylist") });
    const client = await t.client();
    const { id } = await create(client);
    await startRun(client, id, "Go", "bypassPermissions");
    await untilOpened(t, id);
    expect(answered(t, id)).toEqual([]);
    expect(promptNotices(t)).toEqual(["prompt.parked"]);
  });
});

describe("the TTL", () => {
  it("fixes ttlExpiresAt on prompt.opened from permissions.parkedPrompt.ttl, preset 24 hours", async () => {
    const t = await start({ script: prompted("permission") });
    const client = await t.client();
    const { id } = await create(client);
    t.clock.advance(5 * MINUTE);
    await startRun(client, id);
    const [opened] = await untilOpened(t, id);
    expect(opened?.ttlExpiresAt).toBe(at(5 * MINUTE + 24 * HOUR));

    await setSettings(client, { "permissions.parkedPrompt.ttl": { amount: 90, unit: "minutes" } });
    const other = await create(client);
    await startRun(client, other.id);
    const [second] = await untilOpened(t, other.id);
    expect(second?.ttlExpiresAt).toBe(at(5 * MINUTE + 90 * MINUTE));
  });

  it("is swept every 60 seconds: an expired prompt is denied by the TTL, the run is handed the deny and continues", async () => {
    const t = await start({ script: prompted("permission") });
    const client = await t.client();
    await setSettings(client, { "permissions.parkedPrompt.ttl": { amount: 1, unit: "minutes" } });
    const { id } = await create(client);
    t.clock.advance(30_000);
    const { runId } = await startRun(client, id);
    const [opened] = await untilOpened(t, id);
    expect(opened?.ttlExpiresAt).toBe(at(90_000));

    // The sweep at 60 s finds it not yet due, and none runs at 90 s.
    t.clock.advance(60_000);
    expect(answered(t, id)).toEqual([]);
    // The sweep at 120 s answers it.
    t.clock.advance(30_000);
    expect(answered(t, id)).toEqual([
      expect.objectContaining({ runId, promptId: "toolu_1", decision: "deny", decidedBy: { auto: "ttl" }, delivery: "live", message: expect.stringMatching(/^Denied: /) }),
    ]);
    const run = await untilEnded(t, id, runId);
    expect(run.payload).toMatchObject({ reason: "completed" });
    const message = answered(t, id)[0]?.message as string;
    expect(told(t, id)).toEqual([toldText({ decision: "deny", message })]);
    expect(t.adapter.lastRun().interrupted).toBe(false);
    expect(promptNotices(t)).toEqual(["prompt.parked", "prompt.resolved"]);
  });

  it("is swept at startup: a prompt that expired while the environment was down is denied and its answer kept for the next run", async () => {
    const dataDir = join(tempDir(), "data");
    const t = await start({ script: prompted("permission") }, { dataDir });
    const client = await t.client();
    await setSettings(client, { "permissions.parkedPrompt.ttl": { amount: 1, unit: "hours" } });
    const { id } = await create(client);
    await startRun(client, id);
    await untilOpened(t, id);
    await t.close();

    const again = await start({}, { dataDir, clock: manualClock(at(2 * HOUR)) });
    expect(answered(again, id)).toEqual([expect.objectContaining({ promptId: "toolu_1", decision: "deny", decidedBy: { auto: "ttl" }, delivery: "next-run" })]);
    expect(decisions(again, id)).toEqual([expect.objectContaining({ toolCallId: "toolu_1", decision: "denied", decidedBy: "ttl", promptId: "toolu_1" })]);
    const later = await again.client();
    const next = await startRun(later, id, "Carry on");
    await untilEnded(again, id, next.runId);
    const [kept, message] = again.adapter.lastRun().input.prompt;
    expect(kept?.text).toContain("sudo apt install jq");
    expect(kept?.text).toContain("Nobody answered");
    expect(message).toMatchObject({ text: "Carry on" });
  });

  it("set to never leaves a parked prompt parked however long it waits", async () => {
    const t = await start({ script: prompted("permission") });
    const client = await t.client();
    await setSettings(client, { "permissions.parkedPrompt.ttl": "never" });
    const { id } = await create(client);
    await startRun(client, id);
    const [opened] = await untilOpened(t, id);
    expect(opened?.ttlExpiresAt).toBeNull();
    await client.close();
    // Past the preset's 24 hours, sweep after sweep.
    t.clock.advance(25 * HOUR);
    expect(answered(t, id)).toEqual([]);
    expect((await (await t.client()).request("permissions.prompts.list", {})).prompts).toHaveLength(1);
  });
});

describe("tool.decision", () => {
  it("records a call the provider ran without asking as allowed by the mode, when it ends", async () => {
    const t = await start({ script: () => [started("t-1", "Bash", { command: "ls" }), ended("t-1"), end()] });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    await untilEnded(t, id, runId);
    expect(decisions(t, id)).toEqual([{ runId, toolCallId: "t-1", tool: "Bash", summary: "Bash: ls", decision: "allowed", decidedBy: "mode", promptId: null, reason: null }]);
    const types = eventsOf(t, id).map((event) => event.type);
    expect(types[types.indexOf("tool.ended") + 1]).toBe("tool.decision");
  });

  it("records a person's answer as the call's decision, once, with its prompt", async () => {
    const t = await start({ script: prompted("permission") });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    await untilOpened(t, id);
    await send(client, "permissions.prompts.answer", { promptId: "toolu_1", decision: "deny", message: "Not on this machine" });
    await untilEnded(t, id, runId);
    expect(decisions(t, id)).toEqual([
      { runId, toolCallId: "toolu_1", tool: "Bash", summary: "Claude wants to run sudo apt install jq", decision: "denied", decidedBy: "person", promptId: "toolu_1", reason: "Not on this machine" },
    ]);
  });

  it("records the unattended, bypass and denylist decisions of the automatic rules", async () => {
    const adapter = fakeAdapter();
    adapter.nextScripts.push(prompted("permission"), prompted("denylist"), prompted("permission", { ...permission, toolCallId: "toolu_7" }));
    const t = await start(adapter);
    const client = await t.client();
    const { id } = await create(client);
    const first = startAs(t, id, routine());
    await untilEnded(t, id, first.runId);
    const second = startAs(t, id, routine());
    await untilEnded(t, id, second.runId);
    const third = await startRun(client, id, "Go", "bypassPermissions");
    await untilEnded(t, id, third.runId);
    expect(decisions(t, id).map(({ toolCallId, decision, decidedBy, reason }) => ({ toolCallId, decision, decidedBy, reason }))).toEqual([
      { toolCallId: "toolu_1", decision: "denied", decidedBy: "unattended", reason: UNATTENDED_DENIAL },
      { toolCallId: "toolu_2", decision: "denied", decidedBy: "denylist", reason: UNATTENDED_DENIAL },
      { toolCallId: "toolu_7", decision: "denied", decidedBy: "bypass", reason: expect.stringMatching(/^Denied: /) },
    ]);
  });

  it("records a rule's denial from the provider's own denial report, and a failed call it did not report as allowed by the mode at the run's end", async () => {
    const script: Script = () => [
      started("t-1", "Read", { file_path: "/etc/shadow" }),
      { type: "denial", toolCallId: "t-1", toolName: "Read", by: "rule", reason: "Read(/etc/**) is denied by the account's settings" },
      ended("t-1", "error"),
      started("t-2", "Bash", { command: "false" }),
      ended("t-2", "error"),
      started("t-3", "WebFetch", { url: "https://example.com" }),
      { type: "denial", toolCallId: "t-3", toolName: "WebFetch", by: "classifier", reason: null },
      ended("t-3", "error"),
      end(),
    ];
    const t = await start({ script });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    await untilEnded(t, id, runId);
    expect(decisions(t, id)).toEqual([
      { runId, toolCallId: "t-1", tool: "Read", summary: "Read: /etc/shadow", decision: "denied", decidedBy: "rule", promptId: null, reason: "Read(/etc/**) is denied by the account's settings" },
      { runId, toolCallId: "t-3", tool: "WebFetch", summary: "WebFetch: https://example.com", decision: "denied", decidedBy: "classifier", promptId: null, reason: expect.any(String) },
      { runId, toolCallId: "t-2", tool: "Bash", summary: "Bash: false", decision: "allowed", decidedBy: "mode", promptId: null, reason: null },
    ]);
    // The ones decided at the run's end come in its transaction, just before its end.
    const types = eventsOf(t, id).map((event) => event.type);
    expect(types.slice(-2)).toEqual(["tool.decision", "run.ended"]);
  });

  it("is appended once per tool call whatever reports it: a prompted call's end and a late denial report add nothing", async () => {
    const script: Script = async function* ({ context, input }) {
      yield started("toolu_1", "Bash", { command: "sudo apt install jq" });
      const decision = await context.broker.request({ sessionId: input.sessionId, runId: input.runId, kind: "permission", detail: permission, promptId: "toolu_1" });
      yield say(toldText(decision));
      yield { type: "denial", toolCallId: "toolu_1", toolName: "Bash", by: "rule", reason: "Late" };
      yield ended("toolu_1", "error");
      yield started("t-2");
      yield ended("t-2");
      yield { type: "denial", toolCallId: "t-2", toolName: "Bash", by: "rule", reason: "After it ran" };
      yield end();
    };
    const t = await start({ script });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = startAs(t, id, routine());
    await untilEnded(t, id, runId);
    expect(decisions(t, id).map(({ toolCallId, decidedBy }) => [toolCallId, decidedBy])).toEqual([
      ["toolu_1", "unattended"],
      ["t-2", "mode"],
    ]);
  });

  it("records the TTL's denial, and a prompt the provider cancelled as the provider's", async () => {
    const abort = new AbortController();
    const adapter = fakeAdapter();
    adapter.nextScripts.push(prompted("permission"), ask("permission", { ...permission, toolCallId: "toolu_5" }, { promptId: "toolu_5", signal: abort.signal }));
    const t = await start(adapter);
    const client = await t.client();
    await setSettings(client, { "permissions.parkedPrompt.ttl": { amount: 1, unit: "minutes" } });
    const one = await create(client);
    const first = await startRun(client, one.id);
    await untilOpened(t, one.id);
    t.clock.advance(MINUTE);
    await untilEnded(t, one.id, first.runId);
    expect(decisions(t, one.id)).toEqual([expect.objectContaining({ toolCallId: "toolu_1", decision: "denied", decidedBy: "ttl", promptId: "toolu_1" })]);

    const two = await create(client);
    const second = await startRun(client, two.id);
    await untilOpened(t, two.id);
    abort.abort();
    await untilEnded(t, two.id, second.runId);
    expect(decisions(t, two.id)).toEqual([expect.objectContaining({ toolCallId: "toolu_5", decision: "denied", decidedBy: "provider", promptId: "toolu_5" })]);
  });
});
