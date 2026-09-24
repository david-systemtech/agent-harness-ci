import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { manualClock, type ManualClock } from "../../../test/clock.js";
import { FakeSdk, sdk, type FakeQuery } from "../../../test/fake-claude-sdk.js";
import type { AdapterEvent, AdapterRun, PermissionBroker, PromptDecision, PromptRequest, ProviderTurn, RunContext, RunInput } from "../../adapter/contract.js";

/**
 * The Claude adapter with the SDK transport scripted (claude-adapter spec,
 * "Testing Decisions", the adapter seam): the SDK module is replaced through
 * `vi.hoisted` and `vi.mock` as Artemis's `claude.test.ts` and host test do,
 * so nothing is spawned and no credential is used, and every path under test
 * is the real adapter: the options `query()` received, the prompt pump, the
 * permission table on the broker seam, the process kept across turns, the
 * turn the provider opens on its own, the interrupt, and the reads on
 * unsampled queries. Artemis's cases, ported with the vocabulary renamed.
 */

const hooks = vi.hoisted(() => ({ sdk: undefined as undefined | { query: (params: never) => unknown; getSessionMessages: (id: string, options: unknown) => unknown } }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: never) => {
    if (hooks.sdk === undefined) throw new Error("The test installed no fake SDK.");
    return hooks.sdk.query(params);
  },
  getSessionMessages: (id: string, options: unknown) => {
    if (hooks.sdk === undefined) throw new Error("The test installed no fake SDK.");
    return hooks.sdk.getSessionMessages(id, options);
  },
}));

const { createClaudeAdapter, CLAUDE_DESCRIPTOR } = await import("./index.js");
const { createConfigDirQueue } = await import("./config-dir-queue.js");

const SESSION = "6f1d2a4e-8c3b-4f5a-9d7e-1a2b3c4d5e6f";
const PROVIDER_SESSION = "5d1e9c3a-7b2f-4e8d-9a6c-3f0b1e2d4c5a";

let fake: FakeSdk;
let clock: ManualClock;
let diagnostics: string[];

beforeEach(() => {
  fake = new FakeSdk();
  hooks.sdk = fake;
  clock = manualClock();
  diagnostics = [];
});

afterEach(() => {
  hooks.sdk = undefined;
});

const adapterWith = (options: Parameters<typeof createClaudeAdapter>[0] = {}) =>
  createClaudeAdapter({
    clock,
    executablePath: "/sdk/claude-agent-sdk-linux-x64/claude",
    hostEnv: { PATH: "/usr/bin", HOME: "/home/david", ANTHROPIC_API_KEY: "sk-ant-shell", CLAUDE_CODE_OAUTH_TOKEN: "oauth", IS_SANDBOX: "1", CLAUDE_CODE_BUBBLEWRAP: "1", CLAUDE_CODE_SIMPLE: "1" },
    diagnostic: (message) => diagnostics.push(message),
    configDirQueue: createConfigDirQueue(process.env),
    ...options,
  });

const message = (text: string, messageId: string = randomUUID()) => ({ messageId, text, attachments: [] });

const runInput = (overrides: Partial<RunInput> = {}): RunInput => ({
  sessionId: SESSION,
  runId: randomUUID(),
  account: { id: "work", directory: "/data/accounts/work" },
  workspace: { kind: "directory", path: "/work/repo" },
  repositoryIdentity: null,
  model: "opus",
  effort: null,
  mode: "acceptEdits",
  instructions: "",
  target: { kind: "fresh" },
  toolServers: [],
  trusted: false,
  prompt: [message("Go")],
  ...overrides,
});

interface Context extends RunContext {
  readonly adopted: ProviderTurn[];
  readonly asked: PromptRequest[];
}

/** A context whose broker answers what `decide` says, when it says (never, by default: the prompt parks). */
const contextWith = (decide?: (request: PromptRequest) => Promise<PromptDecision>): Context => {
  const adopted: ProviderTurn[] = [];
  const asked: PromptRequest[] = [];
  const broker: PermissionBroker = {
    request: (request) => {
      asked.push(request);
      return decide?.(request) ?? new Promise<PromptDecision>(() => undefined);
    },
  };
  return { broker, adopt: (turn) => adopted.push(turn), adopted, asked };
};

/** Reads a run's events to its end. */
const drain = async (run: AdapterRun): Promise<AdapterEvent[]> => {
  const events: AdapterEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
};

/** Starts reading a run's events; `events` fills as they come, `done` resolves at the end. */
const reading = (run: AdapterRun) => {
  const events: AdapterEvent[] = [];
  const done = (async () => {
    for await (const event of run.events) events.push(event);
    return events;
  })();
  return { events, done };
};

const ends = (events: AdapterEvent[]) => events.filter((event) => event.type === "end");

/** Lets the pump read what a test emitted. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

/** The query of the run the adapter just started, once its prompt is in. */
const started = async (index = 1): Promise<FakeQuery> => {
  const query = await fake.made(index);
  await query.promptsPushed(1);
  return query;
};

