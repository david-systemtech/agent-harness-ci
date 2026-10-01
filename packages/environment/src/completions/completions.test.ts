import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import {
  CLIENT_TOOL_CALL_EXPIRY_MS,
  COMPLETIONS_HEARTBEAT_MS,
  ChatCompletion,
  ChatCompletionChunk,
  CompletionsErrorBody,
  CompletionsModel,
  CompletionsModelList,
  registry,
  type ChatCompletionChunk as Chunk,
  type ChatToolCall,
  type Mode,
  type PromptAnsweredPayload,
  type RunPolicyResolvedPayload,
  type RunStartedPayload,
  type Scope,
  type SessionSummary,
} from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import {
  ask,
  callClientTool,
  callClientTools,
  end,
  fakeAdapter,
  gate,
  say,
  toldText,
  toolResultText,
  type FakeAdapter,
  type FakeAdapterOptions,
  type Script,
} from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import type { StartupStep } from "../serve/start.js";
import type { Address } from "../serve/http.js";
import { accountSlug } from "./models.js";
import { create, workspace } from "../../test/sessions.js";
import { scriptedResolver } from "../../test/workspaces.js";
import { isInProcess, type AdapterEvent, type HostToolResult } from "../adapter/contract.js";
import { EXPIRED_RESULT } from "./passthrough.js";
import { composeInstructions } from "../instructions/composer.js";
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

/** A composer whose every run is handed `COMPOSED`, as its orientation block. */
const composed = composeInstructions({ orientation: () => ({ text: "COMPOSED", unreadRegistries: [] }) });

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

/**
 * The session's events of `type` once it holds `count` of them: heard as each commits, or read when they are there
 * already. It waits on the events themselves, never on a time budget, which a loaded runner outruns (#823).
 */
const untilLogged = (t: TestEnvironment, sessionId: string, type: string, count = 1): Promise<EventEnvelope[]> =>
  new Promise((resolve) => {
    const settle = (): void => {
      const found = ofType(t, sessionId, type);
      if (found.length < count) return;
      stop();
      resolve(found);
    };
    const stop = t.env.log.subscribe(settle);
    settle();
  });

const untilEnded = async (t: TestEnvironment, sessionId: string, count = 1): Promise<void> => {
  await untilLogged(t, sessionId, "run.ended", count);
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

const DAY = 24 * 60 * 60_000;

/** Holds startup before `step`, and says where the listener is bound once it gets there. */
const holdBefore = (step: StartupStep) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let reach!: (address: Address | undefined) => void;
  const reached = new Promise<Address | undefined>((resolve) => (reach = resolve));
  return {
    hooks: {
      beforeStep: async (current: StartupStep, progress: { readonly address: Address | undefined }) => {
        if (current !== step) return;
        reach(progress.address);
        await held;
      },
    },
    reached,
    release,
  };
};

