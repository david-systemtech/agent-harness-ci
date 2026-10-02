import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { CompletionsErrorBody, CompletionsModelList, registry, type ChatMessage, type MessageSentPayload, type Mode, type PromptAnsweredPayload, type RunPolicyResolvedPayload, type RunStartedPayload, type Scope } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { ask, callClientTool, end, fakeAdapter, say, toolResultText, type FakeAdapterOptions, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import { BUTLER_INSTRUCTIONS, HERMES_SYSTEM_PROMPT, HERMES_TOOLS, chatTurn, compressionCall, hermesCaller, postCompletion, readStream, titleCall, type HermesRoute, type StreamedAnswer } from "../../test/hermes-caller.js";
import { isInProcess, type AdapterEvent } from "../adapter/contract.js";
import type { EventEnvelope } from "../event-log/event-log.js";
import { composeInstructions } from "../instructions/composer.js";

/**
 * The butler's side of the Hermes cut-over (switch-over spec, "Hermes
 * cut-over and Bank migration"; #1193), through the built completions
 * contract: the scripted Hermes caller (`test/hermes-caller.ts`) sends the
 * request shapes of the pinned Hermes with the butler's deployment settings
 * over real HTTP and SSE, as a paired `program` with the butler's scopes and
 * `bypassPermissions` ceiling, to the in-process environment over the
 * scripted fake provider. What is asserted is what Hermes reads on the wire
 * and what the log and the provider hold afterwards.
 *
 * Not proved here, and owed by the live switch-over (#1197): the deployment
 * pin, the parked librarian, the `/keep` and `/save` plugin, the credential's
 * provisioning in OpenBao, and signed delivery to Matrix.
 */

const { onCleanup } = useCleanups();

/** The butler's pairing: the three scopes and the bypass ceiling (spec L115). */
const BUTLER_SCOPES: readonly Scope[] = ["read", "sessions:write", "runs:drive"];

/** Two signed-in accounts: the default one first, and the one whose Claude billing the butler keeps, second. */
const ACCOUNTS = [
  { id: "Shared Max", provider: "fake" },
  { id: "Owner Max", provider: "fake" },
] as const;
const OWNER_EMAIL = "owner@example.com";

const status: NonNullable<FakeAdapterOptions["status"]> = (account) => ({
  signedIn: true,
  authMethod: "fake",
  email: account.id === "Owner Max" ? OWNER_EMAIL : "shared@example.com",
  orgName: null,
  subscriptionType: "max",
  error: null,
});

/** A composer whose every run is handed `COMPOSED`, so the request's own instructions are seen after it. */
const composed = composeInstructions({ orientation: () => ({ text: "COMPOSED", unreadRegistries: [] }) });

const start = async (script?: Script): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ adapter: fakeAdapter({ status, ...(script !== undefined && { script }) }), accounts: ACCOUNTS, adapterSeams: { instructions: composed } });
  onCleanup(() => t.close());
  return t;
};

const origin = (t: TestEnvironment): string => `http://${t.address.host}:${t.address.port}`;

/** A program's credential, the butler's unless `ceiling` says otherwise. */
const program = (t: TestEnvironment, ceiling: Mode = "bypassPermissions", label = "butler") => t.pair({ kind: "program", scopes: BUTLER_SCOPES, ceiling, label });

/** The route to `family` on the owner's account, read from the live listing as the deployment's check does, never from saved settings. */
const liveRoute = async (t: TestEnvironment, token: string, family: string, thinking: string): Promise<HermesRoute> => {
  const response = await fetch(`${origin(t)}/v1/models`, { headers: { authorization: `Bearer ${token}` } });
  const listed = CompletionsModelList.parse(await response.json());
  const model = listed.data.find((entry) => entry["agent-harness"].accountId === "Owner Max" && entry.family === family);
  if (model === undefined) throw new Error(`The live listing has no ${family} on the owner's account.`);
  return { model: model.id, thinking };
};