describe("a run", () => {
  it("streams the mapped events and ends once, on the result", async () => {
    const adapter = adapterWith();
    const input = runInput();
    const run = adapter.createRun(input, contextWith());
    const query = await started();
    const promptId = input.prompt[0]?.messageId as string;
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [promptId]), sdk.blockStart(0), sdk.textDelta(0, "Hel"), sdk.textDelta(0, "lo."), sdk.text("msg_1", "Hello."), sdk.result(PROVIDER_SESSION));
    const events = await drain(run);
    expect(events.map((event) => event.type)).toEqual(["session.provider-linked", "assistant.delta", "assistant.text", "end"]);
    expect(events[1]).toEqual({ type: "assistant.delta", payload: { itemId: "msg_1:0", fragments: [{ kind: "text", text: "Hello." }] } });
    expect(ends(events)).toEqual([{ type: "end", reason: "completed", cause: null, error: null, usage: null, turnCount: 1, resultText: "Done." }]);
  });

  it("buffers what the provider says before anyone reads, and is read once", async () => {
    const adapter = adapterWith();
    const run = adapter.createRun(runInput(), contextWith());
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.text("msg_1", "Hi."), sdk.result(PROVIDER_SESSION));
    await vi.waitFor(() => expect(query.prompts).toHaveLength(1));
    expect((await drain(run)).map((event) => event.type)).toEqual(["session.provider-linked", "assistant.text", "end"]);
    expect(() => run.events[Symbol.asyncIterator]()).toThrow(/read once/);
  });

  it("ends error, rather than rejecting its stream, when the transport fails", async () => {
    const adapter = adapterWith();
    const run = adapter.createRun(runInput(), contextWith());
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION));
    query.fail(new Error("the CLI exited with code 1"));
    const events = await drain(run);
    expect(ends(events)).toEqual([expect.objectContaining({ reason: "error", error: { message: "the CLI exited with code 1", code: "transport" } })]);
  });

  it("ends error when the transport closes before the turn's result", async () => {
    const adapter = adapterWith();
    const run = adapter.createRun(runInput(), contextWith());
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION));
    query.end();
    expect(ends(await drain(run))).toEqual([expect.objectContaining({ reason: "error", error: expect.objectContaining({ code: "transport" }) })]);
  });

  it("ends error when query() itself cannot start", async () => {
    hooks.sdk = {
      query: () => {
        throw new Error("Claude Code native binary not found");
      },
      getSessionMessages: async () => [],
    };
    const run = adapterWith().createRun(runInput(), contextWith());
    expect(ends(await drain(run))).toEqual([expect.objectContaining({ reason: "error", error: { message: "Claude Code native binary not found", code: "launch" } })]);
  });

  it("is refused before anything spawns for a mode Claude does not offer, or an unknown effort", () => {
    const adapter = adapterWith();
    expect(() => adapter.createRun(runInput({ mode: "default" }), contextWith())).toThrow(/mode default/);
    expect(() => adapter.createRun(runInput({ mode: "dontAsk" }), contextWith())).toThrow(/mode dontAsk/);
    expect(() => adapter.createRun(runInput({ effort: "ludicrous" }), contextWith())).toThrow(/effort/);
    expect(fake.queries).toHaveLength(0);
  });

  it("runs with the stripped variables absent and the account's directory present", async () => {
    const adapter = adapterWith();
    adapter.createRun(runInput(), contextWith());
    const query = await started();
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "IS_SANDBOX", "CLAUDE_CODE_BUBBLEWRAP", "CLAUDE_CODE_SIMPLE"]) {
      expect(query.env, name).not.toHaveProperty(name);
    }
    expect(query.env["CLAUDE_CONFIG_DIR"]).toBe("/data/accounts/work");
    expect(query.env["CLAUDE_CODE_PROJECT_DIR_NAME"]).toBe(SESSION);
    expect(query.env["PATH"]).toBe("/usr/bin");
  });

  it("hands query() the options table: store, trust, instructions, bundled binary, broker", async () => {
    const store = { append: async () => undefined, load: async () => null };
    const adapter = adapterWith({ sessionStore: store, pluginDirectory: () => "/data/skills/work", autoMemoryRoot: "/data/auto-memory" });
    adapter.createRun(runInput({ trusted: true, instructions: "Be brief.", repositoryIdentity: "git.example/david/repo", target: { kind: "resume", providerSessionId: PROVIDER_SESSION } }), contextWith());
    const options: Options = (await started()).options;
    expect(options).toMatchObject({
      cwd: "/work/repo",
      model: "opus",
      permissionMode: "acceptEdits",
      permissionPrompts: "host",
      settingSources: ["project"],
      strictMcpConfig: true,
      includePartialMessages: true,
      systemPrompt: { type: "preset", preset: "claude_code", append: "Be brief." },
      plugins: [{ type: "local", path: "/data/skills/work" }],
      settings: { autoMemoryDirectory: expect.stringMatching(/^\/data\/auto-memory\/git-example-david-repo-[0-9a-f]{12}$/) },
      sessionStore: store,
      resume: PROVIDER_SESSION,
      pathToClaudeCodeExecutable: "/sdk/claude-agent-sdk-linux-x64/claude",
    });
    expect(typeof options.canUseTool).toBe("function");
  });
});

describe("the streaming input", () => {
  it("seeds the prompt pump with the run's messages, stamped with their ids, images ahead of the text", async () => {
    const adapter = adapterWith();
    const first = message("Look at this");
    const withImage = { ...first, attachments: [{ kind: "image" as const, name: "a.png", mediaType: "image/png", data: new Uint8Array([1, 2, 3]) }] };
    const queued = message("And this");
    adapter.createRun(runInput({ prompt: [withImage, queued] }), contextWith());
    const query = await fake.made(1);
    const prompts: SDKUserMessage[] = await query.promptsPushed(2);
    expect(prompts.map((prompt) => prompt.uuid)).toEqual([first.messageId, queued.messageId]);
    expect(prompts[0]?.message.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
      { type: "text", text: "Look at this" },
    ]);
    expect(prompts[1]?.message.content).toBe("And this");
  });

  it("pushes a message sent during the turn, and reports it steered when the turn reads it", async () => {
    const adapter = adapterWith();
    const input = runInput();
    const run = adapter.createRun(input, contextWith());
    const query = await started();
    const promptId = input.prompt[0]?.messageId as string;
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [promptId]));
    const steer = message("Also check the tests");
    await run.send(steer);
    expect((await query.promptsPushed(2))[1]).toMatchObject({ uuid: steer.messageId, message: { content: "Also check the tests" } });
    query.emit(sdk.text("msg_2", "Checking the tests too.", [promptId, steer.messageId]), sdk.result(PROVIDER_SESSION));
    const events = await drain(run);
    expect(events.filter((event) => event.type === "message.delivered")).toEqual([{ type: "message.delivered", payload: { messageId: steer.messageId, delivery: "steered" } }]);
    expect(events.map((event) => event.type).indexOf("message.delivered")).toBeLessThan(events.map((event) => event.type).indexOf("assistant.text"));
  });

  it("refuses a send into a run that has ended", async () => {
    const adapter = adapterWith();
    const run = adapter.createRun(runInput(), contextWith());
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.result(PROVIDER_SESSION));
    await drain(run);
    await expect(Promise.resolve().then(() => run.send(message("late")))).rejects.toThrow(/ended/);
  });
});

