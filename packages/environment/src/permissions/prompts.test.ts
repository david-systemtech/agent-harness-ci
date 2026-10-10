import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  EnvironmentNotice,
  SCOPES,
  SessionSnapshot,
  registry,
  type EventFrame,
  type Mode,
  type ParamsOf,
  type PromptAnsweredPayload,
  type PromptOpenedPayload,
  type ResponseOf,
  type Scope,
} from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { ask, end, fakeAdapter, gate, say, toldText, type FakeAdapter, type FakeAdapterOptions, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, get, listStream, patchOf, refusal } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";
import type { PromptDecision } from "../adapter/contract.js";
import type { EventEnvelope as LogEvent } from "../event-log/event-log.js";
import { DUPLICATE_PROMPT_MESSAGE, openedPayload } from "./broker.js";

/**
 * The permission broker and parked prompts through the primary seam
 * (permissions spec, "Prompts, parked prompts and the TTL", "Testing
 * Decisions"; ADR 0006, ADR 0007): an in-process environment with the
 * scripted fake adapter asking prompts, driven by real clients over real
 * WebSockets. What is asserted is what a client sees (the session's stream,
 * the list's patches, the notices on `environment.subscribe`,
 * `permissions.prompts.list`, receipts) and what the fake provider was told.
 */

const { onCleanup, tempDir } = useCleanups();

const MINUTE = 60_000;

/** The instant `ms` after the manual clock's start. */
const at = (ms: number): string => new Date(Date.parse(MANUAL_CLOCK_START) + ms).toISOString();

const start = async (adapter: FakeAdapterOptions | FakeAdapter = {}, options: Omit<TestEnvironmentOptions, "adapter"> = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ ...options, adapter: "descriptor" in adapter ? adapter : fakeAdapter(adapter) });
  onCleanup(() => t.close());
  return t;
};

type Command = "runs.start" | "permissions.prompts.answer" | "providers.processes.stop";

/** Sends a command with a fresh command id (unless one is given); resolves with its response, checked against its schema. */
const send = async <N extends Command>(client: WireClient, method: N, params: Omit<ParamsOf<N>, "commandId"> & { commandId?: string }): Promise<ResponseOf<N>> =>
  registry[method].response.parse(await client.request(method, { commandId: randomUUID(), ...params } as ParamsOf<N>)) as ResponseOf<N>;