/** A refused request's status and error body, checked against the contract. */
const refusalOf = async (t: TestEnvironment, token: string, body: Record<string, unknown>) => {
  const response = await postCompletion(origin(t), token, body);
  return { status: response.status, body: CompletionsErrorBody.parse(await response.json()) };
};

const eventsOf = (t: TestEnvironment, sessionId: string, type: string): EventEnvelope[] => t.env.log.readStream({ kind: "session", id: sessionId }).filter((event) => event.type === type);
const payloadsOf = <P>(t: TestEnvironment, sessionId: string, type: string): P[] => eventsOf(t, sessionId, type).map((event) => event.payload as P);

const usage = (inputTokens: number, outputTokens: number): AdapterEvent => ({
  type: "usage.reported",
  payload: { models: [{ model: "sonnet", inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, contextWindow: null }] },
});

/** Replies `text`, reports usage and completes. */
const reply =
  (text: string): Script =>
  () => [say(text), usage(20, 4), end()];

describe("the butler's chat turn", () => {
  it("runs on the Account-qualified model it read live, billed to that Account and its identity, in the namespace's mode, effort and instructions, unattended", async () => {
    const t = await start(reply("Your calendar is clear."));
    const { token } = await program(t);
    const route = await liveRoute(t, token, "sonnet", "high");
    expect(route.model).toBe("owner-max/sonnet");
    const butler = hermesCaller({ origin: origin(t), token, route, sessionIds: "never" });

    const { final } = await butler.chat("What is on my calendar today?");

    expect(final.content).toBe("Your calendar is clear.");
    expect(final.finishReason).toBe("stop");
    expect(final.done).toBe(true);
    expect(final.atFinish?.ended).toEqual({ reason: "completed", cause: null });
    expect(final.chunks.every((chunk) => chunk.model === "owner-max/sonnet")).toBe(true);
    expect(final.head).toMatchObject({ mode: "bypassPermissions", clamped: null, ignored: [] });
    expect(final.chunks.at(-1)?.usage).toMatchObject({ prompt_tokens: 20, completion_tokens: 4 });

    const sessionId = final.head.sessionId as string;
    const [started] = payloadsOf<RunStartedPayload>(t, sessionId, "run.started");
    expect(started).toMatchObject({ accountId: "Owner Max", identity: { provider: "fake", email: OWNER_EMAIL }, model: "sonnet", effort: "high", origin: "completions" });
    const [policy] = payloadsOf<RunPolicyResolvedPayload>(t, sessionId, "run.policy.resolved");
    expect(policy).toMatchObject({
      actorKind: "completions",
      attended: false,
      mode: { requested: "bypassPermissions", effective: "bypassPermissions", clamped: false },
      unattendedDefaultApplied: false,
    });
    const run = t.adapter.lastRun().input;
    expect(run.instructions.endsWith(`COMPOSED\n\n${BUTLER_INSTRUCTIONS}\n\n${HERMES_SYSTEM_PROMPT}`)).toBe(true);
    const client = run.toolServers.find((server) => server.name === "client");
    if (client === undefined || !isInProcess(client)) throw new Error("Hermes's tools were not served as the client server.");
    expect(client.tools.map((tool) => tool.name)).toEqual(HERMES_TOOLS.map((tool) => tool.function.name));
  });

  it("holds the namespace's bypassPermissions to the butler's ceiling as it is now: a lowered ceiling clamps the next turn, and the first chunk says so", async () => {
    const t = await start(reply("Done."));
    const { token, clientSessionId } = await program(t);
    const butler = hermesCaller({ origin: origin(t), token, route: await liveRoute(t, token, "sonnet", "medium"), sessionIds: "never" });
    const admin = await t.client();
    const lowered = registry["access.sessions.setCeiling"].response.parse(
      await admin.request("access.sessions.setCeiling", { commandId: randomUUID(), clientSessionId, ceiling: "acceptEdits" }),
    );
    expect(lowered.result).toMatchObject({ from: "bypassPermissions", to: "acceptEdits" });

    const { final } = await butler.chat("Tidy the notes folder.");

    expect(final.head).toMatchObject({
      mode: "acceptEdits",
      clamped: { requested: "bypassPermissions", effective: "acceptEdits", ceiling: "acceptEdits", reason: "ceiling" },
    });
    expect(final.atFinish?.ended).toEqual({ reason: "completed", cause: null });
    expect(t.adapter.lastRun().input).toMatchObject({ mode: "acceptEdits", ceiling: "acceptEdits" });
  });
});