describe("canUseTool on the broker seam", () => {
  it("hands the request to the broker with its run and kind, and parks the tool until it is answered", async () => {
    const adapter = adapterWith();
    const context = contextWith();
    const input = runInput();
    const run = adapter.createRun(input, context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]));
    await vi.waitFor(() => expect(query.prompts).toHaveLength(1));
    const asked = query.canUseTool("Bash", { command: "rm -rf build" }, { toolUseID: "toolu_rm", title: "Claude wants to run rm -rf build" });
    await vi.waitFor(() => expect(context.asked).toHaveLength(1));
    expect(context.asked[0]).toEqual({
      sessionId: SESSION,
      runId: input.runId,
      kind: "permission",
      detail: expect.objectContaining({ promptId: "toolu_rm", toolName: "Bash", input: { command: "rm -rf build" }, title: "Claude wants to run rm -rf build" }),
    });
    let settled = false;
    void asked.then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);
    run.answerPrompt?.("toolu_rm", { decision: "allow" });
    expect(await asked).toEqual({ behavior: "allow", updatedInput: { command: "rm -rf build" }, toolUseID: "toolu_rm" });
  });

  it("forwards the broker's denial with its message", async () => {
    const adapter = adapterWith();
    const context = contextWith(async () => ({ decision: "deny", message: "Nobody can ask here." }));
    adapter.createRun(runInput(), context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [query.prompts[0]?.uuid as string]));
    await flush();
    expect(await query.canUseTool("Write", { file_path: "/etc/hosts" }, { toolUseID: "toolu_w" })).toEqual({
      behavior: "deny",
      message: "Nobody can ask here.",
      toolUseID: "toolu_w",
    });
  });

  it("asks a question and a plan as prompts of their own kind", async () => {
    const adapter = adapterWith();
    const context = contextWith(async () => ({ decision: "allow" }));
    adapter.createRun(runInput(), context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [query.prompts[0]?.uuid as string]));
    await flush();
    await query.canUseTool("AskUserQuestion", { questions: [] });
    await query.canUseTool("ExitPlanMode", { plan: "Do it" });
    expect(context.asked.map((request) => request.kind)).toEqual(["question", "plan"]);
  });

  it("denies, never hangs, when the run is torn down mid-prompt", async () => {
    const adapter = adapterWith();
    const run = adapter.createRun(runInput(), contextWith());
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [query.prompts[0]?.uuid as string]));
    await vi.waitFor(() => expect(query.prompts).toHaveLength(1));
    const asked = query.canUseTool("Bash", { command: "ls" }, { toolUseID: "toolu_ls" });
    await new Promise((resolve) => setTimeout(resolve, 1));
    await run.dispose();
    expect(await asked).toMatchObject({ behavior: "deny", message: expect.stringMatching(/stopped/) });
    expect(query.closed).toBe(true);
  });

  it("denies at once when the provider aborts the request", async () => {
    const adapter = adapterWith();
    adapter.createRun(runInput(), contextWith());
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [query.prompts[0]?.uuid as string]));
    await flush();
    const abort = new AbortController();
    const asked = query.canUseTool("Bash", { command: "ls" }, { toolUseID: "toolu_ls", signal: abort.signal });
    await new Promise((resolve) => setTimeout(resolve, 1));
    abort.abort();
    expect(await asked).toMatchObject({ behavior: "deny", message: "The provider aborted this tool call." });
  });
});

describe("an interrupt", () => {
  it("interrupts the turn, which ends interrupted though the provider calls it an error", async () => {
    const adapter = adapterWith();
    const run = adapter.createRun(runInput(), contextWith());
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [query.prompts[0]?.uuid as string]));
    const read = reading(run);
    await vi.waitFor(() => expect(read.events).toHaveLength(1));
    expect(await run.interrupt()).toEqual({ stillQueued: [] });
    expect(query.interrupts).toBe(1);
    query.emit(sdk.interruptedResult(PROVIDER_SESSION));
    expect(ends(await read.done)).toEqual([{ type: "end", reason: "interrupted", cause: "user", error: null, usage: null, turnCount: 1, resultText: null }]);
  });

  it("cancels the queue in the interrupt itself, and hands back the messages it sent that the receipt names cancelled", async () => {
    const steer = message("Wait, do this instead");
    const other = message("And this");
    fake.controls = {
      // As the CLI does: with cancelQueued it withdraws everything it held in the same request; without it, they survive and run next.
      interruptReceipt: async (options) =>
        options?.cancelQueued === true ? { still_queued: [], cancelled: [steer.messageId, other.messageId, "cron-trigger-uuid"] } : { still_queued: [steer.messageId, other.messageId] },
      cancelled: () => false,
    };
    const adapter = adapterWith();
    const run = adapter.createRun(runInput(), contextWith());
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [query.prompts[0]?.uuid as string]));
    await flush();
    await run.send(steer);
    await run.send(other);
    expect(await run.interrupt()).toEqual({ stillQueued: [steer.messageId, other.messageId] });
    expect(query.interruptOptions).toEqual([{ cancelQueued: true }]);
    expect(query.cancelRequests).toEqual([]);
  });

  it("falls back to withdrawing one by one on an SDK whose interrupt takes no options, handing back only what it withdrew", async () => {
    const steer = message("Wait, do this instead");
    const stuck = message("And this");
    fake.controls = {
      plainInterrupt: true,
      interruptReceipt: async () => ({ still_queued: [steer.messageId, stuck.messageId, "cron-trigger-uuid"] }),
      cancelled: (uuid) => uuid === steer.messageId,
    };
    const adapter = adapterWith();
    const run = adapter.createRun(runInput(), contextWith());
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [query.prompts[0]?.uuid as string]));
    await flush();
    await run.send(steer);
    await run.send(stuck);
    expect(await run.interrupt()).toEqual({ stillQueued: [steer.messageId] });
    expect(query.interruptOptions).toEqual([undefined]);
    expect(query.cancelRequests).toEqual([steer.messageId, stuck.messageId]);
    expect(diagnostics.some((line) => /cannot cancel the queue with an interrupt/.test(line))).toBe(true);
  });

  it("is a no-op on a run that has ended", async () => {
    const adapter = adapterWith();
    const run = adapter.createRun(runInput(), contextWith());
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.result(PROVIDER_SESSION));
    await drain(run);
    expect(await run.interrupt()).toEqual({ stillQueued: [] });
    expect(query.interrupts).toBe(0);
  });

  it("forces the transport down when the control channel never answers, and the run ends interrupted", async () => {
    fake.controls = { interruptReceipt: () => new Promise(() => undefined) };
    const adapter = adapterWith();
    const run = adapter.createRun(runInput(), contextWith());
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [query.prompts[0]?.uuid as string]));
    const read = reading(run);
    await vi.waitFor(() => expect(read.events).toHaveLength(1));
    const interrupted = run.interrupt();
    await new Promise((resolve) => setTimeout(resolve, 1));
    clock.advance(8_000);
    expect(await interrupted).toEqual({ stillQueued: [] });
    expect(query.closed).toBe(true);
    expect(ends(await read.done)).toEqual([expect.objectContaining({ reason: "interrupted", cause: "user" })]);
  });

  it("withdraws a prompt the CLI has not opened, and the run ends there", async () => {
    fake.controls = { cancelled: () => true };
    const adapter = adapterWith();
    const run = adapter.createRun(runInput(), contextWith());
    const query = await started();
    expect(await run.interrupt()).toEqual({ stillQueued: [] });
    expect(query.interrupts).toBe(0);
    expect(ends(await drain(run))).toEqual([expect.objectContaining({ reason: "interrupted", cause: "user" })]);
  });
});