/** A WebSocket upgrade that then ignores everything, its close frame included, so the wire's close waits out its grace on the manual clock. */
const deafSocket = (t: TestEnvironment) =>
  new Promise<() => void>((resolve, reject) => {
    const socket = connect(t.address.port, t.address.host);
    socket.on("error", reject);
    socket.once("data", (data) => (String(data).startsWith("HTTP/1.1 101") ? resolve(() => socket.destroy()) : reject(new Error(String(data)))));
    // The handshake key is RFC 6455's own example nonce, encoded here so the source holds no key-shaped literal.
    const nonce = Buffer.from("the sample nonce").toString("base64");
    socket.write(
      `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${t.address.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${nonce}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
  });

const signedOut = (lapsed: string): FakeAdapterOptions => ({
  status: (account) => ({ signedIn: account.id !== lapsed, authMethod: "fake", email: `${account.id}@example.com`, orgName: null, subscriptionType: "max", error: null }),
});

/** A run that links the provider conversation `providerSessionId`, as a Claude run's first init does, then replies. */
const linking =
  (providerSessionId: string): Script =>
  ({ input }) => [{ type: "session.provider-linked", payload: { providerSessionId } }, say(`Done: ${input.prompt.map((message) => message.text).join(" / ")}`), end()];

/** An adapter that forks and rewinds (#137), as Claude's does, whose runs link the provider conversation `provider-1`. */
const forking: FakeAdapterOptions = { capabilities: { fork: true, rewind: true }, script: linking("provider-1") };

/** A request whose trailing message follows the earlier ones of a conversation a program replays. */
const replayed = (text: string, extension: Record<string, unknown>): Record<string, unknown> => ({
  model: "claude-max/opus",
  messages: [
    { role: "user", content: "First" },
    { role: "assistant", content: "Done: First" },
    { role: "user", content: text },
  ],
  "agent-harness": extension,
});

/** Every fork and rewind the log holds: its type and the session whose stream it is on. */
const forksAndRewinds = (t: TestEnvironment): { type: string; streamId: string }[] =>
  t.env.log.read<{ type: string; streamId: string }>("SELECT type, stream_id AS streamId FROM events WHERE type IN ('session.forked', 'session.rewound') ORDER BY sequence");

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

  it("reads no model of a signed-out account, 404, though its id resolves", async () => {
    const t = await start(signedOut("work-lapsed"), { accounts: [{ id: "claude-max", provider: "fake" }, { id: "work-lapsed", provider: "fake" }] });
    const { token } = await program(t);
    expect(await refusalOf(await get(t, "/v1/models/work-lapsed/opus", token))).toMatchObject({ status: 404, body: { error: { code: "model_not_found" } } });
  });

  it("slugs an account label for model ids: lower case, runs of other characters one hyphen, a shared slug numbered", () => {
    expect(accountSlug("David's Max")).toBe("david-s-max");
    expect(accountSlug("  Work / Team  ")).toBe("work-team");
    expect(accountSlug("a.b_c-d")).toBe("a.b_c-d");
    expect(accountSlug("///")).toBe("account");
  });

  it("names two accounts whose labels share a slug apart, the second -2", async () => {
    // Labels are unique ignoring case; these two differ, and slug alike.
    const t = await start({}, { accounts: [{ id: "Max One", provider: "fake" }, { id: "max-one", provider: "fake" }] });
    const { token } = await program(t);
    const list = CompletionsModelList.parse(await (await get(t, "/v1/models", token)).json());
    expect(list.data.filter((model) => model.family === "opus").map((model) => [model.id, model["agent-harness"].accountId])).toEqual([
      ["max-one/opus", "Max One"],
      ["max-one-2/opus", "max-one"],
    ]);
    const second = await complete(t, token, turn("Hi", { model: "max-one-2/opus" }));
    expect(second.model).toBe("max-one-2/opus");
    expect(payloadsOf<RunStartedPayload>(t, second["agent-harness"].sessionId as string, "run.started")[0]?.accountId).toBe("max-one");
  });

  it("answers 503 before the startup gate", async () => {
    const dataDir = join(tempDir(), "data");
    const earlier = await startTestEnvironment({ dataDir });
    const { token } = await program(earlier);
    await earlier.close();
    const hold = holdBefore("prepared");
    const starting = startTestEnvironment({ dataDir, hooks: hold.hooks });
    onCleanup(async () => {
      hold.release();
      await (await starting).close();
    });
    const address = await hold.reached;
    if (address === undefined) throw new Error("The listener was not bound before the prepared step.");
    const early = await fetch(`http://${address.host}:${address.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(turn("Hi")),
    });
    expect(await refusalOf(early)).toMatchObject({ status: 503, body: { error: { code: "unavailable" } } });
  });

  it("answers 503 to a turn that arrives once the environment has begun to stop", async () => {
    const t = await start();
    const { token } = await program(t);
    const release = await deafSocket(t);
    const closing = t.env.close();
    // The wire waits out its grace for the deaf socket, on the manual clock: the listeners are still up.
    await vi.waitFor(async () => expect(await refusalOf(await post(t, token, turn("Late")))).toMatchObject({ status: 503, body: { error: { code: "unavailable", message: "The environment is stopping." } } }));
    release();
    t.clock.advance(1000);
    await closing;
    expect(t.adapter.runs).toHaveLength(0);
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
    const models = await fetch(url(t, "/v1/models"), { method: "POST", headers: bearer(token) });
    expect(models.status).toBe(405);
    expect(models.headers.get("allow")).toBe("GET, HEAD");
    expect((await fetch(url(t, "/v1/models"), { method: "HEAD", headers: bearer(token) })).status).toBe(200);
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

  it("refuses an expired token 401 expired", async () => {
    const t = await start();
    const { token } = await program(t);
    t.clock.advance(30 * DAY);
    expect(await refusalOf(await post(t, token, turn("Hi")))).toMatchObject({ status: 401, body: { error: { code: "expired" } } });
  });

  it("refuses a body past its cap 413 too_large", async () => {
    const t = await start();
    const { token } = await program(t);
    const refused = await refusalOf(await post(t, token, JSON.stringify(turn("x".repeat(64 * 1024 * 1024 + 1)))));
    expect(refused).toMatchObject({ status: 413, body: { error: { code: "too_large" } } });
  });

  it("refuses a model of a signed-out account 409 account_unavailable, recording nothing", async () => {
    const t = await start(signedOut("work-lapsed"), { accounts: [{ id: "claude-max", provider: "fake" }, { id: "work-lapsed", provider: "fake" }] });
    const { token } = await program(t);
    expect(await refusalOf(await post(t, token, { ...turn("Hi"), model: "work-lapsed/opus" }))).toMatchObject({ status: 409, body: { error: { code: "account_unavailable" } } });
    expect(await listed(t)).toEqual([]);
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
    expect(await reading.next()).toEqual({ kind: "comment", text: "keep-alive" });
    t.clock.advance(COMPLETIONS_HEARTBEAT_MS - 1);
    t.clock.advance(1);
    expect(await reading.next()).toEqual({ kind: "comment", text: "keep-alive" });
    held.open();
    const rest = await reading.rest();
    expect(rest.filter((message) => message.kind === "comment")).toEqual([]);
    expect(contentOf(chunksOf(rest))).toBe("Late reply");
  });

  it("opens a turn queued onto a live run with its first chunk at once, and keeps it alive while the run is silent", async () => {
    const t = await start();
    const { token } = await program(t);
    const held = gate();
    t.adapter.nextScripts.push(async function* ({ nextSent }) {
      yield say("Working");
      await held.opened;
      yield say(`Also: ${(await nextSent()).text}`);
      yield end();
    });
    const first = await stream(t, token, turn("Start"));
    const sessionId = (await first.chunk())["agent-harness"].sessionId as string;
    await first.chunk();
    // Queued onto the live run mid-turn: its message.sent renders the first chunk at once, which arms the heartbeat;
    // nothing else of the run follows until the provider reads the message.
    const queued = sse(await post(t, token, turn("and tidy up", { stream: true, "agent-harness": { sessionId } })));
    expect(await queued.next()).toMatchObject({ kind: "chunk", chunk: { "agent-harness": { delivery: "queued" } } });
    t.clock.advance(COMPLETIONS_HEARTBEAT_MS);
    expect(await queued.next()).toEqual({ kind: "comment", text: "keep-alive" });
    held.open();
    await queued.rest();
    await first.rest();
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

  it("ends the answer with an internal error chunk when the session cannot be read back, and a whole answer 500", async () => {
    const t = await start();
    const { token } = await program(t);
    const readStream = t.env.log.readStream.bind(t.env.log);
    let failNext = 0;
    vi.spyOn(t.env.log, "readStream").mockImplementation((selector, afterSequence, limit) => {
      if (failNext > 0 && limit === undefined && (afterSequence ?? 0) > 0) {
        failNext -= 1;
        throw new Error("The disk went away.");
      }
      return readStream(selector, afterSequence, limit);
    });
    failNext = 1;
    const messages = await (await stream(t, token, turn("Hi"))).rest();
    expect(messages.at(-1)).toEqual({ kind: "done" });
    expect(chunksOf(messages).at(-1)).toMatchObject({ choices: [{ index: 0, delta: {}, finish_reason: "error" }], error: { code: "internal" } });
    failNext = 1;
    expect(await refusalOf(await post(t, token, turn("Hi")))).toMatchObject({ status: 500, body: { error: { code: "internal" } } });
  });

  it("closes the connection of a client that stops reading once its answer backs up, and the run goes on", async () => {
    const block = "x".repeat(1024 * 1024);
    const t = await start({ script: () => [...Array.from({ length: 32 }, (_, index) => delta("i1", `${index}${block}`)), end()] });
    const { token } = await program(t);
    // A client that sends its request and then reads nothing: its socket paused, so the kernel's buffers fill and the answer backs up.
    const body = JSON.stringify(turn("Say a lot", { stream: true }));
    const socket = connect(t.address.port, t.address.host);
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    socket.pause();
    socket.write(
      `POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:${t.address.port}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    // 32 MiB through the log takes a while on a loaded runner.
    const slow = { timeout: 30_000, interval: 50 };
    await vi.waitFor(async () => expect(await listed(t)).toHaveLength(1), slow);
    const sessionId = (await listed(t))[0]?.id as string;
    await vi.waitFor(() => expect(ofType(t, sessionId, "run.ended")).toHaveLength(1), slow);
    expect(payloadsOf<{ reason: string }>(t, sessionId, "run.ended")[0]?.reason).toBe("completed");
    // Nothing drained for a heartbeat's time: the connection is closed.
    t.clock.advance(COMPLETIONS_HEARTBEAT_MS);
    let received = "";
    socket.on("data", (data: Buffer) => (received += data.toString("utf8")));
    socket.on("error", () => undefined);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.resume();
    await closed;
    expect(received.startsWith("HTTP/1.1 200")).toBe(true);
    expect(received).not.toContain("[DONE]");
  }, 60_000);

  it("never matches a stop sequence against the blank line it puts between two items", async () => {
    const t = await start({ script: () => [say("First."), say("Second."), end()] });
    const { token } = await program(t);
    const chunks = chunksOf(await (await stream(t, token, turn("Two", { stop: "\n" }))).rest());
    expect(contentOf(chunks)).toBe("First.\n\nSecond.");
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop");
  });

  it("answers 503 to a turn whose body arrives after the environment began to stop, starting nothing", async () => {
    const t = await start();
    const { token } = await program(t);
    const body = JSON.stringify(turn("Late"));
    const socket = connect(t.address.port, t.address.host);
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    let received = "";
    socket.on("data", (data: Buffer) => (received += data.toString("utf8")));
    socket.on("error", () => undefined);
    // The headers and half the body: the request waits in its body read.
    socket.write(
      `POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:${t.address.port}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body.slice(0, 10)}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const release = await deafSocket(t);
    const closing = t.env.close();
    // The surface has closed; the wire waits out its grace for the deaf socket, so the listeners are still up.
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.write(body.slice(10));
    await vi.waitFor(() => expect(received).toMatch(/^HTTP\/1\.1 503/));
    expect(received).toContain("The environment is stopping.");
    expect(t.adapter.runs).toHaveLength(0);
    socket.destroy();
    release();
    t.clock.advance(1000);
    await closing;
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

  it("continues a session named by its id in upper case", async () => {
    const t = await start();
    const { token } = await program(t);
    const sessionId = (await complete(t, token, turn("Hi")))["agent-harness"].sessionId as string;
    const again = await complete(t, token, turn("Again", { "agent-harness": { sessionId: sessionId.toUpperCase() } }));
    expect(again["agent-harness"].sessionId).toBe(sessionId);
    expect(payloadsOf<RunStartedPayload>(t, sessionId, "run.started")).toHaveLength(2);
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

  it("forks through sessions.fork as the program's client session, and runs the turn on the fork as a continued session, the earlier messages dropped", async () => {
    const t = await start(forking);
    const { token, clientSessionId } = await program(t);
    const sessionId = (await complete(t, token, turn("First")))["agent-harness"].sessionId as string;
    const anchor = (await complete(t, token, turn("Second", { "agent-harness": { sessionId } })))["agent-harness"].messageId as string;

    const forked = await complete(t, token, replayed("Second, the other way", { sessionId, forkSession: true, rewindToMessageId: anchor.toUpperCase() }));
    const forkId = forked["agent-harness"].sessionId as string;
    expect(forkId).not.toBe(sessionId);
    const [record] = ofType(t, forkId, "session.forked");
    expect(record?.payload).toEqual({ fromSessionId: sessionId, atMessageId: anchor, fromProviderSessionId: "provider-1" });
    expect(record?.actor).toBe(`client_session:${clientSessionId}`);
    // The fork's first run continues the source's conversation up to the anchor: the request's earlier messages are not replayed.
    expect(t.adapter.lastRun().input).toMatchObject({ sessionId: forkId, target: { kind: "fork", providerSessionId: "provider-1", atMessageId: anchor } });
    expect(t.adapter.lastRun().input.prompt.map((message) => message.text)).toEqual(["Second, the other way"]);
    expect(payloadsOf<RunStartedPayload>(t, forkId, "run.started")).toEqual([expect.objectContaining({ origin: "completions", forkedFrom: sessionId, resumedFrom: "provider-1" })]);
    expect((await listed(t)).find((session) => session.id === forkId)?.tags).toEqual(["completions"]);
    expect(forksAndRewinds(t)).toEqual([{ type: "session.forked", streamId: forkId }]);
  });

  it("rewinds through sessions.rewind as the program's client session before the turn, which continues from before the message, the earlier messages dropped", async () => {
    const t = await start(forking);
    const { token, clientSessionId } = await program(t);
    const sessionId = (await complete(t, token, turn("First")))["agent-harness"].sessionId as string;
    const anchor = (await complete(t, token, turn("Second", { "agent-harness": { sessionId } })))["agent-harness"].messageId as string;

    const again = await complete(t, token, replayed("Second, differently", { sessionId, rewindToMessageId: anchor }));
    expect(again["agent-harness"].sessionId).toBe(sessionId);
    expect(ofType(t, sessionId, "session.rewound").map((event) => [event.payload, event.actor])).toEqual([[{ toMessageId: anchor }, `client_session:${clientSessionId}`]]);
    expect(t.adapter.lastRun().input).toMatchObject({ sessionId, target: { kind: "rewind", providerSessionId: "provider-1", toMessageId: anchor } });
    expect(t.adapter.lastRun().input.prompt.map((message) => message.text)).toEqual(["Second, differently"]);
  });

  it("answers a fork's or a rewind's own refusal at the request's field that asked for it, and records nothing", async () => {
    const t = await start(forking);
    const { token } = await program(t);
    const first = await complete(t, token, turn("First"));
    const sessionId = first["agent-harness"].sessionId as string;
    const anchor = (await complete(t, token, turn("Second", { "agent-harness": { sessionId } })))["agent-harness"].messageId as string;
    // A message the session's visible transcript does not hold, for a fork and for a rewind.
    for (const fork of [true, false]) {
      expect(await refusalOf(await post(t, token, turn("Again", { "agent-harness": { sessionId, forkSession: fork, rewindToMessageId: randomUUID() } })))).toMatchObject({
        status: 404,
        body: { error: { code: "message_not_found", param: "agent-harness.rewindToMessageId" } },
      });
    }
    // The session's first message: nothing comes before it to continue from.
    expect(await refusalOf(await post(t, token, turn("Again", { "agent-harness": { sessionId, rewindToMessageId: first["agent-harness"].messageId } })))).toMatchObject({
      status: 409,
      body: { error: { type: "conflict_error", code: "use_new_session", param: "agent-harness.rewindToMessageId" } },
    });
    // A run is live: a rewind waits for it, where a turn alone would be queued to it.
    const held = gate();
    t.adapter.nextScripts.push(heldScript(held.opened));
    const live = await stream(t, token, turn("Third", { "agent-harness": { sessionId } }));
    await live.chunk();
    expect(await refusalOf(await post(t, token, turn("Again", { "agent-harness": { sessionId, rewindToMessageId: anchor } })))).toMatchObject({
      status: 409,
      body: { error: { code: "run_active", param: "agent-harness.rewindToMessageId" } },
    });
    held.open();
    await live.rest();
    expect(forksAndRewinds(t)).toEqual([]);
    expect((await listed(t)).map((session) => session.id)).toEqual([sessionId]);

    // An adapter that neither forks nor rewinds.
    const plain = await start({ script: linking("provider-1") });
    const plainToken = (await program(plain)).token;
    const plainId = (await complete(plain, plainToken, turn("First")))["agent-harness"].sessionId as string;
    const plainAnchor = (await complete(plain, plainToken, turn("Second", { "agent-harness": { sessionId: plainId } })))["agent-harness"].messageId as string;
    expect(await refusalOf(await post(plain, plainToken, turn("Again", { "agent-harness": { sessionId: plainId, forkSession: true } })))).toMatchObject({
      status: 400,
      body: { error: { code: "unsupported", param: "agent-harness.forkSession" } },
    });
    expect(await refusalOf(await post(plain, plainToken, turn("Again", { "agent-harness": { sessionId: plainId, rewindToMessageId: plainAnchor } })))).toMatchObject({
      status: 400,
      body: { error: { code: "unsupported", param: "agent-harness.rewindToMessageId" } },
    });
    expect(forksAndRewinds(plain)).toEqual([]);
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
    expect(opening["agent-harness"]).toMatchObject({ delivery: "queued" });
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

  it("carries a completions run's own instructions and extra skills to its queue, ignoring new skills on a live run", async () => {
    const t = await start({ capabilities: { providerQueue: false, steering: false } }, { adapterSeams: { instructions: composed } });
    const client = await t.client();
    for (const name of ["filing", "later"]) {
      await client.request("skills.own.create", { commandId: randomUUID(), name, description: "File by year." });
      writeFileSync(join(t.dataDir, "skills", "own", "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: File by year.\n---\nSKILL BODY ${name}`);
    }
    const { token } = await program(t);
    const held = gate();
    t.adapter.nextScripts.push(heldScript(held.opened));
    const first = await stream(t, token, turn("First", { "agent-harness": { systemPrompt: "Persona: tidy.", alwaysOnSkills: ["filing"] } }));
    const sessionId = (await first.chunk())["agent-harness"].sessionId as string;
    const second = await stream(t, token, turn("Then this", { "agent-harness": { sessionId, alwaysOnSkills: ["later"] } }));
    expect((await second.chunk())["agent-harness"].ignored).toEqual(["agent-harness.alwaysOnSkills.0"]);
    held.open();
    await second.rest();
    await first.rest();
    expect(t.adapter.runs).toHaveLength(2);
    const instructions = t.adapter.runs.map((run) => run.input.instructions);
    expect(instructions[0]).toBe(instructions[1]);
    expect(instructions[1]).toContain("SKILL BODY filing\n\nPersona: tidy.");
    expect(instructions[1]).not.toContain("SKILL BODY later");
  });

  it("does not restore a completions run's extra skills when the queue is read after restart", async () => {
    const dataDir = join(tempDir("agent-harness-extra-skills-"), "data");
    const t = await start({ capabilities: { providerQueue: false, steering: false } }, { dataDir, adapterSeams: { instructions: composed } });
    const client = await t.client();
    await client.request("skills.own.create", { commandId: randomUUID(), name: "filing", description: "File by year." });
    writeFileSync(join(dataDir, "skills", "own", "skills", "filing", "SKILL.md"), "---\nname: filing\ndescription: File by year.\n---\nSKILL BODY filing");
    const { token } = await program(t);
    const held = gate();
    t.adapter.nextScripts.push(heldScript(held.opened));
    const first = await stream(t, token, turn("First", { "agent-harness": { alwaysOnSkills: ["filing"] } }));
    const sessionId = (await first.chunk())["agent-harness"].sessionId as string;
    const second = await stream(t, token, turn("Then this", { "agent-harness": { sessionId } }));
    await second.chunk();
    await t.close();
    held.open();
    await first.rest();
    await second.rest();
    const restarted = await start({}, { dataDir, adapterSeams: { instructions: composed } });
    const after = await restarted.client();
    const read = registry["runs.readNow"].response.parse(await after.request("runs.readNow", { commandId: randomUUID(), sessionId }));
    expect(read.result).toHaveProperty("runId");
    await vi.waitFor(() => expect(restarted.adapter.runs).toHaveLength(1), { timeout: 10_000 });
    expect(restarted.adapter.lastRun().input.prompt.map((message) => message.text)).toContain("Then this");
    expect(restarted.adapter.lastRun().input.instructions).toBe("COMPOSED");
  });

  it("reports the usage of the run the answer ended with, not of a run it followed before", async () => {
    const t = await start({ capabilities: { providerQueue: false, steering: false } });
    const { token } = await program(t);
    const held = gate();
    t.adapter.nextScripts.push(async function* () {
      await held.opened;
      yield say("First done");
      yield usage(40, 7);
      yield end();
    });
    const first = await stream(t, token, turn("First"));
    const sessionId = (await first.chunk())["agent-harness"].sessionId as string;
    const second = await stream(t, token, turn("Then this", { stream_options: { include_usage: true }, "agent-harness": { sessionId } }));
    await second.chunk();
    held.open();
    const chunks = chunksOf(await second.rest());
    expect(contentOf(chunks)).toBe("First done\n\nDone: Then this");
    // The run that read the queued message reported no usage of its own.
    expect(chunks.at(-1)?.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } });
    await first.rest();
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
    expect(last?.["agent-harness"]).toMatchObject({ waiting: steered["agent-harness"].messageId, ended: { reason: "interrupted", cause: "user" } });
    expect(last?.choices[0]?.finish_reason).toBe("error");
    expect(payloadsOf<RunStartedPayload>(t, sessionId, "run.started")).toHaveLength(1);
  });

  it("carries a completions run's own instructions to the run a read-now starts from the queue, with a run live or not, and follows the queued turn into it", async () => {
    const t = await start({ capabilities: { providerQueue: false, steering: false } }, { adapterSeams: { instructions: composed } });
    const { token } = await program(t);
    const client = await t.client();
    // A run is live: the read-now interrupts it, and the run of the queue reads the queued turn.
    t.adapter.nextScripts.push(heldScript(gate().opened));
    const first = await stream(t, token, turn("First", { "agent-harness": { systemPrompt: "Persona: tidy." } }));
    const live = (await first.chunk())["agent-harness"].sessionId as string;
    const queued = await stream(t, token, turn("Then this", { "agent-harness": { sessionId: live } }));
    await queued.chunk();
    // Each interrupt below waits for its adapter to have the run: one still composing its instructions ends without reading
    // its prompt, which the run of the queue then reads too, with the held script this run was given.
    await t.adapter.reached(1);
    await client.request("runs.readNow", { commandId: randomUUID(), sessionId: live });
    const chunks = chunksOf(await queued.rest());
    expect(contentOf(chunks)).toBe("Done: Then this");
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop");
    // None is: an interrupt left the queued turn waiting, and the read-now starts the run of the queue itself.
    t.adapter.nextScripts.push(heldScript(gate().opened));
    const second = await stream(t, token, turn("First", { "agent-harness": { systemPrompt: "Persona: terse." } }));
    const opening = await second.chunk();
    const idle = opening["agent-harness"].sessionId as string;
    const waiting = await stream(t, token, turn("Then this", { "agent-harness": { sessionId: idle } }));
    await waiting.chunk();
    await t.adapter.reached(3);
    await client.request("runs.interrupt", { commandId: randomUUID(), runId: opening["agent-harness"].runId as string });
    expect(chunksOf(await waiting.rest()).at(-1)?.["agent-harness"].waiting).toBeDefined();
    await client.request("runs.readNow", { commandId: randomUUID(), sessionId: idle });
    await untilEnded(t, idle, 2);
    expect(t.adapter.runs.map((run) => [run.input.sessionId, run.input.instructions])).toEqual([
      [live, "COMPOSED\n\nPersona: tidy."],
      [live, "COMPOSED\n\nPersona: tidy."],
      [idle, "COMPOSED\n\nPersona: terse."],
      [idle, "COMPOSED\n\nPersona: terse."],
    ]);
  });

  it("follows a queued turn into a read-now's run that starts only once the interrupt has answered, a later turn than the run's end", async () => {
    // The provider answers the interrupt after the run's end, as a real one may: the run of the queue waits for both.
    const answered = gate();
    const adapter = fakeAdapter({ capabilities: { providerQueue: false, steering: false } });
    const createRun = adapter.createRun;
    const t = await start({
      ...adapter,
      createRun: (input, context) => {
        const run = createRun(input, context);
        return {
          ...run,
          interrupt: async () => {
            const receipt = await run.interrupt();
            await answered.opened;
            return receipt;
          },
        };
      },
    });
    const { token } = await program(t);
    t.adapter.nextScripts.push(heldScript(gate().opened));
    const first = await stream(t, token, turn("First"));
    const sessionId = (await first.chunk())["agent-harness"].sessionId as string;
    const queued = await stream(t, token, turn("Then this", { "agent-harness": { sessionId } }));
    await queued.chunk();
    // Once its adapter has the run, whose interrupt is the one held: a run still composing ends without asking it.
    await t.adapter.reached(1);
    const client = await t.client();
    await client.request("runs.readNow", { commandId: randomUUID(), sessionId });
    await untilEnded(t, sessionId);
    expect(payloadsOf<{ cause: string | null }>(t, sessionId, "run.ended")[0]?.cause).toBe("read-now");
    // Well past the end's own turn of the event loop: the answer still waits for the run that reads its message.
    await new Promise((resolve) => setTimeout(resolve, 30));
    answered.open();
    const chunks = chunksOf(await queued.rest());
    expect(contentOf(chunks)).toBe("Done: Then this");
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop");
    expect(chunks.at(-1)?.["agent-harness"].waiting).toBeUndefined();
  });

  it("ends a queued turn's answer when its message is withdrawn, which no run will read: an error chunk, withdrawn, and 409 for a whole answer", async () => {
    const t = await start({ capabilities: { providerQueue: false, steering: false } });
    const { token } = await program(t);
    const client = await t.client();
    const held = gate();
    t.adapter.nextScripts.push(heldScript(held.opened));
    const first = await stream(t, token, turn("First"));
    const sessionId = (await first.chunk())["agent-harness"].sessionId as string;
    const queued = await stream(t, token, turn("Then this", { "agent-harness": { sessionId } }));
    const opening = await queued.chunk();
    await client.request("runs.withdraw", { commandId: randomUUID(), messageId: opening["agent-harness"].messageId as string });
    const last = chunksOf(await queued.rest()).at(-1);
    expect(last?.choices[0]?.finish_reason).toBe("error");
    expect(last?.error).toMatchObject({ code: "withdrawn" });
    expect(last?.["agent-harness"].waiting).toBeUndefined();
    // A whole answer, withdrawn while it waits.
    const before = ofType(t, sessionId, "message.sent").length;
    const whole = post(t, token, turn("And this", { "agent-harness": { sessionId } }));
    const sent = (await untilLogged(t, sessionId, "message.sent", before + 1)).at(-1);
    expect(sent?.payload["text"]).toBe("And this");
    await client.request("runs.withdraw", { commandId: randomUUID(), messageId: sent?.payload["messageId"] as string });
    expect(await refusalOf(await whole)).toMatchObject({ status: 409, body: { error: { type: "conflict_error", code: "withdrawn" }, "agent-harness": { sessionId } } });
    // The run the messages were queued to goes on to its end.
    held.open();
    expect(contentOf(chunksOf(await first.rest()))).toBe("Late reply");
  });

  it("records no fork and no rewind for a turn refused after them: an effort the model does not take, an account not signed in, an attachment kind the adapter does not take, a session on another account", async () => {
    const t = await start(
      { ...forking, ...signedOut("work-lapsed") },
      { accounts: [{ id: "claude-max", provider: "fake" }, { id: "work", provider: "fake" }, { id: "work-lapsed", provider: "fake" }] },
    );
    const { token } = await program(t);
    const sessionId = (await complete(t, token, turn("First")))["agent-harness"].sessionId as string;
    // A message a fork can be taken at and a rewind can go back to: every refusal below is the turn's, not theirs.
    const anchor = (await complete(t, token, turn("Second", { "agent-harness": { sessionId } })))["agent-harness"].messageId as string;
    const fork = { sessionId, forkSession: true, rewindToMessageId: anchor };
    const rewind = { sessionId, rewindToMessageId: anchor };
    expect(await refusalOf(await post(t, token, turn("Fork", { "agent-harness": { ...fork, thinking: "turbo" } })))).toMatchObject({
      status: 400,
      body: { error: { code: "invalid_params", param: "agent-harness.thinking" } },
    });
    expect(await refusalOf(await post(t, token, { ...turn("Fork"), model: "work-lapsed/opus", "agent-harness": fork }))).toMatchObject({
      status: 409,
      body: { error: { code: "account_unavailable" } },
    });
    expect(await refusalOf(await post(t, token, turn("Back", { reasoning_effort: "turbo", "agent-harness": rewind })))).toMatchObject({
      status: 400,
      body: { error: { param: "reasoning_effort" } },
    });
    expect(await refusalOf(await post(t, token, { ...turn("Back"), model: "work/opus", "agent-harness": rewind }))).toMatchObject({
      status: 409,
      body: { error: { code: "account_mismatch" } },
    });
    // The fake adapter, like Claude's, takes images and no files.
    const png = { kind: "image", name: "shot.png", mediaType: "image/png", data: Buffer.from("png").toString("base64") };
    const notes = { kind: "file", name: "notes.txt", mediaType: "text/plain", data: Buffer.from("notes").toString("base64") };
    for (const asked of [fork, rewind]) {
      expect(await refusalOf(await post(t, token, turn("With notes", { "agent-harness": { ...asked, attachments: [png, notes] } })))).toMatchObject({
        status: 400,
        body: { error: { code: "unsupported", param: "agent-harness.attachments.1.kind" } },
      });
    }
    expect(forksAndRewinds(t)).toEqual([]);
    expect((await listed(t)).map((session) => session.id)).toEqual([sessionId]);
    // The same turns without the fault fork and rewind.
    await complete(t, token, turn("Fork", { "agent-harness": fork }));
    await complete(t, token, turn("Back", { "agent-harness": rewind }));
    expect(forksAndRewinds(t).map((event) => event.type)).toEqual(["session.forked", "session.rewound"]);
  });

  it("resolves a bare model continuing a session on the session's account, not the default", async () => {
    const t = await start({}, { accounts: [{ id: "claude-max", provider: "fake" }, { id: "work", provider: "fake" }] });
    const { token } = await program(t);
    const sessionId = (await complete(t, token, { ...turn("Hi"), model: "work/sonnet" }))["agent-harness"].sessionId as string;
    const next = await complete(t, token, { ...turn("Again"), model: "opus", "agent-harness": { sessionId } });
    expect(next.model).toBe("work/opus");
    expect(payloadsOf<RunStartedPayload>(t, sessionId, "run.started").map((run) => run.accountId)).toEqual(["work", "work"]);
    // A fresh session's bare model is the default account's.
    expect((await complete(t, token, { ...turn("New"), model: "opus" })).model).toBe("claude-max/opus");
  });

  it("refuses after past the log's head, and reports it ignored when nothing live could use it", async () => {
    const t = await start();
    const { token } = await program(t);
    const sessionId = (await complete(t, token, turn("Hi")))["agent-harness"].sessionId as string;
    expect(await refusalOf(await post(t, token, turn("Hi", { "agent-harness": { sessionId, after: t.env.log.head() + 1 } })))).toMatchObject({
      status: 400,
      body: { error: { code: "invalid_params", param: "agent-harness.after" } },
    });
    const idle = await complete(t, token, turn("Again", { "agent-harness": { sessionId, after: 1 } }));
    expect(idle["agent-harness"].ignored).toEqual(["agent-harness.after"]);
  });

  it("reports what a queued message cannot take as ignored, each by its own path", async () => {
    const t = await start();
    const { token } = await program(t);
    t.adapter.nextScripts.push(async function* ({ nextSent }) {
      yield say("Working");
      yield say(`Also: ${(await nextSent()).text}`);
      yield end();
    });
    const first = await stream(t, token, turn("Start"));
    const sessionId = (await first.chunk())["agent-harness"].sessionId as string;
    // Queued on the provider's run, once its adapter has it.
    await t.adapter.reached(1);
    const queued = await stream(t, token, {
      model: "claude-max/opus",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "and tidy up" },
      ],
      reasoning_effort: "high",
      "agent-harness": { sessionId, permissionMode: "plan", attended: true },
    });
    expect((await queued.chunk())["agent-harness"].ignored).toEqual(["agent-harness.permissionMode", "messages.0", "reasoning_effort", "agent-harness.attended"]);
    await queued.rest();
    await first.rest();
  });

  it("reports a model other than the live run's ignored on a queued message, and names the live run's model on every chunk", async () => {
    const t = await start();
    const { token } = await program(t);
    t.adapter.nextScripts.push(async function* ({ nextSent }) {
      yield say("Working");
      yield say(`Also: ${(await nextSent()).text}`);
      yield say(`And: ${(await nextSent()).text}`);
      yield end();
    });
    const first = await stream(t, token, { ...turn("Start"), model: "claude-max/sonnet" });
    const sessionId = (await first.chunk())["agent-harness"].sessionId as string;
    await t.adapter.reached(1);
    // The live run reads the message in its own model, so the answer names that one, the usage chunk too.
    const other = await stream(t, token, {
      ...turn("and tidy up", { reasoning_effort: "high", stream_options: { include_usage: true } }),
      model: "claude-max/opus",
      "agent-harness": { sessionId },
    });
    const opening = await other.chunk();
    expect(opening["agent-harness"].ignored).toEqual(["model", "reasoning_effort"]);
    // The live run's own model, named bare: nothing is ignored.
    const same = await complete(t, token, { ...turn("and sweep"), model: "sonnet", "agent-harness": { sessionId } });
    expect(same).toMatchObject({ model: "claude-max/sonnet", "agent-harness": { delivery: "queued", ignored: [] } });
    const chunks = [opening, ...chunksOf(await other.rest())];
    expect(chunks.at(-1)?.usage).toBeDefined();
    expect(new Set(chunks.map((chunk) => chunk.model))).toEqual(new Set(["claude-max/sonnet"]));
    await first.rest();
  });

  it("names the live run's own model id once its account has left the listing, and reports the requested model ignored", async () => {
    const t = await start({}, { accounts: [{ id: "claude-max", provider: "fake" }, { id: "work", provider: "fake" }] });
    const { token } = await program(t);
    const client = await t.client();
    // A session with no account of its own runs on the default, claude-max, the first.
    const sessionId = randomUUID();
    await create(client, { id: sessionId });
    const held = gate();
    t.adapter.nextScripts.push(async function* ({ nextSent }) {
      await held.opened;
      yield say(`Also: ${(await nextSent()).text}`);
      yield end();
    });
    const first = await stream(t, token, turn("Start", { "agent-harness": { sessionId } }));
    await first.chunk();
    // Once its adapter has the run, so the provider holds the queued message the script reads; one queued while the run
    // still composes its instructions waits in the environment's queue for the run after, which this run never ends for.
    await t.adapter.reached(1);
    // Its account is removed while the run goes on, and work becomes the default a bare model names.
    await client.request("accounts.remove", { commandId: randomUUID(), accountId: "claude-max" });
    const queued = await stream(t, token, { ...turn("and tidy up"), model: "opus", "agent-harness": { sessionId } });
    const opening = await queued.chunk();
    expect(opening).toMatchObject({ model: "opus", "agent-harness": { delivery: "queued", ignored: ["model"] } });
    held.open();
    expect(new Set(chunksOf(await queued.rest()).map((chunk) => chunk.model))).toEqual(new Set(["opus"]));
    await first.rest();
    await client.close();
  });

  it("ends the answer with an internal error chunk when where the queued message waits cannot be read", async () => {
    const t = await start({ capabilities: { providerQueue: false, steering: false } });
    const { token } = await program(t);
    t.adapter.nextScripts.push(heldScript(gate().opened));
    const first = await stream(t, token, turn("First"));
    const opening = await first.chunk();
    const sessionId = opening["agent-harness"].sessionId as string;
    const second = await stream(t, token, turn("Then this", { "agent-harness": { sessionId } }));
    await second.chunk();
    const read = t.env.log.read.bind(t.env.log);
    vi.spyOn(t.env.log, "read").mockImplementation(((sql: string, ...params: never[]) => {
      if (sql.startsWith("SELECT held_by FROM run_messages")) throw new Error("The disk went away.");
      return read(sql, ...params);
    }) as typeof t.env.log.read);
    const client = await t.client();
    await client.request("runs.interrupt", { commandId: randomUUID(), runId: opening["agent-harness"].runId as string });
    const last = chunksOf(await second.rest()).at(-1);
    expect(last).toMatchObject({ choices: [{ index: 0, delta: {}, finish_reason: "error" }], error: { code: "internal" } });
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
    expect(chunks[0]?.["agent-harness"]).toMatchObject({ sessionId, runId: opening["agent-harness"].runId, delivery: "queued" });
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
    await untilLogged(t, sessionId, "prompt.opened");
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
  it("appends systemPrompt and the system and developer messages after the composed instructions, and honours enabled alwaysOnSkills, reporting disabled and unknown names by path", async () => {
    const t = await start({}, { adapterSeams: { instructions: composed } });
    const client = await t.client();
    for (const name of ["filing", "off", "account"]) {
      await client.request("skills.own.create", { commandId: randomUUID(), name, description: "File by year." });
      writeFileSync(join(t.dataDir, "skills", "own", "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: File by year.\n---\nSKILL BODY ${name}`);
    }
    await client.request("skills.setEnabled", { commandId: randomUUID(), name: "off", accountId: "claude-max", enabled: false });
    await client.request("skills.setAlwaysOn", { commandId: randomUUID(), name: "account", accountId: "claude-max", on: true });
    const { token } = await program(t);
    const reading = await stream(t, token, {
      model: "claude-max/opus",
      messages: [
        { role: "system", content: "You are the librarian." },
        { role: "developer", content: [{ type: "text", text: "File by year." }] },
        { role: "user", content: "File this" },
      ],
      "agent-harness": { systemPrompt: "Persona: tidy.", alwaysOnSkills: ["filing", "missing", "off", "filing"] },
    });
    const first = await reading.chunk();
    await reading.rest();
    const instructions = t.adapter.lastRun().input.instructions ?? "";
    expect(instructions).toContain("COMPOSED\n\n# Always-on skill: account");
    expect(instructions.indexOf("SKILL BODY account")).toBeLessThan(instructions.indexOf("# Always-on skill: filing"));
    expect(instructions).toContain("SKILL BODY filing\n\nPersona: tidy.\n\nYou are the librarian.\n\nFile by year.");
    expect(instructions.match(/# Always-on skill: filing/g)).toHaveLength(1);
    expect(instructions).not.toContain("SKILL BODY off");
    expect(t.adapter.lastRun().input.prompt.map((message) => message.text)).toEqual(["File this"]);
    expect(first["agent-harness"].ignored).toEqual(["agent-harness.alwaysOnSkills.1", "agent-harness.alwaysOnSkills.2"]);
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
    // Cut before the run ended, the answer has no usage to give.
    expect(whole.usage).toBeUndefined();
    const sessionId = whole["agent-harness"].sessionId as string;
    await untilEnded(t, sessionId);
    expect(payloadsOf<{ reason: string }>(t, sessionId, "run.ended")[0]?.reason).toBe("completed");
  });

  it("ends the answer for its length when the budget falls before a stop sequence in the same text", async () => {
    const t = await start({ script: () => [delta("i1", "alpha STOP beta"), text("i1", "alpha STOP beta"), end()] });
    const { token } = await program(t);
    const whole = await complete(t, token, turn("Go", { stop: "STOP", max_tokens: 1 }));
    expect(whole.choices[0]).toMatchObject({ message: { content: "alph" }, finish_reason: "length" });
    expect(whole.usage).toBeUndefined();
  });

  it("reports what it ignored by path: a content part by its index, an extension field it does not know", async () => {
    const t = await start();
    const { token } = await program(t);
    const answer = await complete(t, token, {
      model: "claude-max/opus",
      messages: [{ role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: "data:," } }] }],
      "agent-harness": { ignoreUnsupported: true, laterField: "on" },
    });
    expect(answer["agent-harness"].ignored).toEqual(["agent-harness.laterField", "messages.0.content.1"]);
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

  it("gives a fresh session the directory the request names, or a scratch workspace of its own, and refuses a directory it cannot use 400 naming the workspace and the problem", async () => {
    const t = await start();
    const { token } = await program(t);
    const named = tempDir();
    const inNamed = await complete(t, token, turn("Hi", { "agent-harness": { workspace: named } }));
    expect(t.adapter.lastRun().input.workspace).toEqual({ kind: "directory", path: named });
    expect(inNamed["agent-harness"].sessionId).toBeDefined();
    const scratch = await complete(t, token, turn("Hi"));
    const sessionId = scratch["agent-harness"].sessionId as string;
    expect(t.adapter.lastRun().input.workspace).toEqual({ kind: "scratch", path: join(t.dataDir, "scratch", sessionId) });
    expect(statSync(join(t.dataDir, "scratch", sessionId)).isDirectory()).toBe(true);
    const refused = async (workspace: string) => refusalOf(await post(t, token, turn("Hi", { "agent-harness": { workspace } })));
    expect(await refused(join(named, "not-here"))).toMatchObject({
      status: 400,
      body: { error: { type: "invalid_request_error", code: "does_not_exist", message: expect.stringContaining(join(named, "not-here")), param: "agent-harness.workspace" } },
    });
    expect(await refused(t.dataDir)).toMatchObject({ status: 400, body: { error: { code: "reserved", param: "agent-harness.workspace" } } });
    mkdirSync(join(named, "relative"));
    expect(await refused("relative")).toMatchObject({ status: 400, body: { error: { code: "invalid_params", param: "agent-harness.workspace" } } });
    expect(t.adapter.runs).toHaveLength(2);
  });

  it("asks the resolver for a fresh session's workspace, a directory request for one named and a scratch request for none, records what it answers, and turns its refusal into a 400 naming the workspace and the problem", async () => {
    let refuse = false;
    const resolver = scriptedResolver(({ request, sessionId }) =>
      refuse
        ? { refused: { code: "conflict", message: "That directory is reserved.", data: { reason: "workspace_unusable", problem: "reserved" } } }
        : { workspace: { kind: "scratch", path: request.kind === "directory" ? request.path : `/data/scratch/${sessionId}` }, repositoryIdentity: "https://git.systemtech.dev/david/notes" },
    );
    const t = await start({}, { workspaceResolver: resolver });
    const { token } = await program(t);
    const named = tempDir();
    const answered = await complete(t, token, turn("Hi", { "agent-harness": { workspace: named } }));
    const sessionId = answered["agent-harness"].sessionId as string;
    expect(resolver.calls).toEqual([{ request: { kind: "directory", path: named }, sessionId }]);
    expect((await listed(t)).find((summary) => summary.id === sessionId)).toMatchObject({
      workspace: { kind: "scratch", path: named },
      repositoryIdentity: "https://git.systemtech.dev/david/notes",
    });
    const fresh = await complete(t, token, turn("Hi"));
    expect(resolver.calls[1]).toEqual({ request: { kind: "scratch" }, sessionId: fresh["agent-harness"].sessionId });
    refuse = true;
    expect(await refusalOf(await post(t, token, turn("Hi")))).toMatchObject({
      status: 400,
      body: { error: { code: "reserved", message: "That directory is reserved.", param: "agent-harness.workspace" } },
    });
    expect(await listed(t)).toHaveLength(2);
  });

  it("removes the scratch workspace it asked for when the turn records nothing", async () => {
    const t = await start();
    const { token } = await program(t);
    const log = t.env.log;
    const append = log.append.bind(log);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const spy = vi.spyOn(log, "append").mockImplementation((stream, events, options) => {
      if (events.some((event) => event.type === "session.created")) throw new Error("The disk is full.");
      return append(stream, events, options);
    });
    onCleanup(() => {
      spy.mockRestore();
      quiet.mockRestore();
    });
    expect(await refusalOf(await post(t, token, turn("Hi")))).toMatchObject({ status: 500, body: { error: { code: "internal" } } });
    expect(existsSync(join(t.dataDir, "scratch")) ? readdirSync(join(t.dataDir, "scratch")) : []).toEqual([]);
  });

  it("answers a turn refused after its place resolved with its own refusal when what the resolver made cannot be removed, and logs the failed removal", async () => {
    const resolver = scriptedResolver(() => ({
      workspace: { kind: "scratch", path: "/data/scratch/held" },
      repositoryIdentity: null,
      undo: () => {
        throw new Error("The worktree is locked.");
      },
    }));
    const t = await start({}, { workspaceResolver: resolver });
    const { token } = await program(t);
    const log = t.env.log;
    const append = log.append.bind(log);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const spy = vi.spyOn(log, "append").mockImplementation((stream, events, options) => {
      if (events.some((event) => event.type === "session.created")) throw new Error("The disk is full.");
      return append(stream, events, options);
    });
    onCleanup(() => {
      spy.mockRestore();
      quiet.mockRestore();
    });
    expect(await refusalOf(await post(t, token, turn("Hi")))).toMatchObject({ status: 500, body: { error: { code: "internal" } } });
    expect(resolver.calls).toEqual([{ request: { kind: "scratch" }, sessionId: expect.any(String) }]);
    expect(quiet).toHaveBeenCalledWith(expect.stringContaining("resolver made"), expect.objectContaining({ message: "The worktree is locked." }));
  });

  it("names the field whose text passes the 200,000-character cap on the request's own instructions", async () => {
    const t = await start();
    const { token } = await program(t);
    const long = "x".repeat(200_001);
    // systemPrompt alone is bounded by the extension schema.
    expect(await refusalOf(await post(t, token, turn("Hi", { "agent-harness": { systemPrompt: long } })))).toMatchObject({
      status: 400,
      body: { error: { param: "agent-harness.systemPrompt" } },
    });
    const oneMessage = { model: "claude-max/opus", messages: [{ role: "system", content: long }, { role: "user", content: "Hi" }] };
    expect(await refusalOf(await post(t, token, oneMessage))).toMatchObject({ status: 400, body: { error: { code: "invalid_params", param: "messages.0" } } });
    const together = { ...oneMessage, messages: [{ role: "system", content: "x".repeat(150_000) }, { role: "user", content: "Hi" }], "agent-harness": { systemPrompt: "y".repeat(60_000) } };
    expect(await refusalOf(await post(t, token, together))).toMatchObject({ status: 400, body: { error: { code: "invalid_params", param: "messages" } } });
    expect(t.adapter.runs).toHaveLength(0);
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

describe("client-tool passthrough (#139)", () => {
  const WEATHER = {
    type: "function",
    function: { name: "get_weather", description: "The weather in a city.", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
  };
  const TIME = { type: "function", function: { name: "get_time", description: "The time in a city.", parameters: { type: "object", properties: { city: { type: "string" } } } } };

  /** An answer, streamed or whole, as a program reads it: its text, its calls to the program's tools, why it ended, and the harness's fields. */
  interface Answer {
    readonly content: string;
    readonly toolCalls: readonly ChatToolCall[];
    readonly finishReason: string | null;
    /** The first chunk's fields on a stream, the whole answer's otherwise. */
    readonly extension: Chunk["agent-harness"];
    readonly usage: ChatCompletion["usage"];
    /** A stream's chunks; empty for a whole answer. */
    readonly chunks: readonly Chunk[];
  }

  /** Sends `body` and reads the answer, streamed or whole. */
  const exchange = async (t: TestEnvironment, token: string, body: Record<string, unknown>, streaming: boolean): Promise<Answer> => {
    if (!streaming) {
      const whole = await complete(t, token, body);
      const [choice] = whole.choices;
      return { content: choice?.message.content ?? "", toolCalls: choice?.message.tool_calls ?? [], finishReason: choice?.finish_reason ?? null, extension: whole["agent-harness"], usage: whole.usage, chunks: [] };
    }
    const messages = await (await stream(t, token, body)).rest();
    expect(messages.at(-1)).toEqual({ kind: "done" });
    const chunks = chunksOf(messages);
    const toolCalls = chunks.flatMap((chunk) => chunk.choices[0]?.delta.tool_calls ?? []);
    // Each call comes whole, at its index among the answer's calls.
    expect(toolCalls.map((call) => call.index)).toEqual(toolCalls.map((_, index) => index));
    return {
      content: contentOf(chunks),
      toolCalls: toolCalls.map((call) => ({ id: call.id, type: call.type, function: call.function })),
      finishReason: chunks.findLast((chunk) => chunk.choices[0]?.finish_reason !== null && chunk.choices[0]?.finish_reason !== undefined)?.choices[0]?.finish_reason ?? null,
      extension: chunks[0]?.["agent-harness"] ?? { seq: 0 },
      usage: chunks.at(-1)?.usage,
      chunks,
    };
  };

  /** A program's follow-up: the conversation so far with the assistant's calls, then a tool message for each with what `results` says of its tool. */
  const followUp = (asked: string, answer: Answer, results: Readonly<Record<string, string>>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    model: "claude-max/opus",
    messages: [
      { role: "user", content: asked },
      { role: "assistant", content: answer.content, tool_calls: answer.toolCalls },
      ...answer.toolCalls.map((call) => ({ role: "tool", tool_call_id: call.id, content: results[call.function.name] ?? "" })),
    ],
    tools: [WEATHER],
    ...extra,
  });

  /** Says it will look, calls get_weather for Manila, then says what the tool answered and completes. */
  const weatherScript: Script = async function* (controls) {
    yield say("Let me look.");
    const result = yield* callClientTool(controls, { name: "get_weather", input: { city: "Manila" } });
    yield say(toolResultText(result));
    yield usage(30, 6);
    yield end();
  };

  const CALL_ID = /^call_[0-9a-f]{32}$/;

  it("serves the request's tools to its run as a tool server named client, one tool per function with its schema", async () => {
    const t = await start();
    const { token } = await program(t);
    for (const streaming of [true, false]) {
      const answer = await exchange(
        t,
        token,
        turn("Hi", { tools: [WEATHER, { type: "function", function: { name: "ping" } }, { type: "function", function: { name: "echo", parameters: { properties: { text: { type: "string" } } } } }] }),
        streaming,
      );
      expect(answer.finishReason).toBe("stop");
      expect(answer.extension.ignored).toEqual([]);
      // The harness's own browser server is on every run (#546); the caller's tools come after it as the client server.
      const servers = t.adapter.lastRun().input.toolServers;
      expect(servers.map((server) => server.name)).toEqual(["browser", "client"]);
      const server = servers.find((candidate) => candidate.name === "client");
      if (server === undefined || !isInProcess(server)) throw new Error("The client server is not served in process.");
      expect(server.external).toBe(true);
      expect(server.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))).toEqual([
        { name: "get_weather", description: "The weather in a city.", inputSchema: WEATHER.function.parameters },
        // No parameters: an object with none; a schema that leaves its type out is an object's.
        { name: "ping", description: "", inputSchema: { type: "object", properties: {} } },
        { name: "echo", description: "", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
      ]);
    }
    // A request with no tools gives its run none of the caller's: the harness's own browser server alone.
    await complete(t, token, turn("Hi"));
    expect(t.adapter.lastRun().input.toolServers.map((server) => server.name)).toEqual(["browser"]);
  });

  it("returns a call to the caller's tool as a tool_calls delta with a minted id and the bare name, ends with finish_reason tool_calls, and parks the handler", async () => {
    const t = await start({ script: weatherScript });
    const { token } = await program(t);
    for (const streaming of [true, false]) {
      const answer = await exchange(t, token, turn("Weather in Manila?", { tools: [WEATHER], stream_options: { include_usage: true } }), streaming);
      expect(answer.content).toBe("Let me look.");
      expect(answer.toolCalls).toEqual([{ id: expect.stringMatching(CALL_ID), type: "function", function: { name: "get_weather", arguments: '{"city":"Manila"}' } }]);
      expect(answer.finishReason).toBe("tool_calls");
      // The run waits on the call: its spend is not known yet.
      expect(answer.usage).toBeUndefined();
      const sessionId = answer.extension.sessionId as string;
      expect(ofType(t, sessionId, "run.ended")).toHaveLength(0);
      if (streaming) {
        // OpenAI's order: the role, the text, the call, then the finish on an empty delta; the sequences never go back.
        expect(answer.chunks.map((chunk) => Object.keys(chunk.choices[0]?.delta ?? {}).join(","))).toEqual(["role,content", "content", "tool_calls", ""]);
        const seqs = answer.chunks.map((chunk) => chunk["agent-harness"].seq);
        expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
        expect(answer.chunks.every((chunk) => chunk.choices[0]?.delta.tool_calls === undefined || chunk["agent-harness"].seq > 0)).toBe(true);
      }
    }
  });

  it("resumes the parked turn with a follow-up's tool messages matched by tool_call_id, with no session id, the same turn streaming on in that response", async () => {
    const t = await start({ script: weatherScript });
    const { token } = await program(t);
    for (const [first, second] of [
      [true, true],
      [false, false],
      [true, false],
      [false, true],
    ] as const) {
      const asked = await exchange(t, token, turn("Weather in Manila?", { tools: [WEATHER] }), first);
      const sessionId = asked.extension.sessionId as string;
      const runs = t.adapter.runs.length;
      const resumed = await exchange(t, token, followUp("Weather in Manila?", asked, { get_weather: "Sunny, 31C" }, { stream_options: { include_usage: true } }), second);
      expect(resumed.content).toBe("Tool said: Sunny, 31C");
      expect(resumed.finishReason).toBe("stop");
      // The same session and run: no session was made and no run started for the follow-up.
      expect(resumed.extension).toMatchObject({ sessionId, runId: asked.extension.runId, ignored: [] });
      expect(resumed.extension.messageId).toBeUndefined();
      expect(t.adapter.runs).toHaveLength(runs);
      expect(resumed.usage).toEqual({ prompt_tokens: 36, completion_tokens: 6, total_tokens: 42, prompt_tokens_details: { cached_tokens: 5 } });
      await untilEnded(t, sessionId);
      // The transcript records the call and what the caller answered.
      expect(payloadsOf<{ name: string }>(t, sessionId, "tool.started").map((payload) => payload.name)).toEqual(["mcp__client__get_weather"]);
      expect(payloadsOf<{ status: string; output: unknown }>(t, sessionId, "tool.ended")).toMatchObject([{ status: "ok", output: "Sunny, 31C" }]);
      if (second) expect(resumed.chunks[0]?.["agent-harness"].seq).toBeGreaterThanOrEqual(asked.extension.seq);
    }
  });

  it("returns several calls of one turn in one answer, each matched by its own id, and calls made one after another in answers of their own", async () => {
    const t = await start();
    const { token } = await program(t);
    for (const streaming of [true, false]) {
      // Side by side: both come back in one answer, and the results may come in any order.
      t.adapter.nextScripts.push(async function* (controls) {
        const [weather, time] = yield* callClientTools(controls, [
          { name: "get_weather", input: { city: "Manila" } },
          { name: "get_time", input: { city: "Manila" } },
        ]);
        yield say(`${toolResultText(weather as HostToolResult)} / ${toolResultText(time as HostToolResult)}`);
        yield end();
      });
      const both = await exchange(t, token, turn("Weather and time in Manila?", { tools: [WEATHER, TIME] }), streaming);
      expect(both.toolCalls.map((call) => call.function.name)).toEqual(["get_weather", "get_time"]);
      expect(new Set(both.toolCalls.map((call) => call.id)).size).toBe(2);
      expect(both.finishReason).toBe("tool_calls");
      const reversed = followUp("Weather and time in Manila?", both, { get_weather: "Sunny", get_time: "14:05" }, { tools: [WEATHER, TIME] });
      reversed["messages"] = [...(reversed["messages"] as unknown[]).slice(0, 2), ...(reversed["messages"] as unknown[]).slice(2).reverse()];
      expect((await exchange(t, token, reversed, streaming)).content).toBe("Tool said: Sunny / Tool said: 14:05");

      // One after another: the second call is made only once the first is answered, and comes back in the follow-up's answer.
      t.adapter.nextScripts.push(async function* (controls) {
        const weather = yield* callClientTool(controls, { name: "get_weather", input: { city: "Manila" } });
        const time = yield* callClientTool(controls, { name: "get_time", input: { city: "Manila" } });
        yield say(`${toolResultText(weather)} / ${toolResultText(time)}`);
        yield end();
      });
      const first = await exchange(t, token, turn("Weather, then time?", { tools: [WEATHER, TIME] }), streaming);
      expect(first.toolCalls.map((call) => call.function.name)).toEqual(["get_weather"]);
      const second = await exchange(t, token, followUp("Weather, then time?", first, { get_weather: "Rain" }, { tools: [WEATHER, TIME] }), streaming);
      expect(second.toolCalls.map((call) => call.function.name)).toEqual(["get_time"]);
      expect(second.finishReason).toBe("tool_calls");
      expect(second.toolCalls[0]?.id).not.toBe(first.toolCalls[0]?.id);
      const third = await exchange(t, token, followUp("Weather, then time?", second, { get_time: "09:00" }, { tools: [WEATHER, TIME] }), streaming);
      expect(third).toMatchObject({ content: "Tool said: Rain / Tool said: 09:00", finishReason: "stop" });
    }
  });

  it("expires a handler not answered within ten minutes: the model gets an error result, the run goes on, and a late follow-up is 404", async () => {
    const t = await start({ script: weatherScript });
    const { token } = await program(t);
    for (const streaming of [true, false]) {
      const asked = await exchange(t, token, turn("Weather in Manila?", { tools: [WEATHER] }), streaming);
      const sessionId = asked.extension.sessionId as string;
      t.clock.advance(CLIENT_TOOL_CALL_EXPIRY_MS - 1);
      await new Promise((resolve) => setImmediate(resolve));
      expect(ofType(t, sessionId, "run.ended")).toHaveLength(0);
      t.clock.advance(1);
      await untilEnded(t, sessionId);
      expect(payloadsOf<{ status: string; output: unknown }>(t, sessionId, "tool.ended")).toMatchObject([{ status: "error", output: EXPIRED_RESULT }]);
      expect(payloadsOf<{ reason: string }>(t, sessionId, "run.ended")[0]?.reason).toBe("completed");
      expect(payloadsOf<{ text: string }>(t, sessionId, "assistant.text").map((payload) => payload.text)).toContain(`Tool said (error): ${EXPIRED_RESULT}`);
      expect(await refusalOf(await post(t, token, followUp("Weather in Manila?", asked, { get_weather: "Sunny" }, { stream: streaming })))).toMatchObject({
        status: 404,
        body: { error: { type: "not_found_error", code: "tool_call_not_found", param: "messages.2.tool_call_id" } },
      });
    }
  });

  it("lets a parked call go when its run ends, so a follow-up for it is 404", async () => {
    const t = await start({ script: weatherScript });
    const { token } = await program(t);
    const client = await t.client();
    for (const streaming of [true, false]) {
      const asked = await exchange(t, token, turn("Weather in Manila?", { tools: [WEATHER] }), streaming);
      await client.request("runs.interrupt", { commandId: randomUUID(), runId: asked.extension.runId as string });
      await untilEnded(t, asked.extension.sessionId as string);
      expect(await refusalOf(await post(t, token, followUp("Weather in Manila?", asked, { get_weather: "Sunny" }, { stream: streaming })))).toMatchObject({
        status: 404,
        body: { error: { code: "tool_call_not_found", param: "messages.2.tool_call_id" } },
      });
    }
  });

  it("withholds the tools from the run under tool_choice none", async () => {
    const t = await start();
    const { token } = await program(t);
    for (const streaming of [true, false]) {
      const answer = await exchange(t, token, turn("Hi", { tools: [WEATHER], tool_choice: "none" }), streaming);
      expect(answer.finishReason).toBe("stop");
      expect(answer.extension.ignored).toEqual([]);
      // The caller's tools are withheld; the harness's own browser server is on every run (#546).
      expect(t.adapter.lastRun().input.toolServers.map((server) => server.name)).toEqual(["browser"]);
      // auto is the default, said out loud.
      await exchange(t, token, turn("Hi", { tools: [WEATHER], tool_choice: "auto" }), streaming);
      expect(t.adapter.lastRun().input.toolServers.map((server) => server.name)).toEqual(["browser", "client"]);
    }
  });

  it("refuses tool_choice required and a named choice 400, and ignores and reports them under ignoreUnsupported, serving the tools", async () => {
    const t = await start();
    const { token } = await program(t);
    for (const streaming of [true, false]) {
      for (const choice of ["required", { type: "function", function: { name: "get_weather" } }]) {
        expect(await refusalOf(await post(t, token, turn("Hi", { tools: [WEATHER], tool_choice: choice, stream: streaming })))).toMatchObject({
          status: 400,
          body: { error: { type: "invalid_request_error", code: "unsupported_parameter", param: "tool_choice" } },
        });
        const tolerated = await exchange(t, token, turn("Hi", { tools: [WEATHER], tool_choice: choice, "agent-harness": { ignoreUnsupported: true } }), streaming);
        expect(tolerated.extension.ignored).toEqual(["tool_choice"]);
        expect(t.adapter.lastRun().input.toolServers.map((server) => server.name)).toEqual(["browser", "client"]);
      }
    }
    expect(t.adapter.runs).toHaveLength(4);
  });

  it("shows the agent's own tools only as activity on empty-delta chunks, never as tool_calls, and a call to the caller's tools only as tool_calls", async () => {
    const t = await start({
      script: async function* (controls) {
        yield toolStarted("toolu_1");
        yield toolEnded("toolu_1");
        const result = yield* callClientTool(controls, { name: "get_weather", input: { city: "Manila" }, toolCallId: "toolu_client" });
        yield toolStarted("toolu_2");
        yield toolEnded("toolu_2");
        yield say(toolResultText(result));
        yield end();
      },
    });
    const { token } = await program(t);
    for (const streaming of [true, false]) {
      const asked = await exchange(t, token, turn("Weather in Manila?", { tools: [WEATHER] }), streaming);
      expect(asked.toolCalls.map((call) => call.function.name)).toEqual(["get_weather"]);
      const resumed = await exchange(t, token, followUp("Weather in Manila?", asked, { get_weather: "Sunny" }), streaming);
      expect(resumed.content).toBe("Tool said: Sunny");
      if (!streaming) continue;
      const activity = [...asked.chunks, ...resumed.chunks].flatMap((chunk) => {
        const value = chunk["agent-harness"].activity;
        if (value === undefined) return [];
        expect(chunk.choices[0]?.delta).toEqual({});
        return [`${value.type} ${"toolCallId" in value ? value.toolCallId : ""}`];
      });
      expect(activity).toEqual(["tool.started toolu_1", "tool.ended toolu_1", "tool.started toolu_2", "tool.ended toolu_2"]);
    }
  });

  it("refuses tools it cannot serve: another type 400 or ignored, a bad or repeated name, parameters that are not an object's", async () => {
    const t = await start();
    const { token } = await program(t);
    for (const streaming of [true, false]) {
      const refused = async (body: Record<string, unknown>) => (await refusalOf(await post(t, token, { ...body, stream: streaming }))).body.error;
      expect(await refused(turn("Hi", { tools: [{ type: "custom", custom: { name: "grammar" } }, WEATHER] }))).toMatchObject({ code: "unsupported_parameter", param: "tools.0" });
      const tolerated = await exchange(t, token, turn("Hi", { tools: [{ type: "custom", custom: { name: "grammar" } }, WEATHER], "agent-harness": { ignoreUnsupported: true } }), streaming);
      expect(tolerated.extension.ignored).toEqual(["tools.0"]);
      const server = t.adapter.lastRun().input.toolServers.find((candidate) => candidate.name === "client");
      expect(server !== undefined && isInProcess(server) ? server.tools.map((tool) => tool.name) : []).toEqual(["get_weather"]);
      expect(await refused(turn("Hi", { tools: [{ type: "function", function: { name: "get weather" } }] }))).toMatchObject({ code: "invalid_params", param: "tools.0.function.name" });
      expect(await refused(turn("Hi", { tools: [WEATHER, WEATHER] }))).toMatchObject({ code: "invalid_params", param: "tools.1.function.name" });
      expect(await refused(turn("Hi", { tools: [{ type: "function", function: { name: "ping", parameters: { type: "string" } } }] }))).toMatchObject({
        code: "invalid_params",
        param: "tools.0.function.parameters",
      });
      expect(await refused(turn("Hi", { tools: [{ type: "function" }] }))).toMatchObject({ code: "invalid_params", param: "tools.0.function" });
      // strict is not honoured, and a choice among no tools says nothing: both reported.
      const strict = await exchange(t, token, turn("Hi", { tools: [{ ...WEATHER, function: { ...WEATHER.function, strict: true } }] }), streaming);
      expect(strict.extension.ignored).toEqual(["tools.0.function.strict"]);
      expect((await exchange(t, token, turn("Hi", { tool_choice: "auto" }), streaming)).extension.ignored).toEqual(["tool_choice"]);
    }
    expect(t.adapter.runs).toHaveLength(6);
  });

  it("refuses tool results no parked call waits for 404, results for another session's calls 400, and reports a stray result and what the running turn cannot take", async () => {
    const t = await start({ script: weatherScript });
    const { token } = await program(t);
    const unknown = { model: "claude-max/opus", messages: [{ role: "user", content: "Hi" }, { role: "tool", tool_call_id: "call_nobody", content: "42" }] };
    expect(await refusalOf(await post(t, token, unknown))).toMatchObject({ status: 404, body: { error: { code: "tool_call_not_found", param: "messages.1.tool_call_id" } } });
    const nameless = { model: "claude-max/opus", messages: [{ role: "user", content: "Hi" }, { role: "tool", content: "42" }] };
    expect(await refusalOf(await post(t, token, nameless))).toMatchObject({ status: 400, body: { error: { code: "invalid_params", param: "messages.1.tool_call_id" } } });
    for (const streaming of [true, false]) {
      const asked = await exchange(t, token, turn("Weather in Manila?", { tools: [WEATHER] }), streaming);
      t.adapter.nextScripts.push(() => [say("Elsewhere"), end()]);
      const other = await complete(t, token, turn("Elsewhere"));
      const elsewhere = followUp("Weather in Manila?", asked, { get_weather: "Sunny" }, { "agent-harness": { sessionId: other["agent-harness"].sessionId } });
      expect(await refusalOf(await post(t, token, elsewhere))).toMatchObject({ status: 400, body: { error: { code: "invalid_params", param: "agent-harness.sessionId" } } });
      const forked = followUp("Weather in Manila?", asked, { get_weather: "Sunny" }, { "agent-harness": { forkSession: true, sessionId: asked.extension.sessionId } });
      expect(await refusalOf(await post(t, token, forked))).toMatchObject({ status: 400, body: { error: { code: "invalid_params", param: "agent-harness.forkSession" } } });
      // A stray result beside the call's, and the fields a running turn cannot take, are ignored and said so; the answer names the run's model.
      const request = followUp("Weather in Manila?", asked, { get_weather: "Sunny" }, {
        model: "claude-max/sonnet",
        tools: [TIME],
        tool_choice: "none",
        "agent-harness": { sessionId: asked.extension.sessionId, permissionMode: "plan", systemPrompt: "Be terse." },
      });
      request["messages"] = [...(request["messages"] as unknown[]), { role: "tool", tool_call_id: "call_stray", content: "?" }];
      const resumed = await exchange(t, token, request, streaming);
      expect(resumed.content).toBe("Tool said: Sunny");
      expect(resumed.extension.ignored).toEqual(["model", "agent-harness.permissionMode", "agent-harness.systemPrompt", "tools", "tool_choice", "messages.3"]);
      const [chunk] = resumed.chunks;
      if (chunk !== undefined) expect(chunk.model).toBe("claude-max/opus");
    }
  });

  it("takes tool results while the environment drains, so the running turn can finish", async () => {
    const t = await start({ script: weatherScript });
    const { token } = await program(t);
    const streamed = await exchange(t, token, turn("Weather in Manila?", { tools: [WEATHER] }), true);
    const whole = await exchange(t, token, turn("Weather in Manila?", { tools: [WEATHER] }), false);
    void t.env.drain("command");
    await vi.waitFor(() => expect(t.env.readiness()).toBe("draining"));
    expect(await refusalOf(await post(t, token, turn("One more", { tools: [WEATHER] })))).toMatchObject({ status: 503, body: { error: { code: "unavailable" } } });
    for (const [asked, streaming] of [
      [streamed, true],
      [whole, false],
    ] as const) {
      expect(await exchange(t, token, followUp("Weather in Manila?", asked, { get_weather: "Sunny" }), streaming)).toMatchObject({ content: "Tool said: Sunny", finishReason: "stop" });
    }
  });

  it("carries a completions run's client tools to the run started from its queue, whose answer returns its calls", async () => {
    const t = await start({ capabilities: { providerQueue: false, steering: false } });
    const { token } = await program(t);
    for (const streaming of [true, false]) {
      const held = gate();
      t.adapter.nextScripts.push(heldScript(held.opened, "First done"));
      t.adapter.nextScripts.push(weatherScript);
      const first = await stream(t, token, turn("First", { tools: [WEATHER] }));
      const sessionId = (await first.chunk())["agent-harness"].sessionId as string;
      // Queued with the same tools: nothing ignored; the run of the queue is served them and its call comes back in this answer.
      const queued = exchange(t, token, turn("Weather in Manila?", { tools: [WEATHER], "agent-harness": { sessionId } }), streaming);
      await untilLogged(t, sessionId, "message.sent", 2);
      held.open();
      await first.rest();
      const answer = await queued;
      expect(answer.extension).toMatchObject({ delivery: "queued", ignored: [] });
      expect(answer.content).toBe("First done\n\nLet me look.");
      expect(answer.toolCalls.map((call) => call.function.name)).toEqual(["get_weather"]);
      expect(answer.finishReason).toBe("tool_calls");
      expect(t.adapter.runs.slice(-2).map((run) => run.input.toolServers.map((server) => server.name))).toEqual([
        ["browser", "client"],
        ["browser", "client"],
      ]);
      // The call is the queue's run's, and a follow-up resumes that run.
      const resumed = await exchange(t, token, followUp("Weather in Manila?", answer, { get_weather: "Sunny" }), streaming);
      expect(resumed).toMatchObject({ content: "Tool said: Sunny", finishReason: "stop" });
      expect(resumed.extension.runId).toBe(t.adapter.lastRun().input.runId);
    }
    // A queued turn whose tools differ from the live run's is told they were not taken.
    t.adapter.nextScripts.push(heldScript(gate().opened));
    const other = await stream(t, token, turn("Again", { tools: [WEATHER] }));
    const otherSession = (await other.chunk())["agent-harness"].sessionId as string;
    const differing = await stream(t, token, turn("Then this", { tools: [TIME], "agent-harness": { sessionId: otherSession } }));
    expect((await differing.chunk())["agent-harness"].ignored).toEqual(["tools"]);
  });
});
