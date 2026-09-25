import { randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  COMPLETIONS_HEARTBEAT_MS,
  ChatCompletion,
  commandParams,
  defineMethod,
  MessageId,
  SessionId,
  ChatCompletionChunk,
  CompletionsErrorBody,
  CompletionsModel,
  CompletionsModelList,
  registry,
  type ChatCompletionChunk as Chunk,
  type Mode,
  type PromptAnsweredPayload,
  type RunPolicyResolvedPayload,
  type RunStartedPayload,
  type Scope,
  type SessionSummary,
} from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { useCleanups } from "../../test/cleanups.js";
import { ask, end, fakeAdapter, gate, say, toldText, type FakeAdapter, type FakeAdapterOptions, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, workspace } from "../../test/sessions.js";
import type { AdapterEvent } from "../adapter/contract.js";
import type { EventEnvelope } from "../event-log/event-log.js";

/**
 * The completions surface (claude-adapter spec, "The completions surface";
 * ADR 0015; #138) through its seam: the in-process environment with the
 * scripted fake adapter under the manual clock, driven over real HTTP with
 * `fetch` by a `program` client session's bearer token. What is asserted is
 * what a program sees on the wire (status, body, chunks) and what the log and
 * the fake provider hold afterwards.
 */

const { onCleanup, tempDir } = useCleanups();

const PROGRAM_SCOPES: readonly Scope[] = ["read", "sessions:write", "runs:drive"];

const start = async (adapter: FakeAdapterOptions | FakeAdapter = {}, options: Omit<TestEnvironmentOptions, "adapter"> = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ ...options, adapter: "descriptor" in adapter ? adapter : fakeAdapter(adapter) });
  onCleanup(() => t.close());
  return t;
};

/** A program's bearer token: a pairing exchanged as kind `program` with the three scopes and `ceiling`. */
const program = async (t: TestEnvironment, options: { ceiling?: Mode; scopes?: readonly Scope[] } = {}) =>
  t.pair({ kind: "program", scopes: options.scopes ?? PROGRAM_SCOPES, ceiling: options.ceiling ?? "bypassPermissions", label: "hermes" });

const url = (t: TestEnvironment, path: string): string => `http://${t.address.host}:${t.address.port}${path}`;

const bearer = (token: string | undefined): Record<string, string> => (token === undefined ? {} : { authorization: `Bearer ${token}` });

const get = (t: TestEnvironment, path: string, token?: string): Promise<Response> => fetch(url(t, path), { headers: bearer(token) });

const post = (t: TestEnvironment, token: string | undefined, body: unknown, init: { path?: string; signal?: AbortSignal } = {}): Promise<Response> =>
  fetch(url(t, init.path ?? "/v1/chat/completions"), {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...(init.signal !== undefined && { signal: init.signal }),
  });

/** A request with one user message, and whatever else a test adds. */
const turn = (text: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: "claude-max/opus",
  messages: [{ role: "user", content: text }],
  ...extra,
});

/** The error body of a refusal, checked against its schema, with the status. */
const refusalOf = async (response: Response) => ({ status: response.status, body: CompletionsErrorBody.parse(await response.json()) });

/** A whole, non-streamed completion. */
const complete = async (t: TestEnvironment, token: string, body: Record<string, unknown>) => {
  const response = await post(t, token, body);
  const text = await response.text();
  if (response.status !== 200) throw new Error(`The completion answered ${response.status}: ${text}`);
  return ChatCompletion.parse(JSON.parse(text));
};

/** One thing an SSE stream carried: a chunk, a comment, or the `[DONE]` line. */
type Sse = { readonly kind: "chunk"; readonly chunk: Chunk } | { readonly kind: "comment"; readonly text: string } | { readonly kind: "done" };

/** Reads an SSE response one message at a time. */
const sse = (response: Response) => {
  if (response.body === null) throw new Error("The response has no body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (block: string): Sse => {
    if (block.startsWith(":")) return { kind: "comment", text: block.slice(1).trim() };
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data === "[DONE]") return { kind: "done" };
    return { kind: "chunk", chunk: ChatCompletionChunk.parse(JSON.parse(data)) };
  };
  const next = async (): Promise<Sse | undefined> => {
    for (;;) {
      const at = buffer.indexOf("\n\n");
      if (at >= 0) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        return parse(block);
      }
      const read = await reader.read();
      if (read.done) return undefined;
      buffer += decoder.decode(read.value, { stream: true });
    }
  };
  /** Everything up to and including `[DONE]`, then the end of the body. */
  const rest = async (): Promise<Sse[]> => {
    const out: Sse[] = [];
    for (let message = await next(); message !== undefined; message = await next()) out.push(message);
    return out;
  };
  /** The next chunk, skipping comments. */
  const chunk = async (): Promise<Chunk> => {
    for (let message = await next(); message !== undefined; message = await next()) if (message.kind === "chunk") return message.chunk;
    throw new Error("The stream ended before another chunk.");
  };
  return { next, rest, chunk, cancel: () => reader.cancel() };
};

/** A streamed completion, opened: the reader over its body. */
const stream = async (t: TestEnvironment, token: string, body: Record<string, unknown>, signal?: AbortSignal) => {
  const response = await post(t, token, { ...body, stream: true }, signal === undefined ? {} : { signal });
  if (response.status !== 200) throw new Error(`The stream answered ${response.status}: ${await response.text()}`);
  expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);
  return sse(response);
};

const chunksOf = (messages: readonly Sse[]): Chunk[] => messages.flatMap((message) => (message.kind === "chunk" ? [message.chunk] : []));
const contentOf = (chunks: readonly Chunk[]): string => chunks.map((chunk) => chunk.choices[0]?.delta.content ?? "").join("");