describe("a two-turn chat", () => {
  it("runs a turn naming no session in a fresh scratch session, and the next turn naming the id it returned in that session, on the model and effort each turn's route picks", async () => {
    const t = await start();
    const { token } = await program(t);
    const butler = hermesCaller({ origin: origin(t), token, route: await liveRoute(t, token, "sonnet", "medium"), sessionIds: "sent" });

    const first = await butler.chat("The boiler is serviced in March.");
    const sessionId = first.final.head.sessionId as string;
    expect(t.adapter.lastRun().input.workspace).toEqual({ kind: "scratch", path: join(t.dataDir, "scratch", sessionId) });
    // The second turn is a chat command's: /opus-max, with the whole conversation re-sent, as Hermes does.
    const second = await butler.chat("When is the boiler serviced?", await liveRoute(t, token, "opus", "max"));

    expect(butler.sent.map((body) => (body["agent-harness"] as { sessionId?: string }).sessionId)).toEqual([undefined, sessionId]);
    expect(second.final.head.sessionId).toBe(sessionId);
    expect(second.final.content).toBe("Done: When is the boiler serviced?");
    expect(t.adapter.lastRun().input.prompt.map((message) => message.text)).toEqual(["When is the boiler serviced?"]);
    expect(payloadsOf<RunStartedPayload>(t, sessionId, "run.started").map((run) => [run.accountId, run.model, run.effort])).toEqual([
      ["Owner Max", "sonnet", "medium"],
      ["Owner Max", "opus", "max"],
    ]);
    expect(first.final.chunks.every((chunk) => chunk.model === "owner-max/sonnet")).toBe(true);
    expect(second.final.chunks.every((chunk) => chunk.model === "owner-max/opus")).toBe(true);
    for (const turn of [first, second]) {
      expect(turn.final).toMatchObject({ finishReason: "stop", done: true, atFinish: { ended: { reason: "completed", cause: null } } });
    }
  });

  it("gives every turn of a caller that names no session, as the pinned Hermes, a fresh scratch session whose prompt carries the conversation so far", async () => {
    const t = await start();
    const { token } = await program(t);
    const butler = hermesCaller({ origin: origin(t), token, route: await liveRoute(t, token, "sonnet", "medium"), sessionIds: "never" });

    const first = await butler.chat("The boiler is serviced in March.");
    const second = await butler.chat("When is the boiler serviced?");

    const sessions = [first, second].map((turn) => turn.final.head.sessionId as string);
    expect(new Set(sessions).size).toBe(2);
    expect(t.adapter.lastRun().input.workspace).toEqual({ kind: "scratch", path: join(t.dataDir, "scratch", sessions[1] as string) });
    const [prompt] = t.adapter.lastRun().input.prompt.map((message) => message.text);
    expect(prompt).toMatch(/^Earlier in this conversation:/);
    expect(prompt).toContain("User: The boiler is serviced in March.");
    expect(prompt).toContain("Assistant: Done: The boiler is serviced in March.");
    expect(prompt?.endsWith("When is the boiler serviced?")).toBe(true);
    // Hermes's own system prompt is never part of the preamble: it is appended to the instructions on each turn.
    expect(prompt).not.toContain(HERMES_SYSTEM_PROMPT);
  });
});