describe("the process across turns", () => {
  /** Runs one turn to its result on the process, and releases it as the host does. */
  const oneTurn = async (adapter: ReturnType<typeof adapterWith>, input: RunInput, query?: FakeQuery) => {
    const run = adapter.createRun(input, contextWith());
    const used = query ?? (await started(fake.queries.length + 1));
    await vi.waitFor(() => expect(used.prompts.some((prompt) => prompt.uuid === input.prompt[0]?.messageId)).toBe(true));
    const events = reading(run);
    return { run, query: used, events, finish: async (...extra: unknown[]) => {
      used.emit(...(query === undefined ? [sdk.init(PROVIDER_SESSION)] : [sdk.init(PROVIDER_SESSION)]), sdk.replyStart(`msg_${randomUUID()}`, [input.prompt[0]?.messageId as string]), ...extra, sdk.result(PROVIDER_SESSION));
      const done = await events.done;
      run.release();
      return done;
    } };
  };

  it("lets an idle process go when its run is released and nothing holds it", async () => {
    const adapter = adapterWith();
    const turn = await oneTurn(adapter, runInput());
    await turn.finish();
    expect(turn.query.closed).toBe(true);
    expect(turn.query.promptEnded).toBe(true);
  });

  it("keeps the process while a background task outlives the turn, and serves the next run on it with no second spawn", async () => {
    const adapter = adapterWith();
    const first = await oneTurn(adapter, runInput());
    await first.finish(sdk.tasks({ task_id: "task_1", description: "Explore" }));
    expect(first.query.closed).toBe(false);
    const next = runInput({ model: "sonnet", mode: "plan", effort: "high", target: { kind: "resume", providerSessionId: PROVIDER_SESSION } });
    const second = await oneTurn(adapter, next, first.query);
    expect(fake.queries).toHaveLength(1);
    expect(first.query.models).toEqual(["sonnet"]);
    expect(first.query.modes).toEqual(["plan"]);
    expect(first.query.flags).toEqual([{ effortLevel: "high" }]);
    const events = await second.finish();
    expect(ends(events)).toHaveLength(1);
  });

  it("sends no control request to a process whose settings did not change", async () => {
    const adapter = adapterWith();
    const first = await oneTurn(adapter, runInput());
    await first.finish(sdk.tasks({ task_id: "task_1" }));
    const second = await oneTurn(adapter, runInput({ target: { kind: "resume", providerSessionId: PROVIDER_SESSION } }), first.query);
    await second.finish();
    expect([first.query.models, first.query.modes, first.query.flags]).toEqual([[], [], []]);
  });

  it("keeps an idle process for the idle time, then lets it go", async () => {
    const adapter = adapterWith({ timings: { idleMs: 60_000 } });
    const turn = await oneTurn(adapter, runInput());
    await turn.finish();
    expect(turn.query.closed).toBe(false);
    clock.advance(59_999);
    expect(turn.query.closed).toBe(false);
    clock.advance(1);
    expect(turn.query.closed).toBe(true);
  });

  it("lets it go when the last task settles and no turn about it comes within the grace", async () => {
    const adapter = adapterWith();
    const turn = await oneTurn(adapter, runInput());
    await turn.finish(sdk.tasks({ task_id: "task_1" }));
    turn.query.emit(sdk.taskNotification("task_1"), sdk.tasks());
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(turn.query.closed).toBe(false);
    clock.advance(1_999);
    expect(turn.query.closed).toBe(false);
    clock.advance(1);
    expect(turn.query.closed).toBe(true);
  });

  it("keeps a process that registered a schedule", async () => {
    const adapter = adapterWith();
    const turn = await oneTurn(adapter, runInput());
    await turn.finish(sdk.toolUse("toolu_cron", "CronCreate", { cron: "0 * * * *" }), sdk.toolResult("toolu_cron"));
    expect(turn.query.closed).toBe(false);
  });

  it("spawns fresh for a run that asks for bypass of a process started without it, and refuses while it holds work", async () => {
    const adapter = adapterWith();
    const first = await oneTurn(adapter, runInput());
    await first.finish(sdk.tasks({ task_id: "task_1" }));
    expect(() => adapter.createRun(runInput({ mode: "bypassPermissions", target: { kind: "resume", providerSessionId: PROVIDER_SESSION } }), contextWith())).toThrow(/still has work running/);
    first.query.emit(sdk.tasks());
    await new Promise((resolve) => setTimeout(resolve, 5));
    adapter.createRun(runInput({ mode: "bypassPermissions", target: { kind: "resume", providerSessionId: PROVIDER_SESSION } }), contextWith());
    const second = await started(2);
    expect(first.query.closed).toBe(true);
    expect(second.options).toMatchObject({ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, resume: PROVIDER_SESSION });
  });

  it("never serves a fork on the process, and rewinds fresh from the entry before the message, read under the account's directory", async () => {
    const adapter = adapterWith();
    const first = await oneTurn(adapter, runInput());
    await first.finish(sdk.tasks({ task_id: "task_1" }));
    first.query.emit(sdk.tasks());
    await new Promise((resolve) => setTimeout(resolve, 5));
    fake.stored.set(PROVIDER_SESSION, [
      { type: "user", uuid: "p1", message: { role: "user", content: "First" } },
      { type: "assistant", uuid: "a1", message: { role: "assistant", content: [] } },
      { type: "user", uuid: "p2", message: { role: "user", content: "Second" } },
      { type: "assistant", uuid: "a2", message: { role: "assistant", content: [] } },
    ]);
    adapter.createRun(runInput({ target: { kind: "rewind", providerSessionId: PROVIDER_SESSION, toMessageId: "p2" } }), contextWith());
    const rewound = await started(2);
    expect(rewound.options).toMatchObject({ resume: PROVIDER_SESSION, resumeSessionAt: "a1", resumeDropsTurn: "p2" });
    expect(fake.storedReads).toEqual([{ sessionId: PROVIDER_SESSION, options: {}, configDir: "/data/accounts/work" }]);
  });

  it("ends a rewind it cannot place, rather than resuming the whole session", async () => {
    const adapter = adapterWith();
    const run = adapter.createRun(runInput({ target: { kind: "rewind", providerSessionId: PROVIDER_SESSION, toMessageId: "nowhere" } }), contextWith());
    expect(ends(await drain(run))).toEqual([expect.objectContaining({ reason: "error", error: expect.objectContaining({ message: expect.stringMatching(/not in the stored conversation/) }) })]);
    expect(fake.queries).toHaveLength(0);
  });

  it("stops every process it keeps when the adapter closes", async () => {
    const adapter = adapterWith();
    const turn = await oneTurn(adapter, runInput());
    await turn.finish(sdk.tasks({ task_id: "task_1" }));
    adapter.close();
    expect(turn.query.closed).toBe(true);
  });
});