const eventsOf = (t: TestEnvironment, sessionId: string): EventEnvelope[] => t.env.log.readStream({ kind: "session", id: sessionId });
const ofType = (t: TestEnvironment, sessionId: string, type: string): EventEnvelope[] => eventsOf(t, sessionId).filter((event) => event.type === type);
const payloadsOf = <P>(t: TestEnvironment, sessionId: string, type: string): P[] => ofType(t, sessionId, type).map((event) => event.payload as P);

const untilEnded = async (t: TestEnvironment, sessionId: string, count = 1): Promise<void> => {
  await vi.waitFor(() => expect(ofType(t, sessionId, "run.ended")).toHaveLength(count));
};

/** The session list as a client over the wire reads it. */
const listed = async (t: TestEnvironment): Promise<readonly SessionSummary[]> => {
  const client = await t.client();
  try {
    return registry["sessions.list"].result.parse(await client.request("sessions.list", {})).sessions;
  } finally {
    await client.close();
  }
};

const usage = (inputTokens: number, outputTokens: number): AdapterEvent => ({
  type: "usage.reported",
  payload: { models: [{ model: "opus", inputTokens, outputTokens, cacheReadTokens: 5, cacheWriteTokens: 1, costUsd: null, contextWindow: null }] },
});

const delta = (itemId: string, text: string): AdapterEvent => ({ type: "assistant.delta", payload: { itemId, fragments: [{ kind: "text", text }] } });
const text = (itemId: string, value: string): AdapterEvent => ({ type: "assistant.text", payload: { itemId, text: value, aborted: false } });
const toolStarted = (toolCallId: string): AdapterEvent => ({
  type: "tool.started",
  payload: { toolCallId, name: "Bash", input: { command: "ls" }, title: "Run ls", agentId: null, parentToolCallId: null },
});
const toolEnded = (toolCallId: string): AdapterEvent => ({ type: "tool.ended", payload: { toolCallId, status: "ok", output: "a\nb", durationMs: 3 } });

/** A script that streams a reply in two deltas around a tool call, reports usage and completes. */
const streamingScript: Script = () => [delta("i1", "Hello, "), toolStarted("toolu_1"), toolEnded("toolu_1"), delta("i1", "world"), text("i1", "Hello, world"), usage(12, 3), end()];

/** A script that waits on `held` before it replies. */
const heldScript =
  (held: Promise<void>, reply = "Late reply"): Script =>
  async function* () {
    await held;
    yield say(reply);
    yield end();
  };

describe("the routes on the wire's port", () => {
  it("lists every signed-in account's catalogue with the account, family and tier beside each id", async () => {
    const adapter = fakeAdapter({ status: (account) => ({ signedIn: account.id !== "work-lapsed", authMethod: "fake", email: `${account.id}@example.com`, orgName: null, subscriptionType: "max", error: null }) });
    const t = await start(adapter, { accounts: [{ id: "claude-max", provider: "fake" }, { id: "work-lapsed", provider: "fake" }] });
    const { token } = await program(t);
    const response = await get(t, "/v1/models", token);
    expect(response.status).toBe(200);
    const list = CompletionsModelList.parse(await response.json());
    expect(list.data.map((model) => model.id)).toEqual(["claude-max/opus", "claude-max/sonnet", "claude-max/haiku"]);
    expect(list.data[0]).toMatchObject({ family: "opus", tier: 3, owned_by: "fake", "agent-harness": { account: "claude-max", accountId: "claude-max" } });
  });

  it("reads one model by the rest of the path, slash and all, and a bare id on the default account", async () => {
    const t = await start();
    const { token } = await program(t);
    const listedId = CompletionsModel.parse(await (await get(t, "/v1/models/claude-max/sonnet", token)).json());
    expect(listedId).toMatchObject({ id: "claude-max/sonnet", family: "sonnet", tier: 2 });
    const bare = CompletionsModel.parse(await (await get(t, "/v1/models/haiku", token)).json());
    expect(bare.id).toBe("claude-max/haiku");
    const missing = await refusalOf(await get(t, "/v1/models/claude-max/gpt-9", token));
    expect(missing).toMatchObject({ status: 404, body: { error: { type: "not_found_error", code: "model_not_found" } } });
  });

  it("answers every other OpenAI path 501 with a sentence, and a wrong method 405", async () => {
    const t = await start();
    const { token } = await program(t);
    for (const [method, path] of [
      ["POST", "/v1/embeddings"],
      ["POST", "/v1/completions"],
      ["GET", "/v1/files"],
      ["POST", "/v1/responses"],
    ] as const) {
      const answer = await refusalOf(await fetch(url(t, path), { method, headers: bearer(token) }));
      expect(answer.status, path).toBe(501);
      expect(answer.body.error.code).toBe("not_implemented");
      expect(answer.body.error.message).toMatch(/\.$/);
    }
    const wrong = await fetch(url(t, "/v1/chat/completions"), { headers: bearer(token) });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("POST");
  });
});