const startRun = async (client: WireClient, sessionId: string, text = "Fix the receipts") => {
  const answer = await send(client, "runs.start", { sessionId, text });
  if (answer.result === undefined) throw new Error(`runs.start was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result;
};

/** Answers a prompt; resolves with the response (a receipt, and the result when this request applied it). */
const answer = (client: WireClient, promptId: string, params: Omit<ParamsOf<"permissions.prompts.answer">, "commandId" | "promptId"> & { commandId?: string }) =>
  send(client, "permissions.prompts.answer", { promptId, ...params });

/** A client of a client session paired with `ceiling` (every scope unless `scopes` says otherwise). */
const pairedClient = async (t: TestEnvironment, ceiling: Mode, scopes: readonly Scope[] = SCOPES) => t.client({ token: (await t.pair({ ceiling, scopes })).token });

const eventsOf = (t: TestEnvironment, sessionId: string) => t.env.log.readStream({ kind: "session", id: sessionId });
const typesOf = (t: TestEnvironment, sessionId: string) => eventsOf(t, sessionId).map((event) => event.type);
const ofType = (t: TestEnvironment, sessionId: string, type: string) => eventsOf(t, sessionId).filter((event) => event.type === type);

/** Resolves with the session's prompt.opened events once there are `count` of them. */
const untilOpened = async (t: TestEnvironment, sessionId: string, count = 1): Promise<PromptOpenedPayload[]> => {
  await vi.waitFor(() => expect(ofType(t, sessionId, "prompt.opened")).toHaveLength(count));
  return ofType(t, sessionId, "prompt.opened").map((event) => event.payload as PromptOpenedPayload);
};

const untilEnded = async (t: TestEnvironment, sessionId: string, runId: string): Promise<LogEvent> => {
  await vi.waitFor(() => expect(ofType(t, sessionId, "run.ended").some((event) => event.payload["runId"] === runId)).toBe(true));
  return ofType(t, sessionId, "run.ended").find((event) => event.payload["runId"] === runId) as LogEvent;
};

const answeredEvents = (t: TestEnvironment, sessionId: string): PromptAnsweredPayload[] =>
  ofType(t, sessionId, "prompt.answered").map((event) => event.payload as PromptAnsweredPayload);

/** What the fake provider's runs said they were told, in order. */
const told = (t: TestEnvironment, sessionId: string): string[] =>
  ofType(t, sessionId, "assistant.text")
    .map((event) => event.payload["text"] as string)
    .filter((text) => text.startsWith("Told "));

/** The environment's notices as a client subscribed to them sees them, after `synchronized`. */
const noticeStream = async (client: WireClient) => {
  const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: 0 });
  await client.next((f) => f.type === "synchronized" && "subscription" in f && f.subscription === subscription);
  return {
    next: async (type: string) => {
      const frame = await client.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription && f.event.type === type);
      return EnvironmentNotice.parse(frame.event);
    },
  };
};

const permission = {
  toolName: "Bash",
  toolCallId: "toolu_1",
  input: { command: "rm -rf build" },
  summary: "Claude wants to run rm -rf build",
  blockedPath: "/work/agent-harness/build",
  reason: "rm is not allowed without asking",
  suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm -rf build" }], behavior: "allow", destination: "session" }],
};

const question = {
  toolName: "AskUserQuestion",
  input: { questions: [] },
  questions: [
    { header: "Library", question: "Which date library?", options: [{ label: "date-fns", description: "Small" }, { label: "luxon", description: "Zones" }], multiSelect: false },
    { header: "Scope", question: "Which parts?", options: [{ label: "API", description: "" }, { label: "UI", description: "" }], multiSelect: true },
  ],
};

const plan = { toolName: "ExitPlanMode", input: { plan: "1. Read the receipts\n2. Fix them" }, plan: "1. Read the receipts\n2. Fix them" };

describe("a prompt", () => {
  it("is opened on its session's stream with its kind and fields, parks the run, and is answered once by a person, whose answer reaches the run", async () => {
    const t = await start({ script: ask("permission", permission, { promptId: "toolu_1" }) });
    const client = await t.client();
    const workspace = await tempDir();
    const { id } = await create(client, { workspace: { kind: "directory", path: workspace } });
    const { runId } = await startRun(client, id);

    const [opened] = await untilOpened(t, id);
    expect(opened).toEqual({
      runId,
      promptId: "toolu_1",
      kind: "permission",
      toolName: "Bash",
      toolCallId: "toolu_1",
      input: { command: "rm -rf build" },
      previewLines: ["⚠ nothing matching is there, so nothing would be deleted"],
      summary: "Claude wants to run rm -rf build",
      blockedPath: "/work/agent-harness/build",
      reason: "rm is not allowed without asking",
      questions: null,
      plan: null,
      suggestions: permission.suggestions,
      agentId: null,
      denylist: null,
      // The run's mode when it asked, and the ceiling it was resolved under (a local bootstrap session's: the top one).
      mode: "acceptEdits",
      ceiling: "bypassPermissions",
      // Fixed as it opens from permissions.parkedPrompt.ttl, preset 24 hours (#131).
      ttlExpiresAt: at(24 * 60 * MINUTE),
    });
    const openedEvent = ofType(t, id, "prompt.opened")[0];
    expect(openedEvent).toMatchObject({ correlationId: runId, actor: "adapter:fake" });
    expect(await get(client, id)).toMatchObject({ parkedPromptCount: 1, activity: { state: "parked", since: at(0) } });
    expect((await client.request("environment.status", {})).activity).toEqual({ state: "busy", reason: "parked-prompt", busyUntil: at(10 * MINUTE) });

    t.clock.advance(2 * MINUTE);
    const answered = await answer(client, "toolu_1", { decision: "allow", message: "Go ahead" });
    expect(answered.receipt.status).toBe("accepted");
    expect(answered.result).toEqual({
      sessionId: id,
      runId,
      promptId: "toolu_1",
      decision: "allow",
      message: "Go ahead",
      answers: null,
      updatedInput: null,
      mode: null,
      remember: null,
      decidedBy: client.hello.clientSessionId,
      delivery: "live",
    });
    // The answer reaches the run through the adapter, and settles the request it asked.
    await untilEnded(t, id, runId);
    expect(told(t, id)).toEqual([toldText({ decision: "allow", message: "Go ahead" })]);
    expect(answeredEvents(t, id)).toHaveLength(1);
    expect(ofType(t, id, "prompt.answered")[0]).toMatchObject({ actor: `client_session:${client.hello.clientSessionId}`, correlationId: runId });
    expect(await get(client, id)).toMatchObject({ parkedPromptCount: 0, activity: { state: "idle" }, lastActivityAt: at(2 * MINUTE) });
  });

  it("hands the adapter the answer through answerPrompt, with its id", async () => {
    const t = await start({ script: ask("permission", permission, { promptId: "toolu_1" }) });
    const client = await t.client();
    const { id } = await create(client);
    await startRun(client, id);
    await untilOpened(t, id);
    expect(t.adapter.lastRun().answers).toEqual([]);
    await answer(client, "toolu_1", { decision: "deny", message: "Not today" });
    await vi.waitFor(() => expect(told(t, id)).toEqual([toldText({ decision: "deny", message: "Not today" })]));
    expect(t.adapter.lastRun().answers).toEqual([{ promptId: "toolu_1", decision: { decision: "deny", message: "Not today" } }]);
  });

  it("patches parkedPromptCount and activity on the list stream from the prompt events", async () => {
    const asked = gate();
    const t = await start({
      script: async function* ({ context, input }) {
        yield say("Working");
        const first = context.broker.request({ sessionId: input.sessionId, runId: input.runId, promptId: "p-1", kind: "permission", detail: { toolName: "Bash" } });
        const second = context.broker.request({ sessionId: input.sessionId, runId: input.runId, promptId: "p-2", kind: "question", detail: question });
        asked.open();
        yield say(toldText(await first));
        yield say(toldText(await second));
        yield end();
      },
    });
    const client = await t.client();
    const { id } = await create(client);
    const list = await listStream(client, t.env.log.head());
    const { runId } = await startRun(client, id);
    await asked.opened;
    await untilOpened(t, id, 2);

    const patches: { type: string; fields: unknown }[] = [];
    const take = async (count: number) => {
      for (let i = 0; i < count; ) {
        const event = await list.next();
        const patch = patchOf(event);
        if (event.type.startsWith("prompt.") && patch.op === "set") {
          patches.push({ type: event.type, fields: { parkedPromptCount: patch.fields.parkedPromptCount, activity: patch.fields.activity } });
        }
        if (event.type.startsWith("prompt.")) i++;
      }
    };
    await take(2);
    t.clock.advance(MINUTE);
    await answer(client, "p-2", { decision: "allow", answers: { "Which date library?": "luxon", "Which parts?": "API, UI" } });
    await answer(client, "p-1", { decision: "allow" });
    await take(2);
    await untilEnded(t, id, runId);
    expect(patches).toEqual([
      { type: "prompt.opened", fields: { parkedPromptCount: 1, activity: { state: "parked", since: at(0) } } },
      { type: "prompt.opened", fields: { parkedPromptCount: 2, activity: undefined } },
      { type: "prompt.answered", fields: { parkedPromptCount: 1, activity: undefined } },
      { type: "prompt.answered", fields: { parkedPromptCount: 0, activity: { state: "running", since: at(MINUTE) } } },
    ]);
  });
});

describe("the notices", () => {
  it("raise prompt.parked and then prompt.resolved on environment.subscribe, seen by two connected clients; one answers and the other is refused already_answered", async () => {
    const t = await start({ script: ask("question", question, { promptId: "q-1" }) });
    const first = await t.client();
    const second = await t.client({ token: (await t.bootstrap("desktop", "the desktop")).token });
    const firstNotices = await noticeStream(first);
    const secondNotices = await noticeStream(second);
    const { id } = await create(first);
    const { runId } = await startRun(first, id);

    const parked = { type: "prompt.parked", payload: { sessionId: id, runId, promptId: "q-1", kind: "question", title: "Fix the receipts", summary: "Which date library?" } };
    expect(await firstNotices.next("prompt.parked")).toEqual(parked);
    expect(await secondNotices.next("prompt.parked")).toEqual(parked);

    const answers = { "Which date library?": "date-fns", "Which parts?": "API" };
    const won = await answer(second, "q-1", { decision: "allow", answers });
    expect(won.result).toMatchObject({ decidedBy: second.hello.clientSessionId, answers, delivery: "live" });
    const lost = await answer(first, "q-1", { decision: "deny" });
    expect(lost.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "already_answered", promptId: "q-1" } } });

    const resolved = { type: "prompt.resolved", payload: { sessionId: id, runId, promptId: "q-1", decision: "allow", decidedBy: second.hello.clientSessionId } };
    expect(await firstNotices.next("prompt.resolved")).toEqual(resolved);
    expect(await secondNotices.next("prompt.resolved")).toEqual(resolved);
    await untilEnded(t, id, runId);
    expect(told(t, id)).toEqual([toldText({ decision: "allow", answers })]);
    expect(answeredEvents(t, id)).toHaveLength(1);
  });
});

describe("the notices of a prompt a rule answers at once", () => {
  it("are never raised: the prompt never parked (the seam #131 fills)", async () => {
    const t = await start(
      { script: ask("permission", permission, { promptId: "p-1" }) },
      { adapterSeams: { autoAnswer: () => ({ auto: "unattended", decision: { decision: "deny", message: "Nobody is present." } }) } },
    );
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    await untilEnded(t, id, runId);
    expect(answeredEvents(t, id)).toEqual([expect.objectContaining({ decidedBy: { auto: "unattended" }, decision: "deny" })]);
    expect(told(t, id)).toEqual([toldText({ decision: "deny", message: "Nobody is present." })]);
    const notices = t.env.log.readStream({ kind: "environment", id: t.env.id }).map((event) => event.type);
    expect(notices.filter((type) => type.startsWith("prompt."))).toEqual([]);
    expect(await get(client, id)).toMatchObject({ parkedPromptCount: 0 });
  });
});

describe("a prompt a rule answers at once", () => {
  it("records the mode and the remember the rule gives, the mode clamped to the run's ceiling as a person's is, and hands the run the same", async () => {
    const adapter = fakeAdapter();
    adapter.nextScripts.push(ask("plan", plan, { promptId: "plan-auto" }), ask("permission", permission, { promptId: "perm-auto" }));
    const t = await start(adapter, {
      adapterSeams: {
        autoAnswer: ({ kind }) =>
          kind === "plan"
            ? { auto: "unattended", decision: { decision: "allow", mode: "bypassPermissions" } }
            : { auto: "unattended", decision: { decision: "allow", remember: "session" } },
      },
    });
    const low = await pairedClient(t, "acceptEdits");
    const one = await create(low);
    const first = await startRun(low, one.id);
    await untilEnded(t, one.id, first.runId);
    expect(answeredEvents(t, one.id)).toEqual([
      expect.objectContaining({
        promptId: "plan-auto",
        decision: "allow",
        decidedBy: { auto: "unattended" },
        mode: { requested: "bypassPermissions", effective: "acceptEdits", ceiling: "acceptEdits", clamped: true, clampReason: "ceiling" },
        remember: null,
      }),
    ]);
    expect(told(t, one.id)).toEqual([toldText({ decision: "allow", mode: "acceptEdits" })]);

    const two = await create(low);
    const second = await startRun(low, two.id);
    await untilEnded(t, two.id, second.runId);
    expect(answeredEvents(t, two.id)).toEqual([expect.objectContaining({ promptId: "perm-auto", decision: "allow", mode: null, remember: "session" })]);
    expect(told(t, two.id)).toEqual([toldText({ decision: "allow", remember: "session" })]);
  });
});

describe("permissions.prompts.list", () => {
  it("returns every parked prompt of the environment, or of one session, oldest first; an answered one leaves it", async () => {
    const adapter = fakeAdapter();
    adapter.nextScripts.push(ask("permission", permission, { promptId: "p-a" }), ask("plan", plan, { promptId: "p-b" }));
    const t = await start(adapter);
    const client = await t.client();
    const one = await create(client);
    const two = await create(client);
    await startRun(client, one.id);
    await untilOpened(t, one.id);
    t.clock.advance(MINUTE);
    await startRun(client, two.id, "Plan it");
    await untilOpened(t, two.id);

    const all = await client.request("permissions.prompts.list", {});
    expect(all.prompts.map((prompt) => [prompt.sessionId, prompt.promptId, prompt.openedAt, prompt.prompt.kind])).toEqual([
      [one.id, "p-a", at(0), "permission"],
      [two.id, "p-b", at(MINUTE), "plan"],
    ]);
    expect(all.prompts[1]).toMatchObject({ sequence: ofType(t, two.id, "prompt.opened")[0]?.sequence, prompt: { plan: plan.plan } });
    expect((await client.request("permissions.prompts.list", { sessionId: two.id })).prompts.map((prompt) => prompt.promptId)).toEqual(["p-b"]);

    await answer(client, "p-a", { decision: "deny" });
    expect((await client.request("permissions.prompts.list", {})).prompts.map((prompt) => prompt.promptId)).toEqual(["p-b"]);
    const reader = await pairedClient(t, "plan", ["read"]);
    expect((await reader.request("permissions.prompts.list", {})).prompts).toHaveLength(1);
    expect(await refusal(reader.request("permissions.prompts.answer", { commandId: randomUUID(), promptId: "p-b", decision: "allow" }))).toEqual({
      code: "forbidden",
      data: { scope: "runs:drive" },
    });
  });

  it("refuses a session that is not on the environment not_found, kind session, as every query naming a session does", async () => {
    const t = await start();
    const client = await t.client();
    const unknown = randomUUID();
    expect(await refusal(client.request("permissions.prompts.list", { sessionId: unknown }))).toEqual({ code: "not_found", data: { kind: "session", sessionId: unknown } });
  });
});

describe("permissions.prompts.answer", () => {
  it("records a browser permission allowance immediately when the asking run has stopped", async () => {
    const browser = { toolName: "mcp__browser__browser_open", toolCallId: "browser-permission-for-tests", input: { address: "https://shop.example/" } };
    const t = await start({ script: ask("permission", browser, { promptId: "browser-permission" }) });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    await untilOpened(t, id);
    await send(client, "providers.processes.stop", { sessionId: id });
    await untilEnded(t, id, runId);
    expect((await answer(client, "browser-permission", { decision: "allow" })).result).toMatchObject({ delivery: "next-run" });
    expect(ofType(t, id, "tool.decision").map((event) => event.payload)).toEqual([
      expect.objectContaining({ toolCallId: browser.toolCallId, promptId: "browser-permission", decision: "allowed", decidedBy: "person" }),
    ]);
  });

  it("leaves a deleted session's prompts out of the list and refuses to answer them not_found, until the session is restored", async () => {
    const t = await start({ script: ask("permission", permission, { promptId: "p-1" }) });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    await untilOpened(t, id);
    await client.request("sessions.delete", { commandId: randomUUID(), sessionId: id });
    // The deletion lets the run go: its prompt stays open in the log, for a restore.
    await untilEnded(t, id, runId);
    expect((await client.request("permissions.prompts.list", {})).prompts).toEqual([]);
    expect((await answer(client, "p-1", { decision: "allow" })).receipt).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "session", sessionId: id } } });
    await client.request("sessions.restore", { commandId: randomUUID(), sessionId: id });
    expect((await client.request("permissions.prompts.list", {})).prompts.map((prompt) => prompt.promptId)).toEqual(["p-1"]);
    expect((await answer(client, "p-1", { decision: "allow" })).result).toMatchObject({ delivery: "next-run" });
  });

  it("refuses an unknown prompt not_found and a second answer conflict already_answered, and replays a retried command's receipt", async () => {
    const t = await start({ script: ask("permission", permission, { promptId: "toolu_1" }) });
    const client = await t.client();
    const { id } = await create(client);
    await startRun(client, id);
    await untilOpened(t, id);
    expect((await answer(client, "nope", { decision: "allow" })).receipt).toMatchObject({
      status: "rejected",
      reason: "not_found",
      error: { data: { kind: "prompt", promptId: "nope" } },
    });
    const commandId = randomUUID();
    const first = await answer(client, "toolu_1", { decision: "allow", commandId });
    expect(first.receipt.status).toBe("accepted");
    // The same command again answers from its receipt: it applied once.
    expect(await answer(client, "toolu_1", { decision: "allow", commandId })).toEqual({ receipt: first.receipt });
    expect((await answer(client, "toolu_1", { decision: "deny" })).receipt).toMatchObject({
      status: "rejected",
      reason: "conflict",
      error: { data: { reason: "already_answered", promptId: "toolu_1" } },
    });
    expect(answeredEvents(t, id)).toHaveLength(1);
  });

  it("takes edited input, and remember 'session' on a permission prompt only, with an allow", async () => {
    const adapter = fakeAdapter();
    adapter.nextScripts.push(ask("permission", permission, { promptId: "p-1" }));
    const t = await start(adapter);
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    await untilOpened(t, id);
    expect(await refusal(client.request("permissions.prompts.answer", { commandId: randomUUID(), promptId: "p-1", decision: "deny", remember: "session" }))).toMatchObject({
      code: "invalid_params",
    });
    expect(await refusal(client.request("permissions.prompts.answer", { commandId: randomUUID(), promptId: "p-1", decision: "allow", mode: "plan" }))).toMatchObject({
      code: "invalid_params",
    });
    const edited = { command: "rm -rf build/cache" };
    const given = await answer(client, "p-1", { decision: "allow", updatedInput: edited, remember: "session" });
    expect(given.result).toMatchObject({ updatedInput: edited, remember: "session", mode: null });
    await untilEnded(t, id, runId);
    expect(told(t, id)).toEqual([toldText({ decision: "allow", updatedInput: edited, remember: "session" })]);

    for (const [kind, detail] of [["question", question], ["plan", plan], ["denylist", permission]] as const) {
      adapter.nextScripts.push(ask(kind, detail, { promptId: `p-${kind}` }));
      const session = await create(client);
      await startRun(client, session.id);
      await untilOpened(t, session.id);
      expect(
        await refusal(client.request("permissions.prompts.answer", { commandId: randomUUID(), promptId: `p-${kind}`, decision: "allow", remember: "session" })),
        kind,
      ).toMatchObject({ code: "invalid_params" });
      if (kind !== "question") {
        expect(await refusal(client.request("permissions.prompts.answer", { commandId: randomUUID(), promptId: `p-${kind}`, decision: "allow", answers: { a: "b" } })), kind).toMatchObject({
          code: "invalid_params",
        });
      }
    }
  });

  it("refuses edited input on anything but a permission prompt, and a mode on a denied plan, invalid_params; the prompts stay parked", async () => {
    const adapter = fakeAdapter();
    const t = await start(adapter);
    const client = await t.client();
    for (const [kind, detail] of [["question", question], ["plan", plan], ["denylist", permission]] as const) {
      adapter.nextScripts.push(ask(kind, detail, { promptId: `p-${kind}` }));
      const session = await create(client);
      await startRun(client, session.id);
      await untilOpened(t, session.id);
      const edited = client.request("permissions.prompts.answer", { commandId: randomUUID(), promptId: `p-${kind}`, decision: "allow", updatedInput: { command: "ls" } });
      expect(await refusal(edited), kind).toMatchObject({ code: "invalid_params" });
    }
    const deniedWithMode = client.request("permissions.prompts.answer", { commandId: randomUUID(), promptId: "p-plan", decision: "deny", mode: "acceptEdits" });
    expect(await refusal(deniedWithMode)).toMatchObject({ code: "invalid_params" });
    expect((await client.request("permissions.prompts.list", {})).prompts.map((prompt) => prompt.promptId)).toEqual(["p-question", "p-plan", "p-denylist"]);
  });

  it("refuses an id parked in two sessions conflict ambiguous_prompt unless the session is named, and answers an id parked in one session only whichever session answered it last", async () => {
    const t = await start();
    const client = await t.client();
    const one = await create(client);
    const two = await create(client);
    // Seeded below the adapter: the Claude adapter's ids are unique per call, so only another adapter could ask one id in two sessions.
    for (const session of [one, two]) {
      const opened = openedPayload({ runId: randomUUID(), promptId: "dup", kind: "permission", detail: permission, mode: "acceptEdits", ceiling: "acceptEdits", ttlExpiresAt: null });
      t.env.log.append({ kind: "session", id: session.id }, [{ type: "prompt.opened", payload: opened }], { actor: "adapter:fake", correlationId: opened.runId });
    }

    expect((await answer(client, "dup", { decision: "allow" })).receipt).toMatchObject({
      status: "rejected",
      reason: "conflict",
      error: { data: { reason: "ambiguous_prompt", promptId: "dup", sessionIds: [one.id, two.id] } },
    });
    expect((await answer(client, "dup", { decision: "deny", sessionId: two.id })).result).toMatchObject({ sessionId: two.id, decision: "deny", delivery: "next-run" });
    // The older one, in the other session, is the one still parked: it is answered without naming its session.
    expect((await answer(client, "dup", { decision: "allow" })).result).toMatchObject({ sessionId: one.id, decision: "allow", delivery: "next-run" });
    expect((await answer(client, "dup", { decision: "allow", sessionId: one.id })).receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "already_answered" } } });
    const other = await create(client);
    expect((await answer(client, "dup", { decision: "allow", sessionId: other.id })).receipt).toMatchObject({
      status: "rejected",
      reason: "not_found",
      error: { data: { kind: "prompt", promptId: "dup" } },
    });
    expect(ofType(t, one.id, "prompt.answered")).toHaveLength(1);
    expect(ofType(t, two.id, "prompt.answered")).toHaveLength(1);
  });

  it("leaves a deleted session's prompt out of an id's sessions: it makes no id ambiguous until the session is restored", async () => {
    const t = await start();
    const client = await t.client();
    const one = await create(client);
    const two = await create(client);
    const park = (sessionId: string) => {
      const opened = openedPayload({ runId: randomUUID(), promptId: "dup", kind: "permission", detail: permission, mode: "acceptEdits", ceiling: "acceptEdits", ttlExpiresAt: null });
      t.env.log.append({ kind: "session", id: sessionId }, [{ type: "prompt.opened", payload: opened }], { actor: "adapter:fake", correlationId: opened.runId });
    };
    park(one.id);
    park(two.id);
    await client.request("sessions.delete", { commandId: randomUUID(), sessionId: one.id });
    // The deleted session's prompt is neither a second holder of the id nor named: the live session's is answered.
    expect((await answer(client, "dup", { decision: "deny" })).result).toMatchObject({ sessionId: two.id, decision: "deny" });
    park(two.id);
    await client.request("sessions.restore", { commandId: randomUUID(), sessionId: one.id });
    expect((await answer(client, "dup", { decision: "allow" })).receipt).toMatchObject({
      status: "rejected",
      reason: "conflict",
      error: { data: { reason: "ambiguous_prompt", promptId: "dup", sessionIds: [one.id, two.id] } },
    });
    expect(ofType(t, one.id, "prompt.answered")).toEqual([]);
  });

  it("continues an approved plan in acceptEdits when no mode is given, and in the mode given clamped to the run's ceiling, not the answering client's", async () => {
    const adapter = fakeAdapter();
    const t = await start(adapter);
    // A run started under an acceptEdits ceiling: a plan's mode is clamped to it.
    const low = await pairedClient(t, "acceptEdits");
    adapter.nextScripts.push(ask("plan", plan, { promptId: "plan-1" }));
    const one = await create(low);
    await startRun(low, one.id);
    const [opened] = await untilOpened(t, one.id);
    expect(opened).toMatchObject({ ceiling: "acceptEdits", plan: plan.plan, summary: "1. Read the receipts" });
    const clamped = await answer(await t.client(), "plan-1", { decision: "allow", mode: "bypassPermissions" });
    expect(clamped.result?.mode).toEqual({ requested: "bypassPermissions", effective: "acceptEdits", ceiling: "acceptEdits", clamped: true, clampReason: "ceiling" });
    await vi.waitFor(() => expect(told(t, one.id)).toEqual([toldText({ decision: "allow", mode: "acceptEdits" })]));

    // A run under the top ceiling, answered from a client whose own ceiling is plan: the answer is not bounded by it.
    adapter.nextScripts.push(ask("plan", plan, { promptId: "plan-2" }), ask("plan", plan, { promptId: "plan-3" }));
    const high = await t.client();
    const two = await create(high);
    const { runId } = await startRun(high, two.id);
    await untilOpened(t, two.id);
    const planClient = await pairedClient(t, "plan", ["read", "runs:drive"]);
    const raised = await answer(planClient, "plan-2", { decision: "allow", mode: "bypassPermissions" });
    expect(raised.result).toMatchObject({
      decidedBy: planClient.hello.clientSessionId,
      mode: { requested: "bypassPermissions", effective: "bypassPermissions", ceiling: "bypassPermissions", clamped: false, clampReason: null },
    });
    await untilEnded(t, two.id, runId);
    // The session continues in the plan's mode: its next runs ask for it.
    expect(await get(high, two.id)).toMatchObject({ mode: "bypassPermissions" });
    expect(ofType(t, two.id, "session.mode.set").map((event) => event.payload)).toEqual([
      { mode: { requested: "bypassPermissions", effective: "bypassPermissions", ceiling: "bypassPermissions", clamped: false, clampReason: null }, live: { runId, mode: "bypassPermissions" } },
    ]);

    const three = await create(high);
    await startRun(high, three.id);
    await untilOpened(t, three.id);
    const bare = await answer(planClient, "plan-3", { decision: "allow" });
    expect(bare.result?.mode).toEqual({ requested: null, effective: "acceptEdits", ceiling: "bypassPermissions", clamped: false, clampReason: null });
    // A denied plan has no mode to continue in.
    adapter.nextScripts.push(ask("plan", plan, { promptId: "plan-4" }));
    const four = await create(high);
    await startRun(high, four.id);
    await untilOpened(t, four.id);
    expect((await answer(planClient, "plan-4", { decision: "deny", message: "Smaller steps" })).result?.mode).toBeNull();
    expect(ofType(t, four.id, "session.mode.set")).toEqual([]);
  });

  it("records the session's mode as permissions.mode.set would when a bare approval's acceptEdits is lowered to the run's ceiling: asked for, and clamped", async () => {
    const adapter = fakeAdapter();
    const t = await start(adapter);
    const planOnly = await pairedClient(t, "plan");
    adapter.nextScripts.push(ask("plan", plan, { promptId: "plan-low" }));
    const session = await create(planOnly);
    const { runId } = await startRun(planOnly, session.id);
    await untilOpened(t, session.id);
    const bare = await answer(await t.client(), "plan-low", { decision: "allow" });
    // The answer records that none was asked for; the session's record, that its default was, and lowered.
    expect(bare.result?.mode).toEqual({ requested: null, effective: "plan", ceiling: "plan", clamped: false, clampReason: null });
    await untilEnded(t, session.id, runId);
    expect(ofType(t, session.id, "session.mode.set").map((event) => event.payload)).toEqual([
      { mode: { requested: "acceptEdits", effective: "plan", ceiling: "plan", clamped: true, clampReason: "ceiling" }, live: { runId, mode: "plan" } },
    ]);
  });

  it("refuses to record an answer that does not fit its prompt's kind, whoever appends it: the prompt stays parked", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const opened = openedPayload({ runId: randomUUID(), promptId: "p-fit", kind: "permission", detail: permission, mode: "acceptEdits", ceiling: "acceptEdits", ttlExpiresAt: null });
    const stream = { kind: "session", id };
    t.env.log.append(stream, [{ type: "prompt.opened", payload: opened }], { actor: "adapter:fake", correlationId: opened.runId });
    const answered: PromptAnsweredPayload = {
      runId: opened.runId,
      promptId: "p-fit",
      decision: "allow",
      message: null,
      answers: null,
      updatedInput: null,
      mode: null,
      remember: null,
      decidedBy: { auto: "unattended" },
      delivery: "live",
    };
    const unfit: Partial<PromptAnsweredPayload>[] = [
      { answers: { "Which library?": "luxon" } },
      { mode: { requested: "auto", effective: "auto", ceiling: "auto", clamped: false, clampReason: null } },
      { decision: "deny", remember: "session" },
    ];
    for (const parts of unfit) {
      expect(() => t.env.log.append(stream, [{ type: "prompt.answered", payload: { ...answered, ...parts } }], { actor: "adapter:fake" }), JSON.stringify(parts)).toThrow(/does not fit/);
    }
    expect((await client.request("permissions.prompts.list", {})).prompts.map((prompt) => prompt.promptId)).toEqual(["p-fit"]);
    t.env.log.append(stream, [{ type: "prompt.answered", payload: { ...answered, updatedInput: { command: "ls" }, remember: "session" } }], { actor: "adapter:fake" });
    expect((await client.request("permissions.prompts.list", {})).prompts).toEqual([]);
  });
});

describe("a prompt whose run ends", () => {
  it("closes with auto run_ended when the run ends on its own, denied to the adapter, before the run's end", async () => {
    const ending = gate();
    const decisions: PromptDecision[] = [];
    const t = await start({
      script: async function* ({ context, input }) {
        yield say("Working");
        void context.broker.request({ sessionId: input.sessionId, runId: input.runId, promptId: "p-1", kind: "permission", detail: permission }).then((d) => decisions.push(d));
        await ending.opened;
        yield end("error", { error: { message: "The provider fell over.", code: null } });
      },
    });
    const client = await t.client();
    const notices = await noticeStream(client);
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    await untilOpened(t, id);
    ending.open();
    await untilEnded(t, id, runId);

    // The call's decision rides with its answer (#131).
    expect(typesOf(t, id).slice(-3)).toEqual(["prompt.answered", "tool.decision", "run.ended"]);
    expect(answeredEvents(t, id)).toEqual([
      { runId, promptId: "p-1", decision: "deny", message: null, answers: null, updatedInput: null, mode: null, remember: null, decidedBy: { auto: "run_ended" }, delivery: null },
    ]);
    expect(ofType(t, id, "prompt.answered")[0]).toMatchObject({ actor: "system:adapter-host", correlationId: runId });
    expect(await notices.next("prompt.resolved")).toEqual({ type: "prompt.resolved", payload: { sessionId: id, runId, promptId: "p-1", decision: "deny", decidedBy: { auto: "run_ended" } } });
    await vi.waitFor(() => expect(decisions).toEqual([expect.objectContaining({ decision: "deny" })]));
    expect(await get(client, id)).toMatchObject({ parkedPromptCount: 0, activity: { state: "idle" } });
    expect((await answer(client, "p-1", { decision: "allow" })).receipt).toMatchObject({ reason: "conflict", error: { data: { reason: "already_answered" } } });
  });

  it("stays open in the log when its process is stopped, the run's prompts denied in memory; an answer then goes to the session's next run as its first message", async () => {
    const decisions: PromptDecision[] = [];
    const adapter = fakeAdapter();
    adapter.nextScripts.push(async function* ({ context, input }) {
      yield say("Working");
      decisions.push(await context.broker.request({ sessionId: input.sessionId, runId: input.runId, promptId: "p-1", kind: "permission", detail: permission }));
    });
    const t = await start(adapter);
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    await untilOpened(t, id);

    // An admin stops the process under the parked run: the run ends interrupted, and nothing answers its prompt.
    await send(client, "providers.processes.stop", { sessionId: id });
    expect(await untilEnded(t, id, runId)).toMatchObject({ payload: { reason: "interrupted", cause: "user" } });
    await vi.waitFor(() => expect(decisions).toEqual([expect.objectContaining({ decision: "deny" })]));
    expect(typesOf(t, id)).not.toContain("prompt.answered");
    expect(await get(client, id)).toMatchObject({ parkedPromptCount: 1, activity: { state: "parked" } });
    expect((await client.request("permissions.prompts.list", { sessionId: id })).prompts.map((prompt) => prompt.promptId)).toEqual(["p-1"]);

    const given = await answer(client, "p-1", { decision: "allow", message: "Yes, clear it" });
    expect(given.result).toMatchObject({ decision: "allow", delivery: "next-run", decidedBy: client.hello.clientSessionId });
    expect(await get(client, id)).toMatchObject({ parkedPromptCount: 0, activity: { state: "idle" } });

    const next = await startRun(client, id, "Carry on");
    await untilEnded(t, id, next.runId);
    const [delivered, message] = t.adapter.lastRun().input.prompt;
    expect(delivered?.text).toContain("Claude wants to run rm -rf build");
    expect(delivered?.text).toContain("allowed");
    expect(delivered?.text).toContain("Yes, clear it");
    expect(message).toMatchObject({ text: "Carry on" });
    // Delivered once: the run after it does not carry it again.
    const after = await startRun(client, id, "And again");
    await untilEnded(t, id, after.runId);
    expect(t.adapter.lastRun().input.prompt.map((m) => m.text)).toEqual(["And again"]);
  });

  it("keeps an answer given while a newer run is live for the run after it", async () => {
    const held = gate();
    const adapter = fakeAdapter();
    adapter.nextScripts.push(ask("permission", permission, { promptId: "p-1" }), async function* () {
      await held.opened;
      yield end();
    });
    const t = await start(adapter);
    const client = await t.client();
    const { id } = await create(client);
    const first = await startRun(client, id);
    await untilOpened(t, id);
    await send(client, "providers.processes.stop", { sessionId: id });
    await untilEnded(t, id, first.runId);

    const newer = await startRun(client, id, "Something else");
    expect((await answer(client, "p-1", { decision: "deny", message: "Leave the build" })).result).toMatchObject({ delivery: "next-run" });
    held.open();
    await untilEnded(t, id, newer.runId);
    expect(t.adapter.lastRun().input.prompt.map((message) => message.text)).toEqual(["Something else"]);

    const after = await startRun(client, id, "Carry on");
    await untilEnded(t, id, after.runId);
    const [delivered, message] = t.adapter.lastRun().input.prompt;
    expect(delivered?.text).toContain("Leave the build");
    expect(message).toMatchObject({ text: "Carry on" });
  });

  it("keeps an answer for the run after a next run whose adapter never received it, as its messages are queued again", async () => {
    const adapter = fakeAdapter();
    adapter.nextScripts.push(ask("permission", permission, { promptId: "p-1" }));
    const create_ = adapter.createRun;
    let calls = 0;
    const t = await start({
      ...adapter,
      createRun: (input, context) => {
        calls += 1;
        if (calls === 2) throw new Error("No process could be started.");
        return create_(input, context);
      },
    });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    await untilOpened(t, id);
    await send(client, "providers.processes.stop", { sessionId: id });
    await untilEnded(t, id, runId);
    expect((await answer(client, "p-1", { decision: "allow", message: "Yes, clear it" })).result).toMatchObject({ delivery: "next-run" });

    // The next run takes the answer, but its adapter never receives it: the answer waits for the run after, with the message.
    const failed = await startRun(client, id, "Carry on");
    expect(await untilEnded(t, id, failed.runId)).toMatchObject({ payload: { reason: "error" } });
    const next = await startRun(client, id, "Try again");
    await untilEnded(t, id, next.runId);
    expect(calls).toBe(3);
    const texts = t.adapter.lastRun().input.prompt.map((message) => message.text);
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain("Yes, clear it");
    expect(texts.slice(1)).toEqual(["Carry on", "Try again"]);
  });

  it("is cancelled when the provider cancels the request, and the run goes on", async () => {
    const cancel = new AbortController();
    const t = await start({
      script: async function* ({ context, input }) {
        yield say("Working");
        const request = context.broker.request({ sessionId: input.sessionId, runId: input.runId, promptId: "p-1", kind: "permission", detail: permission, signal: cancel.signal });
        yield say(toldText(await request));
        yield end();
      },
    });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    await untilOpened(t, id);
    cancel.abort();
    await untilEnded(t, id, runId);
    expect(answeredEvents(t, id)).toEqual([expect.objectContaining({ promptId: "p-1", decision: "deny", decidedBy: { auto: "cancelled" }, delivery: null })]);
    expect(await get(client, id)).toMatchObject({ parkedPromptCount: 0 });
  });

  it("denies at once a second request under the id of one its run holds open, recording nothing, and the first is still answered", async () => {
    const twice: Script = async function* ({ context, input }) {
      yield say("Working");
      const request = { sessionId: input.sessionId, runId: input.runId, promptId: "dup-1", kind: "permission" as const, detail: permission };
      const first = context.broker.request(request);
      yield say(toldText(await context.broker.request(request)));
      yield say(toldText(await first));
      yield end();
    };
    const t = await start({ script: twice });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    await vi.waitFor(() => expect(told(t, id)).toHaveLength(1));
    expect(told(t, id)).toEqual([toldText({ decision: "deny", message: DUPLICATE_PROMPT_MESSAGE })]);
    await untilOpened(t, id);
    expect(ofType(t, id, "prompt.opened")).toHaveLength(1);
    expect((await answer(client, "dup-1", { decision: "allow" })).result).toMatchObject({ delivery: "live" });
    await untilEnded(t, id, runId);
    expect(told(t, id)).toEqual([toldText({ decision: "deny", message: DUPLICATE_PROMPT_MESSAGE }), toldText({ decision: "allow" })]);
    expect(answeredEvents(t, id)).toEqual([expect.objectContaining({ promptId: "dup-1", decision: "allow", delivery: "live" })]);
  });
});

describe("a restart", () => {
  it("rebuilds open prompts from the log, listed where they were; an answer is the resumed run's first message", async () => {
    const dataDir = join(tempDir(), "data");
    const t = await start({ script: ask("question", question, { promptId: "q-1" }) }, { dataDir });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    const [opened] = await untilOpened(t, id);
    const sequence = ofType(t, id, "prompt.opened")[0]?.sequence;
    t.clock.advance(3 * MINUTE);
    await t.close();

    const again = await start({}, { dataDir, clock: t.clock });
    const later = await again.client();
    expect(ofType(again, id, "run.ended").map((event) => event.payload)).toEqual([expect.objectContaining({ runId, reason: "disposed" })]);
    expect((await later.request("permissions.prompts.list", {})).prompts).toEqual([{ sessionId: id, promptId: "q-1", sequence, openedAt: at(0), prompt: opened }]);
    expect(await get(later, id)).toMatchObject({ parkedPromptCount: 1, activity: { state: "parked" } });
    const { subscription } = await later.subscribe("sessions.subscribeSession", { sessionId: id, afterSequence: again.env.log.head() + 1000 });
    const frame = await later.next((f) => f.type === "snapshot" && f.subscription === subscription);
    const snapshot = SessionSnapshot.parse(frame.type === "snapshot" && frame.payload);
    expect(snapshot.parkedPrompts).toEqual([{ promptId: "q-1", sequence, openedAt: at(0), prompt: opened }]);
    expect(snapshot.items.filter((item) => item.kind === "prompt")).toEqual([{ kind: "prompt", sequence, runId, promptId: "q-1", prompt: opened, answer: null }]);

    const answers = { "Which date library?": "luxon", "Which parts?": "API, UI" };
    const given = await answer(later, "q-1", { decision: "allow", answers, message: "RESTART_NOTE_2091: acknowledge only." });
    expect(given.result).toMatchObject({ delivery: "next-run", answers });
    const next = await startRun(later, id, "Carry on");
    await untilEnded(again, id, next.runId);
    const [delivered, message] = again.adapter.lastRun().input.prompt;
    expect(delivered?.text).toContain("Which date library?");
    expect(delivered?.text).toContain("luxon");
    expect(delivered?.text).toContain("API, UI");
    expect(delivered?.text).toContain("RESTART_NOTE_2091: acknowledge only.");
    expect(message).toMatchObject({ text: "Carry on" });
  });

  it("keeps a prompt the recovery sweep's end leaves open, answerable after the start", async () => {
    const dataDir = join(tempDir(), "data");
    const t = await start({ script: ask("permission", permission, { promptId: "p-1" }) }, { dataDir });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    await untilOpened(t, id);
    // The environment dies with the run parked: its end never reaches the log.
    const loud = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await client.close();
    t.env.log.close();
    await t.close();
    loud.mockRestore();

    const again = await start({}, { dataDir });
    const later = await again.client();
    expect(ofType(again, id, "run.ended").map((event) => event.payload)).toEqual([expect.objectContaining({ runId, reason: "interrupted", cause: "restart" })]);
    expect((await later.request("permissions.prompts.list", {})).prompts.map((prompt) => prompt.promptId)).toEqual(["p-1"]);
    expect((await answer(later, "p-1", { decision: "deny", message: "Leave the build" })).result).toMatchObject({ delivery: "next-run" });
  });
});