describe("Hermes's tools", () => {
  /** Saves a note through Hermes's memory tool, then says what the tool answered, and completes. */
  const remember: Script = async function* (controls) {
    const result = yield* callClientTool(controls, { name: "memory", input: { action: "add", content: "The boiler is serviced in March." } });
    yield say(toolResultText(result));
    yield end();
  };

  it.each(["sent", "never"] as const)(
    "round-trips a call to one of Hermes's tools: the answer returns it, and the follow-up's tool message with its id resumes the same run on the same session, on one credential (session ids %s)",
    async (sessionIds) => {
      const t = await start(remember);
      const { token } = await program(t);
      const saved: unknown[] = [];
      const butler = hermesCaller({
        origin: origin(t),
        token,
        route: await liveRoute(t, token, "sonnet", "medium"),
        sessionIds,
        tools: { memory: (args) => (saved.push(args), "Saved.") },
      });

      const { answers, final } = await butler.chat("Remember that the boiler is serviced in March.");

      const [asked] = answers;
      expect(answers).toHaveLength(2);
      expect(asked?.finishReason).toBe("tool_calls");
      expect(asked?.toolCalls).toEqual([{ id: expect.stringMatching(/^call_/), type: "function", function: { name: "memory", arguments: '{"action":"add","content":"The boiler is serviced in March."}' } }]);
      expect(saved).toEqual([{ action: "add", content: "The boiler is serviced in March." }]);
      const sessionId = asked?.head.sessionId as string;
      // The follow-up answered the call with a tool message naming its id, and named the session only when the caller sends ids.
      const followUp = butler.sent[1] as { messages: ChatMessage[]; "agent-harness": { sessionId?: string } };
      expect(followUp.messages.at(-1)).toEqual({ role: "tool", tool_call_id: asked?.toolCalls[0]?.id, content: "Saved." });
      expect(followUp["agent-harness"].sessionId).toBe(sessionIds === "sent" ? sessionId : undefined);
      // The same run went on: no message was sent and no run started for the follow-up.
      expect(final.head).toMatchObject({ sessionId, runId: asked?.head.runId });
      expect(final.head.messageId).toBeUndefined();
      expect(final.content).toBe("Tool said: Saved.");
      expect(final.atFinish?.ended).toEqual({ reason: "completed", cause: null });
      expect(t.adapter.runs).toHaveLength(1);
      expect(eventsOf(t, sessionId, "message.sent")).toHaveLength(1);
      expect(payloadsOf<{ name: string; output: unknown }>(t, sessionId, "tool.ended")).toMatchObject([{ output: "Saved." }]);
    },
  );

  it("takes a call's result only as a tool message: the result sent back as fresh user text answers no call, in a fresh session without an id and as a steer of the live run with one", async () => {
    const t = await start(remember);
    const { token } = await program(t);
    const route = await liveRoute(t, token, "sonnet", "medium");
    const ask: ChatMessage = { role: "user", content: "Remember that the boiler is serviced in March." };
    const asked = await readStream(await postCompletion(origin(t), token, chatTurn(route, [ask], null)));
    const [call] = asked.toolCalls;
    if (call === undefined) throw new Error("The answer returned no call.");
    const sessionId = asked.head.sessionId as string;
    const called: ChatMessage = { role: "assistant", content: asked.content, tool_calls: [{ ...call }] };
    const asText: ChatMessage = { role: "user", content: "The memory tool said: Saved." };

    // With no session id, the text is a fresh turn of a fresh session.
    t.adapter.nextScripts.push(reply("Noted."));
    const fresh = await readStream(await postCompletion(origin(t), token, chatTurn(route, [ask, called, asText], null)));
    expect(fresh.head.sessionId).not.toBe(sessionId);
    expect(fresh).toMatchObject({ content: "Noted.", finishReason: "stop" });
    // With the session's id, it is a message sent to the live run, which still waits on the call.
    const steering = await postCompletion(origin(t), token, chatTurn(route, [ask, called, asText], sessionId));
    const steered = readStream(steering);
    const [, sent] = payloadsOf<MessageSentPayload>(t, sessionId, "message.sent");
    expect(sent).toMatchObject({ text: "The memory tool said: Saved.", delivery: "queued" });
    expect(eventsOf(t, sessionId, "tool.ended")).toHaveLength(0);

    // The call is still parked: the tool message answers it, and the model reads the tool's result, not the text.
    const resumed = await readStream(await postCompletion(origin(t), token, chatTurn(route, [ask, called, { role: "tool", tool_call_id: call.id, content: "Saved." }], sessionId)));
    expect(resumed.head).toMatchObject({ sessionId, runId: asked.head.runId });
    expect(resumed.content).toBe("Tool said: Saved.");
    expect(payloadsOf<{ output: unknown }>(t, sessionId, "tool.ended")).toMatchObject([{ output: "Saved." }]);
    const steeredAnswer = await steered;
    expect(steeredAnswer.head).toMatchObject({ sessionId, runId: asked.head.runId, delivery: "queued", messageId: sent?.messageId });
    expect(steeredAnswer.toolCalls).toEqual([]);
  });
});