describe("authentication", () => {
  it("refuses a request with no token, a token it did not issue, and a revoked one, 401", async () => {
    const t = await start();
    const credential = await program(t);
    expect(await refusalOf(await post(t, undefined, turn("Hi")))).toMatchObject({ status: 401, body: { error: { type: "authentication_error", code: "unauthorized" } } });
    expect(await refusalOf(await post(t, "not-a-token", turn("Hi")))).toMatchObject({ status: 401, body: { error: { code: "unauthorized" } } });
    expect(await refusalOf(await get(t, "/v1/models"))).toMatchObject({ status: 401 });
    expect(t.env.clientSessions.revoke(credential.clientSessionId)).toBe(true);
    expect(await refusalOf(await post(t, credential.token, turn("Hi")))).toMatchObject({ status: 401, body: { error: { code: "revoked" } } });
    expect(t.adapter.runs).toHaveLength(0);
  });

  it("refuses a client session that is not a program's, 403, whatever its scopes", async () => {
    const t = await start();
    const tui = await t.bootstrap("tui");
    const desktop = await t.pair({ kind: "desktop", scopes: PROGRAM_SCOPES });
    for (const token of [tui.token, desktop.token]) {
      expect(await refusalOf(await post(t, token, turn("Hi")))).toMatchObject({ status: 403, body: { error: { type: "permission_error", code: "client_kind" } } });
    }
    expect(t.adapter.runs).toHaveLength(0);
  });

  it("refuses a program missing a scope the route needs, 403 naming it", async () => {
    const t = await start();
    const readOnly = await program(t, { scopes: ["read"] });
    const refused = await refusalOf(await post(t, readOnly.token, turn("Hi")));
    expect(refused).toMatchObject({ status: 403, body: { error: { type: "permission_error", code: "forbidden" } } });
    expect(refused.body.error.message).toMatch(/sessions:write|runs:drive/);
    expect((await get(t, "/v1/models", readOnly.token)).status).toBe(200);
    const noRead = await program(t, { scopes: ["sessions:write", "runs:drive"] });
    expect(await refusalOf(await get(t, "/v1/models", noRead.token))).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
  });

  it("answers 503 while the environment drains, and the running stream ends with its run", async () => {
    const held = gate();
    const t = await start();
    const { token } = await program(t);
    t.adapter.nextScripts.push(heldScript(held.opened));
    const running = await stream(t, token, turn("Keep going"));
    const first = await running.chunk();
    void t.env.drain("command");
    await vi.waitFor(() => expect(t.env.readiness()).toBe("draining"));
    expect(await refusalOf(await post(t, token, turn("One more")))).toMatchObject({ status: 503, body: { error: { code: "unavailable" } } });
    held.open();
    const rest = await running.rest();
    expect(contentOf(chunksOf(rest))).toBe("Late reply");
    expect(chunksOf(rest).at(-1)?.choices[0]?.finish_reason).toBe("stop");
    expect(first["agent-harness"].sessionId).toBeDefined();
  });
});

describe("a completion, whole", () => {
  it("runs the trailing user message as an ordinary run and answers with the text, the usage and the session", async () => {
    const t = await start({ script: () => [say("Filed it."), usage(20, 4), end()] });
    const { token } = await program(t);
    const answer = await complete(t, token, turn("File the receipt"));
    const sessionId = answer["agent-harness"].sessionId as string;
    expect(answer.choices[0]).toEqual({ index: 0, message: { role: "assistant", content: "Filed it." }, finish_reason: "stop" });
    expect(answer.usage).toEqual({ prompt_tokens: 26, completion_tokens: 4, total_tokens: 30, prompt_tokens_details: { cached_tokens: 5 } });
    expect(answer.model).toBe("claude-max/opus");
    expect(t.adapter.lastRun().input.prompt.map((message) => message.text)).toEqual(["File the receipt"]);
    const [started] = payloadsOf<RunStartedPayload>(t, sessionId, "run.started");
    expect(started).toMatchObject({ origin: "completions", model: "opus", accountId: "claude-max" });
    expect(answer["agent-harness"].runId).toBe(started?.runId);
    const summary = (await listed(t)).find((session) => session.id === sessionId);
    expect(summary?.tags).toContain("completions");
    expect(summary).toMatchObject({ accountId: "claude-max", model: "opus" });
  });

  it("answers a run that failed 502 with the harness's reason and the session it ran on", async () => {
    const t = await start({ script: () => [say("Half"), end("error", { error: { message: "The provider fell over.", code: "overloaded" } })] });
    const { token } = await program(t);
    const refused = await refusalOf(await post(t, token, turn("Try")));
    expect(refused.status).toBe(502);
    expect(refused.body.error).toMatchObject({ code: "error", message: "The provider fell over." });
    expect(refused.body["agent-harness"]).toMatchObject({ ended: { reason: "error", cause: null } });
    expect(refused.body["agent-harness"]?.sessionId).toBeDefined();
  });
});