describe("the recorded signed-out stream through the adapter", () => {
  it("ends the run error with the provider's own words, the spawn's first turn being its run's", async () => {
    const recorded = (JSON.parse(readFileSync(join(import.meta.dirname, "../../../test/fixtures/sdk/signed-out.json"), "utf8")) as { messages: unknown[] }).messages;
    const run = adapterWith().createRun(runInput(), contextWith());
    const query = await started();
    query.emit(...recorded);
    const events = await drain(run);
    expect(events.map((event) => event.type)).toEqual(["session.provider-linked", "assistant.text", "end"]);
    expect(ends(events)).toEqual([expect.objectContaining({ reason: "error", error: { message: "Not logged in · Please run /login", code: "authentication_failed" } })]);
  });
});

describe("a turn the provider opens on its own", () => {
  it("runs ahead of a resumed spawn's run when the last process left work to answer, and the run opens after it", async () => {
    const adapter = adapterWith();
    const context = contextWith();
    const input = runInput({ target: { kind: "resume", providerSessionId: PROVIDER_SESSION } });
    const run = adapter.createRun(input, context);
    const query = await started();
    const read = reading(run);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_0", []), sdk.text("msg_0", "The earlier task finished."), sdk.result(PROVIDER_SESSION));
    await vi.waitFor(() => expect(context.adopted).toHaveLength(1));
    expect(read.events).toEqual([]);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]), sdk.text("msg_1", "Yours."), sdk.result(PROVIDER_SESSION));
    expect((await read.done).filter((event) => event.type === "assistant.text")).toEqual([{ type: "assistant.text", payload: { itemId: "msg_1:0", text: "Yours.", aborted: false } }]);
  });

  it("is adopted as a run: the task it answers and the words it says land there, and its result ends it", async () => {
    const adapter = adapterWith();
    const context = contextWith();
    const input = runInput();
    const run = adapter.createRun(input, context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]), sdk.tasks({ task_id: "task_1" }), sdk.result(PROVIDER_SESSION));
    await drain(run);
    run.release();
    query.emit(sdk.taskNotification("task_1"), sdk.tasks(), sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_2", []), sdk.text("msg_2", "The explorer finished."), sdk.result(PROVIDER_SESSION));
    await vi.waitFor(() => expect(context.adopted).toHaveLength(1));
    const adopted = context.adopted[0] as ProviderTurn;
    expect(adopted.messageIds).toEqual([]);
    adopted.onAdopted?.("run-adopted");
    const events = await drain(adopted);
    expect(events.map((event) => event.type)).toEqual(["session.provider-linked", "tasks.changed", "assistant.text", "end"]);
    expect(events[1]).toMatchObject({ payload: { tasks: [expect.objectContaining({ taskId: "task_1", status: "completed" })] } });
    expect(ends(events)).toHaveLength(1);
  });

  it("opens with the messages sent during the last turn that it never read, and holds the process for it", async () => {
    const adapter = adapterWith();
    const context = contextWith();
    const input = runInput();
    const run = adapter.createRun(input, context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]));
    await vi.waitFor(() => expect(query.prompts).toHaveLength(1));
    const queued = message("When you are done, run the tests");
    await run.send(queued);
    query.emit(sdk.result(PROVIDER_SESSION));
    await drain(run);
    run.release();
    expect(query.closed).toBe(false);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_2", [queued.messageId]), sdk.text("msg_2", "Running the tests."), sdk.result(PROVIDER_SESSION));
    await vi.waitFor(() => expect(context.adopted).toHaveLength(1));
    expect(context.adopted[0]?.messageIds).toEqual([queued.messageId]);
    expect(ends(await drain(context.adopted[0] as ProviderTurn))).toEqual([expect.objectContaining({ reason: "completed" })]);
  });

  it("goes ahead of a run whose prompt is still queued, which opens after it", async () => {
    const adapter = adapterWith();
    const context = contextWith();
    const first = await (async () => {
      const input = runInput();
      const run = adapter.createRun(input, context);
      const query = await started();
      query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]), sdk.tasks({ task_id: "task_1" }), sdk.result(PROVIDER_SESSION));
      await drain(run);
      run.release();
      return query;
    })();
    const next = runInput({ target: { kind: "resume", providerSessionId: PROVIDER_SESSION } });
    const run = adapter.createRun(next, context);
    await vi.waitFor(() => expect(first.prompts).toHaveLength(2));
    const read = reading(run);
    // The CLI answers the settled task first: a turn of its own, whose reply names no prompt of ours.
    first.emit(sdk.taskNotification("task_1"), sdk.tasks(), sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_2", []), sdk.text("msg_2", "The task is done."), sdk.result(PROVIDER_SESSION));
    await vi.waitFor(() => expect(context.adopted).toHaveLength(1));
    expect(read.events).toEqual([]);
    first.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_3", [next.prompt[0]?.messageId as string]), sdk.text("msg_3", "Now yours."), sdk.result(PROVIDER_SESSION));
    const events = await read.done;
    expect(events.filter((event) => event.type === "assistant.text")).toEqual([{ type: "assistant.text", payload: { itemId: "msg_3:0", text: "Now yours.", aborted: false } }]);
    expect((await drain(context.adopted[0] as ProviderTurn)).filter((event) => event.type === "assistant.text")).toEqual([
      { type: "assistant.text", payload: { itemId: "msg_2:0", text: "The task is done.", aborted: false } },
    ]);
  });

  it("lets a subagent ask long after its own turn ended: a turn is opened for the prompt, under the run id the host adopted it as", async () => {
    const adapter = adapterWith();
    const context = contextWith();
    const input = runInput();
    const run = adapter.createRun(input, context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]), sdk.tasks({ task_id: "task_1" }), sdk.result(PROVIDER_SESSION));
    await drain(run);
    run.release();
    void query.canUseTool("Bash", { command: "npm test" }, { toolUseID: "toolu_sub", agentID: "agent-1" });
    await vi.waitFor(() => expect(context.adopted).toHaveLength(1));
    // The host has not named the run yet (it may still be ending the run before): the broker is not asked with no run id.
    await flush();
    expect(context.asked).toEqual([]);
    context.adopted[0]?.onAdopted?.("run-for-the-subagent");
    await vi.waitFor(() => expect(context.asked).toHaveLength(1));
    expect(context.asked[0]).toMatchObject({ runId: "run-for-the-subagent", kind: "permission", detail: { agentId: "agent-1" } });
  });

  it("keeps a subagent's prompt turn open across the CLI's next turn, until the prompt is answered", async () => {
    const adapter = adapterWith();
    const context = contextWith();
    const input = runInput();
    const run = adapter.createRun(input, context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]), sdk.tasks({ task_id: "task_1" }), sdk.result(PROVIDER_SESSION));
    await drain(run);
    run.release();
    const asked = query.canUseTool("Bash", { command: "npm test" }, { toolUseID: "toolu_sub", agentID: "agent-1" });
    await vi.waitFor(() => expect(context.adopted).toHaveLength(1));
    const promptTurn = context.adopted[0] as ProviderTurn;
    promptTurn.onAdopted?.("run-prompt");
    const read = reading(promptTurn);
    // The CLI opens a turn of its own meanwhile (the task settling): it is a turn of its own, and the prompt's stays open.
    query.emit(sdk.taskNotification("task_1"), sdk.tasks(), sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_2", []), sdk.text("msg_2", "Task done."), sdk.result(PROVIDER_SESSION));
    await vi.waitFor(() => expect(context.adopted).toHaveLength(2));
    await flush();
    expect(ends(read.events)).toEqual([]);
    promptTurn.answerPrompt?.("toolu_sub", { decision: "allow" });
    expect(await asked).toMatchObject({ behavior: "allow" });
    expect(ends(await read.done)).toEqual([expect.objectContaining({ reason: "completed" })]);
  });
});