describe("the auxiliary calls", () => {
  /** What an auxiliary call's run got: its model and effort, its mode, what it appended after the composed instructions, and what the answer reported ignored. */
  const seen = (t: TestEnvironment, answer: StreamedAnswer) => {
    const sessionId = answer.head.sessionId as string;
    const [started] = payloadsOf<RunStartedPayload>(t, sessionId, "run.started");
    const [policy] = payloadsOf<RunPolicyResolvedPayload>(t, sessionId, "run.policy.resolved");
    const { instructions } = t.adapter.lastRun().input;
    return {
      accountId: started?.accountId,
      model: started?.model,
      effort: started?.effort,
      mode: policy?.mode.effective,
      appended: instructions.slice(instructions.indexOf("COMPOSED") + "COMPOSED".length),
      ignored: answer.head.ignored,
    };
  };

  /** The compression call with no override, as the pinned configuration sends it (`auxiliary.compression.provider: main`): none of the chat route's fields. */
  const BASELINE = { accountId: "Owner Max", model: "sonnet", effort: null, mode: "acceptEdits", appended: "", ignored: [] };

  it("runs the compression call with no override inheriting nothing of the chat route: a fresh session at the unattended default, no effort, no instructions of its own and no tools", async () => {
    const t = await start(reply("Summary."));
    const { token } = await program(t);
    const route = await liveRoute(t, token, "sonnet", "high");

    const answer = await readStream(await postCompletion(origin(t), token, compressionCall(route.model)));

    expect(answer).toMatchObject({ content: "Summary.", finishReason: "stop", done: true, atFinish: { ended: { reason: "completed", cause: null } } });
    expect(seen(t, answer)).toEqual(BASELINE);
    expect(payloadsOf<RunPolicyResolvedPayload>(t, answer.head.sessionId as string, "run.policy.resolved")[0]).toMatchObject({ attended: false, unattendedDefaultApplied: true });
    expect(t.adapter.lastRun().input.toolServers.map((server) => server.name)).not.toContain("client");
  });

  it.each([
    { override: "agent-harness.thinking, a supported effort", extension: { thinking: "low" }, changes: { effort: "low" } },
    { override: "reasoning_effort, auxiliary.compression.reasoning_effort as the custom profile sends it", top: { reasoning_effort: "low" }, changes: { effort: "low" } },
    { override: "agent-harness.systemPrompt", extension: { systemPrompt: "Summarise only; call no tool." }, changes: { appended: "\n\nSummarise only; call no tool." } },
    { override: "agent-harness.permissionMode", extension: { permissionMode: "plan" }, changes: { mode: "plan" } },
    { override: "the model, auxiliary.compression.model", model: "owner-max/haiku", changes: { model: "haiku" } },
    { override: "agent-harness.ignoreUnsupported, beside a temperature", top: { temperature: 0.1 }, extension: { ignoreUnsupported: true }, changes: { ignored: ["temperature"] } },
  ])("takes the compression call's $override alone, changing that and nothing else", async ({ top, extension, model, changes }) => {
    const t = await start(reply("Summary."));
    const { token } = await program(t);

    const answer = await readStream(await postCompletion(origin(t), token, compressionCall(model ?? "owner-max/sonnet", top, extension)));

    expect(answer.finishReason).toBe("stop");
    expect(seen(t, answer)).toEqual({ ...BASELINE, ...changes });
  });

  it("refuses what an auxiliary call cannot have, recording nothing: a temperature without ignoreUnsupported, and an effort its model does not take even with it", async () => {
    const t = await start(reply("Summary."));
    const { token } = await program(t);

    expect(await refusalOf(t, token, compressionCall("owner-max/sonnet", { temperature: 0.1 }))).toMatchObject({ status: 400, body: { error: { code: "unsupported_parameter", param: "temperature" } } });
    expect(await refusalOf(t, token, compressionCall("owner-max/haiku", {}, { ignoreUnsupported: true, thinking: "low" }))).toMatchObject({
      status: 400,
      body: { error: { code: "invalid_params", param: "agent-harness.thinking" } },
    });
    expect(t.adapter.runs).toHaveLength(0);
  });

  it("refuses the title call's shape, which is why title generation stays off: its response_format without ignoreUnsupported, and its reasoning_effort none with it", async () => {
    const t = await start(reply("Title."));
    const { token } = await program(t);

    expect(await refusalOf(t, token, titleCall("owner-max/sonnet"))).toMatchObject({ status: 400, body: { error: { code: "unsupported_parameter", param: "response_format" } } });
    expect(await refusalOf(t, token, titleCall("owner-max/sonnet", { ignoreUnsupported: true }))).toMatchObject({
      status: 400,
      body: { error: { code: "invalid_params", param: "reasoning_effort", message: expect.stringContaining("effort none") } },
    });
    expect(t.adapter.runs).toHaveLength(0);
  });
});