describe("a completion, streamed", () => {
  it("follows OpenAI's chunk order, every chunk carrying the log sequence of the event it renders", async () => {
    const t = await start({ script: streamingScript });
    const { token } = await program(t);
    const messages = await (await stream(t, token, turn("Say hello", { stream_options: { include_usage: true } }))).rest();
    expect(messages.at(-1)).toEqual({ kind: "done" });
    const chunks = chunksOf(messages);
    const [first] = chunks;
    const sessionId = first?.["agent-harness"].sessionId as string;
    expect(first?.choices).toEqual([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]);
    expect(first?.["agent-harness"]).toMatchObject({ clamped: null, ignored: [] });
    expect(contentOf(chunks)).toBe("Hello, world");
    const activity = chunks.flatMap((chunk) => (chunk["agent-harness"].activity === undefined ? [] : [chunk["agent-harness"].activity]));
    expect(activity).toEqual([
      { type: "tool.started", toolCallId: "toolu_1", name: "Bash", title: "Run ls" },
      { type: "tool.ended", toolCallId: "toolu_1", status: "ok" },
    ]);
    for (const chunk of chunks.filter((c) => c["agent-harness"].activity !== undefined)) expect(chunk.choices[0]?.delta).toEqual({});
    const finish = chunks.at(-2);
    expect(finish?.choices).toEqual([{ index: 0, delta: {}, finish_reason: "stop" }]);
    const usageChunk = chunks.at(-1);
    expect(usageChunk?.choices).toEqual([]);
    expect(usageChunk?.usage).toEqual({ prompt_tokens: 18, completion_tokens: 3, total_tokens: 21, prompt_tokens_details: { cached_tokens: 5 } });
    // seq: the sequence of a logged event of the session, never going back.
    const sequences = new Map(eventsOf(t, sessionId).map((event) => [event.sequence, event.type]));
    const seqs = chunks.map((chunk) => chunk["agent-harness"].seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(sequences.get(seqs[0] as number)).toBe("run.started");
    expect(sequences.get(finish?.["agent-harness"].seq as number)).toBe("run.ended");
    for (const seq of seqs) expect(sequences.has(seq), `seq ${seq}`).toBe(true);
    expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(1);
  });

  it("renders settled text the provider never streamed, and leaves thinking out", async () => {
    const t = await start({
      script: () => [
        { type: "assistant.delta", payload: { itemId: "t1", fragments: [{ kind: "thinking", text: "Hmm" }] } },
        { type: "assistant.thinking", payload: { itemId: "t1", text: "Hmm", aborted: false } },
        say("First."),
        delta("i2", "Sec"),
        text("i2", "Second."),
        end(),
      ],
    });
    const { token } = await program(t);
    const chunks = chunksOf(await (await stream(t, token, turn("Two things"))).rest());
    expect(contentOf(chunks)).toBe("First.\n\nSecond.");
    const whole = await complete(t, (await program(t)).token, turn("Two things"));
    expect(whole.choices[0]?.message.content).toBe("First.\n\nSecond.");
  });

  it("sends an SSE comment every fifteen seconds while the stream is silent", async () => {
    const held = gate();
    const t = await start();
    const { token } = await program(t);
    t.adapter.nextScripts.push(heldScript(held.opened));
    const reading = await stream(t, token, turn("Think a while"));
    await reading.chunk();
    t.clock.advance(COMPLETIONS_HEARTBEAT_MS);
    expect(await reading.next()).toEqual({ kind: "comment", text: expect.any(String) });
    t.clock.advance(COMPLETIONS_HEARTBEAT_MS - 1);
    t.clock.advance(1);
    expect(await reading.next()).toMatchObject({ kind: "comment" });
    held.open();
    const rest = await reading.rest();
    expect(rest.filter((message) => message.kind === "comment")).toEqual([]);
    expect(contentOf(chunksOf(rest))).toBe("Late reply");
  });

  it("ends a run that failed mid-stream with a final chunk carrying the error, then [DONE]", async () => {
    const t = await start({ script: () => [delta("i1", "Starting"), end("error", { error: { message: "The provider fell over.", code: null } })] });
    const { token } = await program(t);
    const messages = await (await stream(t, token, turn("Try"))).rest();
    expect(messages.at(-1)).toEqual({ kind: "done" });
    const last = chunksOf(messages).at(-1);
    expect(last?.choices).toEqual([{ index: 0, delta: {}, finish_reason: "error" }]);
    expect(last?.error).toMatchObject({ code: "error", message: "The provider fell over." });
    expect(last?.["agent-harness"].ended).toEqual({ reason: "error", cause: null });
  });

  it("ends an answer still open with a final chunk when the environment stops, never a bare close", async () => {
    const held = gate();
    const t = await start();
    const { token } = await program(t);
    t.adapter.nextScripts.push(heldScript(held.opened));
    const reading = await stream(t, token, turn("Wait for me"));
    await reading.chunk();
    const closing = t.env.close();
    const rest = await reading.rest();
    held.open();
    await closing;
    expect(rest.at(-1)).toEqual({ kind: "done" });
    expect(chunksOf(rest).at(-1)).toMatchObject({ choices: [{ index: 0, delta: {}, finish_reason: "error" }], error: { code: "closing" } });
  });

  it("holds back what may begin a stop sequence split across deltas", async () => {
    const t = await start({ script: () => [delta("i1", "one two ST"), delta("i1", "OP three"), text("i1", "one two STOP three"), end()] });
    const { token } = await program(t);
    const chunks = chunksOf(await (await stream(t, token, turn("Count", { stop: "STOP" }))).rest());
    expect(chunks.map((chunk) => chunk.choices[0]?.delta.content).filter((content) => content !== undefined && content !== "")).toEqual(["one two "]);
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop");
  });

  it("keeps the run going when the client disconnects", async () => {
    const held = gate();
    const t = await start();
    const { token } = await program(t);
    t.adapter.nextScripts.push(heldScript(held.opened, "Finished anyway"));
    const abort = new AbortController();
    const reading = await stream(t, token, turn("Long job"), abort.signal);
    const sessionId = (await reading.chunk())["agent-harness"].sessionId as string;
    abort.abort();
    await reading.cancel().catch(() => undefined);
    held.open();
    await untilEnded(t, sessionId);
    const [ended] = payloadsOf<{ reason: string }>(t, sessionId, "run.ended");
    expect(ended?.reason).toBe("completed");
    expect(payloadsOf<{ text: string }>(t, sessionId, "assistant.text").map((payload) => payload.text)).toEqual(["Finished anyway"]);
    expect(t.adapter.lastRun().interrupted).toBe(false);
  });
});

describe("session continuity", () => {
  it("runs a request with no session id in a fresh session, and one naming it in that session, dropping the earlier messages", async () => {
    const t = await start();
    const { token } = await program(t);
    const first = await complete(t, token, {
      model: "claude-max/opus",
      messages: [
        { role: "user", content: "My name is David." },
        { role: "assistant", content: "Hello David." },
        { role: "user", content: "What is my name?" },
      ],
    });
    const sessionId = first["agent-harness"].sessionId as string;
    const opened = t.adapter.lastRun().input.prompt[0]?.text ?? "";
    expect(opened).toMatch(/^Earlier in this conversation:/);
    expect(opened).toContain("My name is David.");
    expect(opened).toContain("Hello David.");
    expect(opened.endsWith("What is my name?")).toBe(true);

    const second = await complete(t, token, {
      model: "claude-max/opus",
      messages: [
        { role: "user", content: "My name is David." },
        { role: "assistant", content: "Hello David." },
        { role: "user", content: "What is my name?" },
        { role: "assistant", content: "David." },
        { role: "user", content: "Thanks" },
      ],
      "agent-harness": { sessionId },
    });
    expect(second["agent-harness"].sessionId).toBe(sessionId);
    expect(t.adapter.lastRun().input.prompt.map((message) => message.text)).toEqual(["Thanks"]);
    expect(t.adapter.lastRun().input.sessionId).toBe(sessionId);
    expect(payloadsOf<RunStartedPayload>(t, sessionId, "run.started").map((payload) => payload.origin)).toEqual(["completions", "completions"]);
    expect((await listed(t)).filter((session) => session.tags.includes("completions")).map((session) => session.id)).toEqual([sessionId]);
  });

  it("accepts the artemis namespace, and the agent-harness key wins a field both set", async () => {
    const t = await start();
    const { token } = await program(t);
    const a = (await complete(t, token, turn("One")))["agent-harness"].sessionId as string;
    const b = (await complete(t, token, turn("Two")))["agent-harness"].sessionId as string;
    const viaAlias = await complete(t, token, turn("Three", { artemis: { sessionId: a } }));
    expect(viaAlias["agent-harness"].sessionId).toBe(a);
    const both = await complete(t, token, turn("Four", { artemis: { sessionId: a, thinking: "low" }, "agent-harness": { sessionId: b } }));
    expect(both["agent-harness"].sessionId).toBe(b);
    // A field only the alias sets still applies.
    expect(payloadsOf<RunStartedPayload>(t, b, "run.started").at(-1)?.effort).toBe("low");
  });

  it("refuses a session it does not have 404, and one on another account than the model's 409", async () => {
    const t = await start({}, { accounts: [{ id: "claude-max", provider: "fake" }, { id: "work", provider: "fake" }] });
    const { token } = await program(t);
    expect(await refusalOf(await post(t, token, turn("Hi", { "agent-harness": { sessionId: randomUUID() } })))).toMatchObject({
      status: 404,
      body: { error: { code: "session_not_found", param: "agent-harness.sessionId" } },
    });
    const sessionId = (await complete(t, token, turn("Hi")))["agent-harness"].sessionId as string;
    expect(await refusalOf(await post(t, token, { ...turn("Hi"), model: "work/opus", "agent-harness": { sessionId } }))).toMatchObject({
      status: 409,
      body: { error: { type: "conflict_error", code: "account_mismatch" } },
    });
  });

  it("refuses forkSession and rewindToMessageId 501 until the environment serves sessions.fork and sessions.rewind", async () => {
    const t = await start();
    const { token } = await program(t);
    const sessionId = (await complete(t, token, turn("Hi")))["agent-harness"].sessionId as string;
    expect(await refusalOf(await post(t, token, turn("Fork", { "agent-harness": { sessionId, forkSession: true } })))).toMatchObject({
      status: 501,
      body: { error: { code: "not_implemented", param: "agent-harness.forkSession" } },
    });
    expect(await refusalOf(await post(t, token, turn("Back", { "agent-harness": { sessionId, rewindToMessageId: randomUUID() } })))).toMatchObject({
      status: 501,
      body: { error: { code: "not_implemented", param: "agent-harness.rewindToMessageId" } },
    });
  });

  it("continues a session a client created, tagging it completions", async () => {
    const t = await start();
    const { token } = await program(t);
    const client = await t.client();
    const sessionId = randomUUID();
    await create(client, { id: sessionId });
    await client.close();
    const answer = await complete(t, token, turn("Pick it up", { "agent-harness": { sessionId } }));
    expect(answer["agent-harness"].sessionId).toBe(sessionId);
    expect(t.adapter.lastRun().input.workspace).toEqual(workspace);
    expect((await listed(t)).find((session) => session.id === sessionId)?.tags).toEqual(["completions"]);
    expect(payloadsOf<RunStartedPayload>(t, sessionId, "run.started")[0]?.origin).toBe("completions");
  });

  it("runs the turn on a fork through sessions.fork, and rewinds through sessions.rewind, as the program's client session", async () => {
    const t = await start();
    const { token, clientSessionId } = await program(t);
    const sessionId = (await complete(t, token, turn("Hi")))["agent-harness"].sessionId as string;
    const calls: { method: string; params: Record<string, unknown>; caller: string }[] = [];
    const fork = defineMethod({
      name: "sessions.fork",
      scope: "sessions:write",
      kind: "command",
      params: commandParams({ sessionId: SessionId, id: SessionId, atMessageId: MessageId.optional(), account: z.string().optional() }),
      result: z.object({}),
      errors: [],
    });
    t.serve(fork, (params, context) => {
      calls.push({ method: "sessions.fork", params, caller: context.clientSession.id });
      const created = {
        title: null,
        tags: [],
        groupId: null,
        workspace: { kind: "directory", path: "/work/fork" },
        repositoryIdentity: null,
        account: params.account ?? null,
        model: null,
        mode: null,
      };
      return { aggregate: { kind: "session", id: params.id }, result: {}, events: [{ type: "session.created", payload: created }] };
    });
    const rewind = defineMethod({
      name: "sessions.rewind",
      scope: "runs:drive",
      kind: "command",
      params: commandParams({ sessionId: SessionId, messageId: MessageId }),
      result: z.object({}),
      errors: [],
    });
    t.serve(rewind, (params, context) => {
      calls.push({ method: "sessions.rewind", params, caller: context.clientSession.id });
      return { aggregate: { kind: "session", id: params.sessionId }, result: {} };
    });
    const anchor = randomUUID();
    const forked = await complete(t, token, turn("On the fork", { "agent-harness": { sessionId, forkSession: true, rewindToMessageId: anchor } }));
    const forkId = forked["agent-harness"].sessionId as string;
    expect(forkId).not.toBe(sessionId);
    expect(calls).toEqual([{ method: "sessions.fork", params: expect.objectContaining({ sessionId, id: forkId, atMessageId: anchor, account: "claude-max" }), caller: clientSessionId }]);
    expect(t.adapter.lastRun().input).toMatchObject({ sessionId: forkId, workspace: { kind: "directory", path: "/work/fork" } });
    expect(t.adapter.lastRun().input.prompt.map((message) => message.text)).toEqual(["On the fork"]);
    await complete(t, token, turn("Again", { "agent-harness": { sessionId, rewindToMessageId: anchor } }));
    expect(calls.at(-1)).toEqual({ method: "sessions.rewind", params: expect.objectContaining({ sessionId, messageId: anchor }), caller: clientSessionId });
    expect(t.adapter.lastRun().input.sessionId).toBe(sessionId);
  });

  it("follows a steer the environment holds into the run that reads it, which is the program's too", async () => {
    const t = await start({ capabilities: { providerQueue: false, steering: false } });
    const { token } = await program(t);
    const held = gate();
    t.adapter.nextScripts.push(heldScript(held.opened, "First done"));
    const first = await stream(t, token, turn("First"));
    const sessionId = (await first.chunk())["agent-harness"].sessionId as string;
    const second = await stream(t, token, turn("Then this", { "agent-harness": { sessionId } }));
    const opening = await second.chunk();
    expect(opening["agent-harness"]).toMatchObject({ steered: true });
    held.open();
    expect(contentOf(chunksOf(await first.rest()))).toBe("First done");
    // Attached, the answer carries the live run from the steer on, then the run that reads the steer.
    const chunks = chunksOf(await second.rest());
    expect(contentOf(chunks)).toBe("First done\n\nDone: Then this");
    const runs = payloadsOf<RunStartedPayload>(t, sessionId, "run.started");
    expect(runs.map((run) => run.origin)).toEqual(["completions", "completions"]);
    expect(runs[1]?.queuedMessageIds).toEqual([opening["agent-harness"].messageId]);
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop");
  });

  it("ends a steer's answer with the message still queued when the run it was sent to ends without reading it", async () => {
    const t = await start({ capabilities: { providerQueue: false, steering: false } });
    const { token } = await program(t);
    t.adapter.nextScripts.push(heldScript(gate().opened));
    const first = await stream(t, token, turn("First"));
    const opening = await first.chunk();
    const sessionId = opening["agent-harness"].sessionId as string;
    const second = await stream(t, token, turn("Then this", { "agent-harness": { sessionId } }));
    const steered = await second.chunk();
    const client = await t.client();
    await client.request("runs.interrupt", { commandId: randomUUID(), runId: opening["agent-harness"].runId as string });
    const last = chunksOf(await second.rest()).at(-1);
    expect(last?.["agent-harness"]).toMatchObject({ queued: steered["agent-harness"].messageId, ended: { reason: "interrupted", cause: "user" } });
    expect(last?.choices[0]?.finish_reason).toBe("error");
    expect(payloadsOf<RunStartedPayload>(t, sessionId, "run.started")).toHaveLength(1);
  });

  it("attaches a request naming a session whose run is live from after, its trailing message a steer", async () => {
    const t = await start();
    const { token } = await program(t);
    t.adapter.nextScripts.push(async function* ({ nextSent }) {
      yield say("Working on it");
      const steer = await nextSent();
      yield say(`Also: ${steer.text}`);
      yield end();
    });
    const first = await stream(t, token, turn("Start the job"));
    const opening = await first.chunk();
    const sessionId = opening["agent-harness"].sessionId as string;
    const working = await first.chunk();
    expect(working.choices[0]?.delta.content).toBe("Working on it");
    // The first stream goes away; a second request on the same session attaches from what it had seen.
    await first.cancel().catch(() => undefined);
    const attached = await stream(t, token, turn("and tidy up", { "agent-harness": { sessionId, after: working["agent-harness"].seq } }));
    const chunks = chunksOf(await attached.rest());
    expect(chunks[0]?.["agent-harness"]).toMatchObject({ sessionId, runId: opening["agent-harness"].runId, steered: true });
    expect(contentOf(chunks)).toBe("Also: and tidy up");
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop");
    expect(t.adapter.runs).toHaveLength(1);
    expect(t.adapter.lastRun().sent.map((message) => message.text)).toEqual(["and tidy up"]);
    for (const chunk of chunks) expect(chunk["agent-harness"].seq).toBeGreaterThan(working["agent-harness"].seq);
  });
});

describe("the mode, the ceiling and attendance", () => {
  it("clamps permissionMode to the token's ceiling and reports it on the first chunk", async () => {
    const t = await start();
    const { token } = await program(t, { ceiling: "acceptEdits" });
    const reading = await stream(t, token, turn("Go", { "agent-harness": { permissionMode: "bypassPermissions" } }));
    const first = await reading.chunk();
    await reading.rest();
    expect(first["agent-harness"]).toMatchObject({
      mode: "acceptEdits",
      clamped: { requested: "bypassPermissions", effective: "acceptEdits", ceiling: "acceptEdits", reason: "ceiling" },
    });
    const sessionId = first["agent-harness"].sessionId as string;
    const [policy] = payloadsOf<RunPolicyResolvedPayload>(t, sessionId, "run.policy.resolved");
    expect(policy).toMatchObject({ actorKind: "completions", attended: false, mode: { requested: "bypassPermissions", effective: "acceptEdits", clamped: true } });
    expect(t.adapter.lastRun().input.mode).toBe("acceptEdits");
  });

  it("runs unattended by default: a prompt is denied by the unattended rule and the stream goes on", async () => {
    const t = await start({ script: ask("permission", { toolName: "Bash", toolCallId: "toolu_9", input: { command: "rm -rf build" } }) });
    const { token } = await program(t);
    const chunks = chunksOf(await (await stream(t, token, turn("Clean up"))).rest());
    const sessionId = chunks[0]?.["agent-harness"].sessionId as string;
    const [answered] = payloadsOf<PromptAnsweredPayload>(t, sessionId, "prompt.answered");
    expect(answered).toMatchObject({ decision: "deny", decidedBy: { auto: "unattended" } });
    expect(chunks.map((chunk) => chunk["agent-harness"].activity?.type).filter((type) => type !== undefined)).toEqual(["prompt.opened", "prompt.answered"]);
    expect(chunks.find((chunk) => chunk["agent-harness"].activity?.type === "prompt.answered")?.["agent-harness"].activity).toMatchObject({ decision: "deny", auto: "unattended" });
    expect(contentOf(chunks)).toContain("Told ");
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop");
    expect(payloadsOf<RunPolicyResolvedPayload>(t, sessionId, "run.policy.resolved")[0]).toMatchObject({ attended: false, unattendedDefaultApplied: true });
  });

  it("parks a prompt of an attended run until a client answers it", async () => {
    const t = await start({ script: ask("permission", { toolName: "Bash", toolCallId: "toolu_7", input: { command: "make" } }) });
    const { token } = await program(t);
    const reading = await stream(t, token, turn("Build", { "agent-harness": { attended: true } }));
    const first = await reading.chunk();
    const sessionId = first["agent-harness"].sessionId as string;
    await vi.waitFor(() => expect(ofType(t, sessionId, "prompt.opened")).toHaveLength(1));
    expect(ofType(t, sessionId, "prompt.answered")).toHaveLength(0);
    const client = await t.client();
    const promptId = String(ofType(t, sessionId, "prompt.opened")[0]?.payload["promptId"]);
    const answer = await client.request("permissions.prompts.answer", { commandId: randomUUID(), promptId, decision: "allow" });
    expect(answer).toMatchObject({ receipt: { status: "accepted" } });
    const chunks = chunksOf(await reading.rest());
    expect(contentOf(chunks)).toContain(toldText({ decision: "allow" }));
    expect(payloadsOf<RunPolicyResolvedPayload>(t, sessionId, "run.policy.resolved")[0]).toMatchObject({ attended: true });
    expect(payloadsOf<PromptAnsweredPayload>(t, sessionId, "prompt.answered")[0]?.decidedBy).not.toHaveProperty("auto");
  });
});

describe("the request's instructions, parameters and fields", () => {
  it("appends systemPrompt and the system and developer messages after the composed instructions, and reports alwaysOnSkills ignored", async () => {
    const t = await start({}, { adapterSeams: { instructions: () => "COMPOSED" } });
    const { token } = await program(t);
    const reading = await stream(t, token, {
      model: "claude-max/opus",
      messages: [
        { role: "system", content: "You are the librarian." },
        { role: "developer", content: [{ type: "text", text: "File by year." }] },
        { role: "user", content: "File this" },
      ],
      "agent-harness": { systemPrompt: "Persona: tidy.", alwaysOnSkills: ["filing"] },
    });
    const first = await reading.chunk();
    await reading.rest();
    expect(t.adapter.lastRun().input.instructions).toBe("COMPOSED\n\nPersona: tidy.\n\nYou are the librarian.\n\nFile by year.");
    expect(t.adapter.lastRun().input.prompt.map((message) => message.text)).toEqual(["File this"]);
    expect(first["agent-harness"].ignored).toEqual(["agent-harness.alwaysOnSkills"]);
  });

  it("refuses the parameters it cannot honour 400, and ignores and reports them under ignoreUnsupported", async () => {
    const t = await start();
    const { token } = await program(t);
    for (const [name, value] of [
      ["temperature", 0.2],
      ["top_p", 0.9],
      ["seed", 7],
      ["n", 2],
      ["logprobs", true],
      ["presence_penalty", 0.1],
      ["frequency_penalty", 0.1],
      ["logit_bias", { "50256": -100 }],
      ["response_format", { type: "json_object" }],
    ] as const) {
      expect(await refusalOf(await post(t, token, turn("Hi", { [name]: value }))), name).toMatchObject({
        status: 400,
        body: { error: { type: "invalid_request_error", code: "unsupported_parameter", param: name } },
      });
    }
    expect(t.adapter.runs).toHaveLength(0);
    const tolerated = await complete(t, token, turn("Hi", { temperature: 0.2, seed: 7, user: "hermes", metadata: { a: "b" }, parallel_tool_calls: false, "agent-harness": { ignoreUnsupported: true } }));
    expect(tolerated["agent-harness"].ignored).toEqual(["temperature", "seed", "user", "metadata", "parallel_tool_calls"]);
    const ignoredOnly = await complete(t, token, turn("Hi", { store: false, service_tier: "auto" }));
    expect(ignoredOnly["agent-harness"].ignored).toEqual(["store", "service_tier"]);
  });

  it("stops the answer at a stop sequence and at max_tokens, and the run goes on to its end", async () => {
    const t = await start({ script: () => [delta("i1", "alpha beta "), delta("i1", "gamma STOP delta"), text("i1", "alpha beta gamma STOP delta"), end()] });
    const { token } = await program(t);
    const stopped = chunksOf(await (await stream(t, token, turn("Go", { stop: ["STOP"] }))).rest());
    expect(contentOf(stopped)).toBe("alpha beta gamma ");
    expect(stopped.at(-1)?.choices[0]?.finish_reason).toBe("stop");
    const whole = await complete(t, (await program(t)).token, turn("Go", { max_tokens: 2 }));
    expect(whole.choices[0]).toMatchObject({ message: { content: "alpha be" }, finish_reason: "length" });
    const sessionId = whole["agent-harness"].sessionId as string;
    await untilEnded(t, sessionId);
    expect(payloadsOf<{ reason: string }>(t, sessionId, "run.ended")[0]?.reason).toBe("completed");
  });

  it("takes thinking, and reasoning_effort as its alias, as the run's effort, refusing one the model does not take", async () => {
    const t = await start();
    const { token } = await program(t);
    const viaThinking = await complete(t, token, turn("Hi", { "agent-harness": { thinking: "max" } }));
    expect(payloadsOf<RunStartedPayload>(t, viaThinking["agent-harness"].sessionId as string, "run.started")[0]?.effort).toBe("max");
    const viaAlias = await complete(t, token, turn("Hi", { reasoning_effort: "medium" }));
    expect(t.adapter.lastRun().input.effort).toBe("medium");
    expect(viaAlias.choices[0]?.finish_reason).toBe("stop");
    expect(await refusalOf(await post(t, token, { ...turn("Hi"), model: "claude-max/haiku", reasoning_effort: "high" }))).toMatchObject({
      status: 400,
      body: { error: { type: "invalid_request_error", code: "invalid_params" } },
    });
  });

  it("hands the run the attachments with the trailing message", async () => {
    const t = await start();
    const { token } = await program(t);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    await complete(t, token, turn("What is this?", { "agent-harness": { attachments: [{ kind: "image", name: "shot.png", mediaType: "image/png", data: png }] } }));
    const [message] = t.adapter.lastRun().input.prompt;
    expect(message?.attachments.map((attachment) => [attachment.name, attachment.mediaType, [...attachment.data]])).toEqual([["shot.png", "image/png", [0x89, 0x50, 0x4e, 0x47]]]);
  });

  it("gives a fresh session the directory the request names, or a scratch directory of its own", async () => {
    const t = await start();
    const { token } = await program(t);
    const named = tempDir();
    const inNamed = await complete(t, token, turn("Hi", { "agent-harness": { workspace: named } }));
    expect(t.adapter.lastRun().input.workspace).toEqual({ kind: "directory", path: named });
    expect(inNamed["agent-harness"].sessionId).toBeDefined();
    const scratch = await complete(t, token, turn("Hi"));
    const { workspace } = t.adapter.lastRun().input;
    expect(workspace.path.startsWith(t.dataDir)).toBe(true);
    expect(workspace.path).toContain(scratch["agent-harness"].sessionId as string);
    expect(statSync(workspace.path).isDirectory()).toBe(true);
    const missing = join(named, "not-here");
    expect(await refusalOf(await post(t, token, turn("Hi", { "agent-harness": { workspace: missing } })))).toMatchObject({
      status: 400,
      body: { error: { code: "workspace_not_found", param: "agent-harness.workspace" } },
    });
    mkdirSync(join(named, "relative"));
    expect((await refusalOf(await post(t, token, turn("Hi", { "agent-harness": { workspace: "relative" } })))).status).toBe(400);
  });

  it("maps a malformed request to 400 in OpenAI's shape", async () => {
    const t = await start();
    const { token } = await program(t);
    expect(await refusalOf(await post(t, token, "{not json"))).toMatchObject({ status: 400, body: { error: { type: "invalid_request_error", code: "invalid_json" } } });
    expect(await refusalOf(await post(t, token, { model: "claude-max/opus", messages: [] }))).toMatchObject({ status: 400, body: { error: { code: "invalid_params", param: "messages" } } });
    expect(await refusalOf(await post(t, token, turn("Hi", { "agent-harness": { permissionMode: "dontAsk" } })))).toMatchObject({
      status: 400,
      body: { error: { code: "invalid_params", param: "agent-harness.permissionMode" } },
    });
    expect(
      await refusalOf(await post(t, token, { model: "claude-max/opus", messages: [{ role: "user", content: "Hi" }, { role: "assistant", content: "Hello" }] })),
    ).toMatchObject({ status: 400, body: { error: { code: "invalid_params", param: "messages" } } });
    expect(await refusalOf(await post(t, token, { ...turn("Hi"), model: "nobody/opus" }))).toMatchObject({ status: 404, body: { error: { code: "model_not_found", param: "model" } } });
    expect(t.adapter.runs).toHaveLength(0);
  });
});