describe("plan usage", () => {
  it.each(["usage", "getUsage", "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"])("is read on an unsampled query under the account's directory, through %s", async (name) => {
    fake.controls = {
      usage: { name, answer: async () => ({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 50, resets_at: "2026-09-24T05:00:00Z" } } }) },
    };
    const reading = await adapterWith().usage({ id: "work", directory: "/data/accounts/work" });
    expect(reading).toEqual({
      identity: { provider: "claude", email: "david@example.com", organisation: "David's Organization" },
      windows: [{ window: "five_hour", utilisation: 0.5, resetsAt: "2026-09-24T05:00:00.000Z" }],
      readAt: "2026-09-24T00:00:00.000Z",
    });
    const query = fake.last();
    expect(query.env["CLAUDE_CONFIG_DIR"]).toBe("/data/accounts/work");
    expect(query.options).toMatchObject({ settingSources: [], strictMcpConfig: true, includePartialMessages: false });
    expect(query.prompts).toEqual([]);
    expect(query.closed).toBe(true);
  });

  it("degrades to unavailable, with the identity, when the method was renamed away", async () => {
    expect(await adapterWith().usage({ id: "work", directory: "/data/accounts/work" })).toMatchObject({
      identity: { email: "david@example.com" },
      windows: [],
      unavailableReason: expect.stringMatching(/does not report plan usage/),
    });
  });

  it("takes the identity from the status command when the control channel names no one", async () => {
    fake.controls = { accountInfo: async () => ({}) };
    const adapter = adapterWith({
      runCommand: async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "seth@example.com", orgName: "Seth's" }), stderr: "" }),
    });
    expect((await adapter.usage({ id: "work", directory: "/d" })).identity).toEqual({ provider: "claude", email: "seth@example.com", organisation: "Seth's" });
  });

  it("folds a run's rate-limit verdict into the account's reading", async () => {
    fake.controls = { usage: { name: "usage", answer: async () => ({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 50, resets_at: null } } }) } };
    const adapter = adapterWith();
    const account = { id: "work", directory: "/data/accounts/work" };
    await adapter.usage(account);
    const run = adapter.createRun(runInput(), contextWith());
    const query = await started(2);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [query.prompts[0]?.uuid as string]), sdk.rateLimit("five_hour", "rejected", 100), sdk.result(PROVIDER_SESSION));
    const events = await drain(run);
    expect(events.filter((event) => event.type === "plan.limit")).toEqual([{ type: "plan.limit", payload: { window: "five_hour", status: "rejected", utilisation: 1, resetsAt: null } }]);
    expect((await adapter.usage(account)).windows).toEqual([{ window: "five_hour", utilisation: 1, resetsAt: null, verdict: "rejected" }]);
  });
});