describe("other programs beside the butler", () => {
  it("keeps an ordinary program's clamp to its acceptEdits ceiling and its unattended denials visible, on a fresh session and on the butler's own", async () => {
    // Every run asks to run a command; the butler's first run only replies.
    const t = await start(ask("permission", { toolName: "Bash", toolCallId: "toolu_1", input: { command: "rm -rf build" } }));
    const butler = await program(t);
    const scripts = await program(t, "acceptEdits", "scripts");
    const route = await liveRoute(t, butler.token, "sonnet", "medium");
    t.adapter.nextScripts.push(reply("Done."));
    const butlers = await readStream(await postCompletion(origin(t), butler.token, chatTurn(route, [{ role: "user", content: "Tidy up." }], null)));
    expect(butlers.head).toMatchObject({ mode: "bypassPermissions", clamped: null });
    const butlerSession = butlers.head.sessionId as string;

    // The same request shape, the butler's bypass asked for, from the other program: fresh, then on the butler's session.
    for (const sessionId of [null, butlerSession]) {
      const answer = await readStream(await postCompletion(origin(t), scripts.token, chatTurn(route, [{ role: "user", content: "Clean the build." }], sessionId)));
      expect(answer.head).toMatchObject({
        mode: "acceptEdits",
        clamped: { requested: "bypassPermissions", effective: "acceptEdits", ceiling: "acceptEdits", reason: "ceiling" },
      });
      expect(answer.chunks.flatMap((chunk) => chunk["agent-harness"].activity ?? []).filter((activity) => activity.type === "prompt.answered")).toEqual([
        expect.objectContaining({ decision: "deny", auto: "unattended" }),
      ]);
      expect(answer.atFinish?.ended).toEqual({ reason: "completed", cause: null });
      const ran = answer.head.sessionId as string;
      expect(ran === butlerSession).toBe(sessionId !== null);
      expect(payloadsOf<RunPolicyResolvedPayload>(t, ran, "run.policy.resolved").at(-1)).toMatchObject({ attended: false, mode: { effective: "acceptEdits", clamped: true } });
      expect(payloadsOf<PromptAnsweredPayload>(t, ran, "prompt.answered").at(-1)).toMatchObject({ decision: "deny", decidedBy: { auto: "unattended" } });
    }
    expect(t.adapter.runs.map((run) => run.input.mode)).toEqual(["bypassPermissions", "acceptEdits", "acceptEdits"]);
  });
});