describe("status, models and commands", () => {
  it("reads the status with the bundled binary under the account's directory", async () => {
    const calls: { executable: string; argv: readonly string[]; env: Record<string, string> }[] = [];
    const adapter = adapterWith({
      runCommand: async (executable, argv, env) => {
        calls.push({ executable, argv, env });
        return { code: 1, stdout: '{"loggedIn": false, "authMethod": "none"}', stderr: "" };
      },
    });
    expect(await adapter.status({ id: "work", directory: "/data/accounts/work" })).toMatchObject({ signedIn: false, error: null });
    expect(calls[0]).toMatchObject({ executable: "/sdk/claude-agent-sdk-linux-x64/claude", argv: ["auth", "status", "--json"] });
    expect(calls[0]?.env["CLAUDE_CONFIG_DIR"]).toBe("/data/accounts/work");
    expect(calls[0]?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("lists the binary's models live, with families and tiers, and falls back to the static list", async () => {
    fake.controls = {
      supportedModels: async () => [
        { value: "default", displayName: "Default (recommended)", description: "" },
        { value: "opus", resolvedModel: "claude-opus-5", displayName: "Opus", description: "", supportedEffortLevels: ["low", "high"] },
        { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku", description: "", supportsEffort: false },
      ],
    };
    const adapter = adapterWith();
    expect(await adapter.models({ id: "work", directory: "/d" })).toEqual({
      live: true,
      models: [
        { id: "opus", family: "opus", tier: 2, efforts: ["low", "high"], label: "Opus" },
        { id: "haiku", family: "haiku", tier: 0, efforts: [], label: "Haiku" },
      ],
    });
    fake.controls = { supportedModels: async () => Promise.reject(new Error("offline")) };
    expect(await adapter.models({ id: "work", directory: "/d" })).toMatchObject({ live: false, models: expect.arrayContaining([expect.objectContaining({ id: "fable", tier: 3 })]) });
  });

  it("lists the commands for a workspace without starting a turn", async () => {
    fake.controls = { supportedCommands: async () => [{ name: "review", description: "Review the branch", argumentHint: "" }] };
    const adapter = adapterWith();
    expect(await adapter.commands({ id: "work", directory: "/d" }, { kind: "directory", path: "/work/repo" })).toEqual([{ name: "review", description: "Review the branch" }]);
    expect(fake.last().options.cwd).toBe("/work/repo");
    expect(fake.last().prompts).toEqual([]);
  });

  it("describes itself: the four modes, the append channel, a provider queue that steers", () => {
    expect(CLAUDE_DESCRIPTOR).toMatchObject({
      provider: "claude",
      modes: ["acceptEdits", "plan", "auto", "bypassPermissions"],
      instructionChannel: { kind: "system-prompt-append", maxCharacters: null },
      providerQueue: true,
      steering: true,
      planUsage: true,
    });
  });
});

describe("a turn opened for a subagent's prompt", () => {
  const promptTurn = async () => {
    const adapter = adapterWith();
    const context = contextWith();
    const input = runInput();
    const run = adapter.createRun(input, context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]), sdk.tasks({ task_id: "task_1" }), sdk.result(PROVIDER_SESSION));
    await drain(run);
    run.release();
    const asked = query.canUseTool("Bash", { command: "npm test" }, { toolUseID: "toolu_sub", agentID: "agent-1" });
    await vi.waitFor(() => expect(context.adopted).toHaveLength(1));
    return { query, context, asked, turn: context.adopted[0] as ProviderTurn };
  };

  it("ends once its prompt is answered, since no result of the CLI's will end it", async () => {
    const { asked, turn } = await promptTurn();
    const read = reading(turn);
    turn.answerPrompt?.("toolu_sub", { decision: "allow" });
    expect(await asked).toMatchObject({ behavior: "allow" });
    expect(ends(await read.done)).toEqual([expect.objectContaining({ reason: "completed" })]);
  });

  it("denies its prompt and ends interrupted when interrupted", async () => {
    const { asked, turn, query } = await promptTurn();
    const read = reading(turn);
    expect(await turn.interrupt()).toEqual({ stillQueued: [] });
    expect(await asked).toMatchObject({ behavior: "deny" });
    expect(ends(await read.done)).toEqual([expect.objectContaining({ reason: "interrupted", cause: "user" })]);
    expect(query.interrupts).toBe(0);
  });
});

describe("a run that joins a kept process", () => {
  /** A first run whose turn leaves the process kept by a live task, released as the host does. */
  const keptByTask = async (adapter: ReturnType<typeof adapterWith>, context: Context) => {
    const input = runInput();
    const run = adapter.createRun(input, context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]), sdk.tasks({ task_id: "task_1" }), sdk.result(PROVIDER_SESSION));
    await drain(run);
    run.release();
    return query;
  };

  it("gives the one waiting run a turn the CLI opens with a delivery-failure result that names no one", async () => {
    const adapter = adapterWith({ timings: { idleMs: 60_000 } });
    const context = contextWith();
    const input = runInput();
    const first = adapter.createRun(input, context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]), sdk.result(PROVIDER_SESSION));
    await drain(first);
    first.release();
    const next = runInput({ target: { kind: "resume", providerSessionId: PROVIDER_SESSION } });
    const run = adapter.createRun(next, context);
    await query.promptsPushed(2);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.result(PROVIDER_SESSION, { subtype: "success", is_error: true, result: "API Error: 529 overloaded", num_turns: 0 }));
    expect(ends(await drain(run))).toEqual([expect.objectContaining({ reason: "error" })]);
    expect(context.adopted).toEqual([]);
  });

  it("ends a run the CLI never opens with an error once the open timeout passes with no turn served", async () => {
    const adapter = adapterWith();
    const context = contextWith();
    const query = await keptByTask(adapter, context);
    const next = runInput({ target: { kind: "resume", providerSessionId: PROVIDER_SESSION } });
    const run = adapter.createRun(next, context);
    await query.promptsPushed(2);
    const read = reading(run);
    // The CLI answers something else, naming no one, with a task still live: that turn is the provider's own.
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_2", []), sdk.text("msg_2", "Still exploring."), sdk.result(PROVIDER_SESSION));
    await vi.waitFor(() => expect(context.adopted).toHaveLength(1));
    await flush();
    clock.advance(59_999);
    await flush();
    expect(read.events).toEqual([]);
    clock.advance(1);
    expect(ends(await read.done)).toEqual([expect.objectContaining({ reason: "error", error: expect.objectContaining({ code: "not_opened" }) })]);
  });

  it("interrupts a run whose prompt waits behind the CLI's own turn only once that run opens, never the turn ahead of it", async () => {
    fake.controls = { cancelled: () => false };
    const adapter = adapterWith();
    const context = contextWith();
    const query = await keptByTask(adapter, context);
    const next = runInput({ target: { kind: "resume", providerSessionId: PROVIDER_SESSION } });
    const run = adapter.createRun(next, context);
    await query.promptsPushed(2);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_2", []));
    await vi.waitFor(() => expect(context.adopted).toHaveLength(1));
    const read = reading(run);
    const interrupted = run.interrupt();
    await flush();
    expect(query.interrupts).toBe(0);
    expect(query.cancelRequests).toEqual([next.prompt[0]?.messageId]);
    query.emit(sdk.result(PROVIDER_SESSION), sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_3", [next.prompt[0]?.messageId as string]));
    expect(await interrupted).toEqual({ stillQueued: [] });
    expect(query.interrupts).toBe(1);
    query.emit(sdk.interruptedResult(PROVIDER_SESSION));
    expect(ends(await read.done)).toEqual([expect.objectContaining({ reason: "interrupted", cause: "user" })]);
  });

  it("lets a process kept only for a schedule go for a run it cannot serve, handing the fresh one a queued message it never opened", async () => {
    const adapter = adapterWith();
    const context = contextWith();
    const input = runInput();
    const run = adapter.createRun(input, context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]), sdk.toolUse("toolu_cron", "CronCreate", { cron: "0 * * * *" }), sdk.toolResult("toolu_cron"));
    await flush();
    const queued = message("Then tidy up");
    await run.send(queued);
    query.emit(sdk.result(PROVIDER_SESSION));
    await drain(run);
    run.release();
    expect(query.closed).toBe(false);
    const bypass = runInput({ mode: "bypassPermissions", target: { kind: "resume", providerSessionId: PROVIDER_SESSION } });
    adapter.createRun(bypass, context);
    const fresh = await fake.made(2);
    const prompts = await fresh.promptsPushed(2);
    expect(query.closed).toBe(true);
    expect(prompts.map((prompt) => prompt.uuid)).toEqual([bypass.prompt[0]?.messageId, queued.messageId]);
  });

  it("stops holding the process for a schedule once CronDelete removes it", async () => {
    const adapter = adapterWith();
    const context = contextWith();
    const input = runInput();
    const run = adapter.createRun(input, context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]), sdk.toolUse("toolu_c", "CronCreate"), sdk.toolResult("toolu_c"), sdk.result(PROVIDER_SESSION));
    await drain(run);
    run.release();
    expect(query.closed).toBe(false);
    const next = runInput({ target: { kind: "resume", providerSessionId: PROVIDER_SESSION } });
    const second = adapter.createRun(next, context);
    await query.promptsPushed(2);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_2", [next.prompt[0]?.messageId as string]), sdk.toolUse("toolu_d", "CronDelete"), sdk.toolResult("toolu_d"), sdk.result(PROVIDER_SESSION));
    await drain(second);
    second.release();
    expect(query.closed).toBe(true);
  });

  it("fails the run, rather than hanging, when the process does not take the run's model in time", async () => {
    const adapter = adapterWith();
    const context = contextWith();
    const query = await keptByTask(adapter, context);
    query.setModel = () => new Promise<void>(() => undefined);
    const run = adapter.createRun(runInput({ model: "sonnet", target: { kind: "resume", providerSessionId: PROVIDER_SESSION } }), context);
    const read = reading(run);
    await flush();
    clock.advance(15_000);
    expect(ends(await read.done)).toEqual([expect.objectContaining({ reason: "error", error: expect.objectContaining({ code: "settings" }) })]);
  });

  it("still reports a queued message read by a turn that opens after the five-second grace", async () => {
    const adapter = adapterWith();
    const context = contextWith();
    const input = runInput();
    const run = adapter.createRun(input, context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]), sdk.tasks({ task_id: "task_1" }));
    await flush();
    const queued = message("Afterwards, summarise");
    await run.send(queued);
    query.emit(sdk.result(PROVIDER_SESSION));
    await drain(run);
    run.release();
    clock.advance(5_000);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_2", [queued.messageId]), sdk.result(PROVIDER_SESSION));
    await vi.waitFor(() => expect(context.adopted).toHaveLength(1));
    expect(context.adopted[0]?.messageIds).toEqual([queued.messageId]);
  });
});

describe("stopping a session's process", () => {
  it("stops a process kept for a task, so no later turn of it is adopted", async () => {
    const adapter = adapterWith();
    const context = contextWith();
    const input = runInput();
    const run = adapter.createRun(input, context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]), sdk.tasks({ task_id: "task_1" }), sdk.result(PROVIDER_SESSION));
    await drain(run);
    run.release();
    expect(query.closed).toBe(false);
    adapter.stopProcess(SESSION);
    expect(query.closed).toBe(true);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_2", []), sdk.result(PROVIDER_SESSION));
    await flush();
    expect(context.adopted).toEqual([]);
  });
});

describe("the environment the adapter was made with", () => {
  it("is copied once: a directory the config-directory queue writes later never reaches a run, and an account with none gets the ambient default", async () => {
    const saved = { dir: process.env["CLAUDE_CONFIG_DIR"], key: process.env["ANTHROPIC_API_KEY"] };
    delete process.env["CLAUDE_CONFIG_DIR"];
    try {
      const adapter = createClaudeAdapter({ clock, executablePath: "/sdk/claude", diagnostic: () => undefined });
      // What the queue does while a helper of another account runs.
      process.env["CLAUDE_CONFIG_DIR"] = "/data/accounts/other";
      process.env["ANTHROPIC_API_KEY"] = "sk-ant-late";
      adapter.createRun(runInput({ account: { id: "ambient", directory: null } }), contextWith());
      const query = await started();
      expect(query.env["CLAUDE_CONFIG_DIR"]).toBe(join(process.env["HOME"] ?? homedir(), ".claude"));
      expect(query.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    } finally {
      if (saved.dir === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
      else process.env["CLAUDE_CONFIG_DIR"] = saved.dir;
      if (saved.key === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = saved.key;
    }
  });

  it("reads an account with no directory's status under the ambient default, set explicitly", async () => {
    const seen: string[] = [];
    const adapter = adapterWith({
      hostEnv: { PATH: "/usr/bin", HOME: "/home/seth" },
      runCommand: async (_executable, _argv, env) => {
        seen.push(env["CLAUDE_CONFIG_DIR"] ?? "unset");
        return { code: 1, stdout: '{"loggedIn": false}', stderr: "" };
      },
    });
    await adapter.status({ id: "ambient", directory: null });
    expect(seen).toEqual(["/home/seth/.claude"]);
  });
});

describe("the unsampled queries", () => {
  it("keep no transcript, load no plugins for a model listing, and load a trusted repository's commands with its project settings", async () => {
    fake.controls = { supportedModels: async () => [], supportedCommands: async () => [] };
    const adapter = adapterWith({ pluginDirectory: () => "/data/skills/work" });
    await adapter.models({ id: "work", directory: "/d" });
    expect(fake.last().options).toMatchObject({ persistSession: false, settingSources: [] });
    expect(fake.last().options).not.toHaveProperty("plugins");
    await adapter.commands({ id: "work", directory: "/d" }, { kind: "directory", path: "/work/repo" }, { trusted: true });
    expect(fake.last().options).toMatchObject({ persistSession: false, settingSources: ["project"], plugins: [{ type: "local", path: "/data/skills/work" }] });
    await adapter.commands({ id: "work", directory: "/d" }, { kind: "directory", path: "/work/repo" });
    expect(fake.last().options.settingSources).toEqual([]);
  });
});
