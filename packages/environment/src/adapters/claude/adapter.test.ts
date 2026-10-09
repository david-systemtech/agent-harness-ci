import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_RUN_SKILL_SET, type AccountIdentity, type RunSkillSet } from "@agent-harness/contracts";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { manualClock, type ManualClock } from "../../../test/clock.js";
import { FakeSdk, sdk, type FakeQuery } from "../../../test/fake-claude-sdk.js";
import { git } from "../../../test/workspaces.js";
import {
  WithdrawUnsupported,
  type AdapterEvent,
  type AdapterRun,
  type FileChangeObserver,
  type FileToolCall,
  type GateDecision,
  type GatedToolCall,
  type InProcessToolServer,
  type PermissionBroker,
  type ProcessEnvironment,
  type PromptDecision,
  type PromptRequest,
  type ProviderTurn,
  type RunContext,
  type RunInput,
} from "../../adapter/contract.js";
import { EMPTY_PROCESS_ENVIRONMENT } from "../../adapter/process-environment.js";

/**
 * The Claude adapter with the SDK transport scripted (claude-adapter spec,
 * "Testing Decisions", the adapter seam): the SDK module is replaced through
 * `vi.hoisted` and `vi.mock`, so nothing is spawned and no credential is
 * used, and every path under test is the real adapter: the options `query()`
 * received, the prompt pump, the permission table on the broker seam, the
 * process kept across turns, the turn the provider opens on its own, the
 * interrupt, and the reads on unsampled queries. The cases here are ported,
 * with the vocabulary renamed.
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
  // A resume the store holds nothing of first copies it from the account's directory (#579); these runs' directories hold none.
  importSessionToStore: async (id: string) => {
    throw new Error(`Session ${id} not found`);
  },
}));

const { createClaudeAdapter, CLAUDE_DESCRIPTOR, DEFAULT_TIMINGS } = await import("./index.js");
const { createConfigDirQueue } = await import("./config-dir-queue.js");

const SESSION = "6f1d2a4e-8c3b-4f5a-9d7e-1a2b3c4d5e6f";
const PROVIDER_SESSION = "5d1e9c3a-7b2f-4e8d-9a6c-3f0b1e2d4c5a";

let fake: FakeSdk;
let clock: ManualClock;
let diagnostics: string[];
/** What the pool's port was told, in order: `hold task:<id>`, `unhold schedule:<id>`, `exited`. */
let port: string[];

beforeEach(() => {
  fake = new FakeSdk();
  hooks.sdk = fake;
  clock = manualClock();
  diagnostics = [];
  port = [];
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
  ceiling: "acceptEdits",
  instructions: "",
  target: { kind: "fresh" },
  toolServers: [],
  trusted: false,
  containment: {
    level: "off",
    mechanism: null,
    scratchDirectory: "/data/containment/session/scratch",
    temporaryDirectory: "/data/containment/session/tmp",
    writable: ["/work/repo", "/data/containment/session/scratch", "/data/containment/session/tmp"],
    readOnly: [],
    network: true,
  },
  denylist: null,
  processEnvironment: EMPTY_PROCESS_ENVIRONMENT,
  skillSet: EMPTY_RUN_SKILL_SET,
  prompt: [message("Go")],
  ...overrides,
});

/** A resolved skill set under `fingerprint`: its generation, a linked `tdd`, a trusted repository's native `release`, and its native `triage` switched off. */
const skillSetOf = (fingerprint: string): RunSkillSet => ({
  generation: `/data/skills/generations/${fingerprint}`,
  fingerprint,
  members: [
    { name: "tdd", description: "Test-driven development.", origin: null, invocation: "model+slash", userInvocable: true, argumentHint: null, native: false, alwaysOn: false },
    { name: "release", description: "Cut a release.", origin: null, invocation: "slash-only", userInvocable: true, argumentHint: null, native: true, alwaysOn: false },
  ],
  hiddenNativeNames: ["triage"],
});

interface Context extends RunContext {
  readonly adopted: ProviderTurn[];
  readonly asked: PromptRequest[];
  /** The identities the run reported through `reportIdentity`. */
  readonly identities: AccountIdentity[];
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
  const identities: AccountIdentity[] = [];
  return { broker, gate: { check: async () => ({ decision: "allow" }) }, adopt: (turn) => adopted.push(turn), adopted, asked, identities, reportIdentity: (identity) => void identities.push(identity), recheckAccount: () => undefined, process: {
      hold: (kind, id) => port.push(`hold ${kind}:${id}`),
      unhold: (kind, id) => port.push(`unhold ${kind}:${id}`),
      exited: () => port.push("exited"),
    },
  };
};

/** A context whose gate rules as `rule` says and records every call it was asked about, with the signal it was given. */
const gatedWith = (rule: (call: GatedToolCall, signal: AbortSignal | undefined) => GateDecision | Promise<GateDecision>, decide?: (request: PromptRequest) => Promise<PromptDecision>) => {
  const checked: { readonly call: GatedToolCall; readonly signal: AbortSignal | undefined }[] = [];
  const context: Context = {
    ...contextWith(decide),
    gate: {
      check: async (call, signal) => {
        checked.push({ call, signal });
        return rule(call, signal);
      },
    },
  };
  return { context, checked };
};

/** What the hook answers for a call the gate denies. */
const hookDenies = (message: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: message } });

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
    expect(events.map((event) => event.type)).toEqual(["session.provider-linked", "assistant.delta", "context.reported", "assistant.text", "end"]);
    expect(events[1]).toEqual({ type: "assistant.delta", payload: { itemId: "msg_1:0", fragments: [{ kind: "text", text: "Hello." }] } });
    expect(ends(events)).toEqual([{ type: "end", reason: "completed", cause: null, error: null, usage: null, turnCount: 1, resultText: "Done." }]);
  });

  it("reports who the CLI says it is signed in as, from accountInfo once its first init shows it is up, once per process", async () => {
    fake.controls = { accountInfo: async () => ({ email: "other@example.com", organization: "" }) };
    const adapter = adapterWith();
    const context = contextWith();
    const input = runInput();
    const run = adapter.createRun(input, context);
    const query = await started();
    expect(context.identities).toEqual([]);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]), sdk.text("msg_1", "Hi."), sdk.result(PROVIDER_SESSION));
    await drain(run);
    await vi.waitFor(() => expect(context.identities).toEqual([{ provider: "claude", email: "other@example.com", organisation: null }]));
    query.emit(sdk.init(PROVIDER_SESSION));
    await flush();
    expect(context.identities).toHaveLength(1);
  });

  it("logs a report of who the CLI is signed in as that the host fails to take, and the run goes on to its end", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const adapter = adapterWith();
      const context: Context = {
        ...contextWith(),
        reportIdentity: () => {
          throw new Error("The event log is closed.");
        },
      };
      const input = runInput();
      const run = adapter.createRun(input, context);
      const query = await started();
      query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]), sdk.text("msg_1", "Hi."), sdk.result(PROVIDER_SESSION));
      expect(ends(await drain(run))).toEqual([expect.objectContaining({ reason: "completed" })]);
      await vi.waitFor(() => expect(diagnostics.some((line) => /reporting who the CLI is signed in as failed/.test(line))).toBe(true));
      await flush();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("buffers what the provider says before anyone reads, and is read once", async () => {
    const adapter = adapterWith();
    const run = adapter.createRun(runInput(), contextWith());
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.text("msg_1", "Hi."), sdk.result(PROVIDER_SESSION));
    await vi.waitFor(() => expect(query.prompts).toHaveLength(1));
    expect((await drain(run)).map((event) => event.type)).toEqual(["session.provider-linked", "context.reported", "assistant.text", "end"]);
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
    expect(() => adapter.createRun(runInput({ mode: "default" as never }), contextWith())).toThrow(/mode default/);
    expect(() => adapter.createRun(runInput({ mode: "dontAsk" as never }), contextWith())).toThrow(/mode dontAsk/);
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
    const store = { append: async () => undefined, load: async () => null, listUnrenamedSummaries: async () => [] };
    const adapter = adapterWith({ sessionStore: store, autoMemoryRoot: "/data/auto-memory" });
    const skillSet = skillSetOf("3f9a");
    adapter.createRun(runInput({ trusted: true, instructions: "Be brief.", repositoryIdentity: "git.example/david/repo", skillSet, target: { kind: "resume", providerSessionId: PROVIDER_SESSION } }), contextWith());
    // A cold resume through the store has the CLI refresh the login on an unsampled query first (#229): the run's is the second.
    const options: Options = (await started(2)).options;
    expect(options).toMatchObject({
      cwd: "/work/repo",
      model: "opus",
      permissionMode: "acceptEdits",
      permissionPrompts: "host",
      settingSources: ["project"],
      strictMcpConfig: true,
      includePartialMessages: true,
      systemPrompt: { type: "preset", preset: "claude_code", append: "Be brief." },
      plugins: [{ type: "local", path: "/data/skills/generations/3f9a" }],
      settings: { autoMemoryDirectory: expect.stringMatching(/^\/data\/auto-memory\/git-example-david-repo-[0-9a-f]{12}$/), skillOverrides: { triage: "off" } },
      sessionStore: store,
      resume: PROVIDER_SESSION,
      pathToClaudeCodeExecutable: "/sdk/claude-agent-sdk-linux-x64/claude",
    });
    expect(typeof options.canUseTool).toBe("function");
  });
});

/** A checkout with one commit and a linked worktree of it holding a directory below its root, under a temporary `root`. */
const linkedWorktree = () => {
  const root = mkdtempSync(join(tmpdir(), "agent-harness-repository-"));
  const checkout = join(root, "app");
  git(root, "init", "-q", checkout);
  git(checkout, "commit", "-q", "--allow-empty", "-m", "first");
  const worktree = join(root, "worktree");
  git(checkout, "worktree", "add", "-q", "-b", "fix", worktree);
  const below = join(worktree, "packages", "web");
  mkdirSync(below, { recursive: true });
  return { root, checkout, worktree, below };
};

describe("a run in a worktree", () => {
  it("takes the project settings of the worktree's main checkout when the repository is trusted, and none when it is not", async () => {
    const { root, checkout, worktree } = linkedWorktree();
    try {
      const workspace = { kind: "worktree", path: worktree, repository: checkout, branch: "fix" } as const;
      adapterWith().createRun(runInput({ trusted: true, workspace }), contextWith());
      expect((await started()).options).toMatchObject({ cwd: worktree, projectConfigRoot: checkout });
      adapterWith().createRun(runInput({ trusted: false, workspace }), contextWith());
      expect((await started(2)).options).not.toHaveProperty("projectConfigRoot");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("takes the main checkout's project settings for a workspace below the worktree's root too", async () => {
    const { root, checkout, below } = linkedWorktree();
    try {
      adapterWith().createRun(runInput({ trusted: true, workspace: { kind: "directory", path: below } }), contextWith());
      expect((await started()).options).toMatchObject({ cwd: below, projectConfigRoot: checkout });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it("labels each image with its own media type, and refuses one the SDK does not take before anything spawns, or when sent", async () => {
    const adapter = adapterWith();
    const image = (mediaType: string) => ({ ...message("Look"), attachments: [{ kind: "image" as const, name: "a", mediaType, data: new Uint8Array([1, 2, 3]) }] });
    expect(() => adapter.createRun(runInput({ prompt: [image("image/bmp")] }), contextWith())).toThrow(/image\/bmp/);
    expect(fake.queries).toHaveLength(0);

    const run = adapter.createRun(runInput({ prompt: [image("image/jpeg"), image("image/webp")] }), contextWith());
    const query = await fake.made(1);
    const prompts: SDKUserMessage[] = await query.promptsPushed(2);
    expect(prompts.map((prompt) => (prompt.message.content as { source?: { media_type: string } }[])[0]?.source?.media_type)).toEqual(["image/jpeg", "image/webp"]);
    await expect(run.send(image("image/svg+xml"))).rejects.toThrow(/image\/svg\+xml/);
  });

  it("has the fake SDK refuse a second read of a query while one waits, as its one reader (the pump) never makes one", async () => {
    const query = fake.query({ prompt: "Hello" });
    const iterator = query[Symbol.asyncIterator]();
    const first = iterator.next();
    await expect(iterator.next()).rejects.toThrow(/one read at a time/);
    query.emit(sdk.init(PROVIDER_SESSION));
    expect(await first).toMatchObject({ done: false, value: { subtype: "init" } });
  });

  it("has the fake SDK tell a test waiting for prompts when the stream ends short, rather than wait for ever", async () => {
    const query = fake.query({ prompt: (async function* () { yield { type: "user", message: { role: "user", content: "Only one" }, parent_tool_use_id: null } as never; })() });
    await expect(query.promptsPushed(2)).rejects.toThrow(/ended after 1 prompt/);
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
      // The permission table's id: an answer through the host's deliverAnswer names the same prompt.
      promptId: "toolu_rm",
      signal: expect.any(AbortSignal),
      detail: {
        toolName: "Bash",
        toolCallId: "toolu_rm",
        input: { command: "rm -rf build" },
        summary: "Claude wants to run rm -rf build",
        blockedPath: null,
        reason: null,
        questions: null,
        plan: null,
        suggestions: [],
        agentId: null,
      },
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

  it("denies at once, asking no one, when the provider withdrew the request before the adapter took it", async () => {
    const adapter = adapterWith();
    const context = contextWith();
    adapter.createRun(runInput(), context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [query.prompts[0]?.uuid as string]));
    await flush();
    const asked = query.canUseTool("Bash", { command: "ls" }, { toolUseID: "toolu_ls", signal: AbortSignal.abort() });
    expect(await asked).toMatchObject({ behavior: "deny", message: "The provider aborted this tool call." });
    expect(context.asked).toEqual([]);
  });

  it("denies a request that was waiting for a turn's owner when the process is stopped, and opens no turn for it", async () => {
    const adapter = adapterWith();
    const context = contextWith();
    const input = runInput();
    const run = adapter.createRun(input, context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]), sdk.result(PROVIDER_SESSION));
    await drain(run);
    run.release();
    // The CLI starts a turn nobody is named in yet: a request now waits for its owner (the clock is held, so it waits).
    query.emit(sdk.init(PROVIDER_SESSION));
    await flush();
    const asked = query.canUseTool("Bash", { command: "ls" }, { toolUseID: "toolu_late" });
    await flush();
    await adapter.stopProcess(SESSION);
    const late = new Promise((resolve) => setTimeout(() => resolve("still waiting"), 1_000));
    expect(await Promise.race([asked, late])).toMatchObject({ behavior: "deny", toolUseID: "toolu_late" });
    expect(context.adopted).toEqual([]);
    expect(context.asked).toEqual([]);
  });

  it("denies a tool call still parked when its run's turn ends, so a refused answer never leaves it waiting", async () => {
    const adapter = adapterWith();
    const context = contextWith();
    const input = runInput();
    const run = adapter.createRun(input, context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]));
    await flush();
    const asked = query.canUseTool("Bash", { command: "rm -rf build" }, { toolUseID: "toolu_rm" });
    await vi.waitFor(() => expect(context.asked).toHaveLength(1));
    query.emit(sdk.result(PROVIDER_SESSION));
    await drain(run);
    expect(await asked).toMatchObject({ behavior: "deny", message: "The run this tool call belonged to has ended." });
  });

  it("refuses an answer for a prompt whose run has ended, saying so, and denies the tool call rather than letting it run", async () => {
    const adapter = adapterWith();
    const context = contextWith();
    const input = runInput();
    const run = adapter.createRun(input, context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]));
    await flush();
    const asked = query.canUseTool("Bash", { command: "rm -rf build" }, { toolUseID: "toolu_rm" });
    await vi.waitFor(() => expect(context.asked).toHaveLength(1));
    (run as unknown as { end(end: { reason: "error"; error: { message: string; code: null } }): void }).end({ reason: "error", error: { message: "Ended elsewhere.", code: null } });
    expect(() => run.answerPrompt?.("toolu_rm", { decision: "allow" })).toThrow(expect.objectContaining({ reason: "run_ended" }));
    expect(await asked).toMatchObject({ behavior: "deny" });
    expect(() => run.answerPrompt?.("toolu_unknown", { decision: "allow" })).toThrow(expect.objectContaining({ reason: "not_open" }));
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

describe("the tool gate's PreToolUse hook (#140)", () => {
  /** A run in `mode` whose first turn has opened. */
  const opened = async (context: Context, overrides: Partial<RunInput> = {}) => {
    const adapter = adapterWith();
    const input = runInput(overrides);
    const run = adapter.createRun(input, context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]));
    await flush();
    return { adapter, input, run, query };
  };

  it.each(["acceptEdits", "plan", "auto", "bypassPermissions"] as const)(
    "asks the gate about every call before the provider in %s: its denial is the hook's deny, and an allow leaves the call to the provider's own evaluation",
    async (mode) => {
      const { context, checked } = gatedWith((call) => (call.tool === "Read" ? { decision: "deny", message: "Denied by containment." } : { decision: "allow" }));
      const { query } = await opened(context, { mode, ceiling: "bypassPermissions" });
      expect(await query.preToolUse("Read", { file_path: "/etc/shadow" }, { toolUseID: "toolu_read" })).toEqual(hookDenies("Denied by containment."));
      // Never allow on the provider's behalf: the mode, the rules and the provider's own prompt still decide.
      expect(await query.preToolUse("Bash", { command: "ls" }, { toolUseID: "toolu_ls" })).toEqual({});
      expect(await query.preToolUse("mcp__memory__read", { path: "notes" }, { toolUseID: "toolu_mcp" })).toEqual({});
      expect(checked.map(({ call }) => [call.toolCallId, call.tool, call.access])).toEqual([
        ["toolu_read", "Read", { kind: "read", paths: ["/etc/shadow"] }],
        ["toolu_ls", "Bash", { kind: "shell", command: "ls" }],
        ["toolu_mcp", "mcp__memory__read", { kind: "other" }],
      ]);
      expect(checked.map(({ call }) => call.input)).toEqual([{ file_path: "/etc/shadow" }, { command: "ls" }, { path: "notes" }]);
      expect(context.asked).toEqual([]);
    },
  );

  it("does not ask the gate again when the provider asks about a call the hook ruled on, and asks it about one the hook never saw", async () => {
    const { context, checked } = gatedWith(() => ({ decision: "allow" }), async () => ({ decision: "allow" }));
    const { query } = await opened(context);
    expect(await query.preToolUse("Edit", { file_path: "/work/repo/a.ts" }, { toolUseID: "toolu_edit" })).toEqual({});
    expect(await query.canUseTool("Edit", { file_path: "/work/repo/a.ts" }, { toolUseID: "toolu_edit" })).toMatchObject({ behavior: "allow" });
    expect(checked.map(({ call }) => call.toolCallId)).toEqual(["toolu_edit"]);
    expect(context.asked.map((request) => request.promptId)).toEqual(["toolu_edit"]);
    // The same call asked about again (a second prompt of the provider's) is not gated twice either.
    await query.canUseTool("Write", { file_path: "/work/repo/b.ts" }, { toolUseID: "toolu_unhooked" });
    expect(checked.map(({ call }) => call.toolCallId)).toEqual(["toolu_edit", "toolu_unhooked"]);
  });

  it("waits on a gate that parks for as long as it takes, and hands the gate the SDK's signal, which closes the prompt when the CLI gives up on the hook", async () => {
    const { context, checked } = gatedWith(
      (_call, signal) =>
        new Promise<GateDecision>((resolve) => signal?.addEventListener("abort", () => resolve({ decision: "deny", message: "The provider gave up on this call." }), { once: true })),
    );
    const { query } = await opened(context);
    const abort = new AbortController();
    const hooked = query.preToolUse("Read", { file_path: "~/.ssh/id_rsa" }, { toolUseID: "toolu_key", signal: abort.signal });
    let settled = false;
    void hooked.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    expect(checked[0]?.signal).toBe(abort.signal);
    abort.abort();
    expect(await hooked).toEqual(hookDenies("The provider gave up on this call."));
  });

  it("denies, never passes, a call the gate could not rule on: a hook that threw would leave the call to the CLI", async () => {
    const { context } = gatedWith(() => {
      throw new Error("The gate fell over.");
    });
    const { query } = await opened(context);
    const answer = await query.preToolUse("Read", { file_path: "/work/repo/a.ts" }, { toolUseID: "toolu_a" });
    expect(answer).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
    expect((answer as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason).toMatch(/could not be checked.*The gate fell over/);
  });

  it("denies at once, asking the gate nothing, once the process has been let go", async () => {
    const { context, checked } = gatedWith(() => ({ decision: "allow" }));
    const { query, run } = await opened(context);
    await run.dispose();
    expect(await query.preToolUse("Read", { file_path: "/work/repo/a.ts" })).toEqual(hookDenies("The run was stopped before this could be answered."));
    expect(checked).toEqual([]);
  });

  it("gates a subagent's call like any other, whenever it comes", async () => {
    const { context, checked } = gatedWith(() => ({ decision: "allow" }));
    const { query } = await opened(context);
    query.emit(sdk.result(PROVIDER_SESSION));
    await flush();
    // A background subagent's call between the CLI's turns: gated, and no turn is opened for it.
    expect(await query.preToolUse("Read", { file_path: "/work/repo/a.ts" }, { toolUseID: "toolu_sub", agentId: "agent_1" })).toEqual({});
    expect(checked.map(({ call }) => call.toolCallId)).toEqual(["toolu_sub"]);
    expect(context.adopted).toEqual([]);
  });
});

describe("the file tools' observation around the gate (#1182)", () => {
  /** An observer recording, in one list with the gate's calls, what it was told and when its capture finished; `capture` is how long it takes. */
  const observing = (rule: (call: GatedToolCall, signal: AbortSignal | undefined) => GateDecision | Promise<GateDecision> = () => ({ decision: "allow" }), capture: (call: FileToolCall) => Promise<void> = async () => undefined) => {
    const order: string[] = [];
    const told: { readonly what: string; readonly call: FileToolCall; readonly signal?: AbortSignal }[] = [];
    const observer: FileChangeObserver = {
      before: async (call, signal) => {
        order.push(`before ${call.toolCallId}`);
        told.push({ what: "before", call, signal });
        await capture(call);
        order.push(`captured ${call.toolCallId}`);
      },
      completed: async (call, signal) => {
        order.push(`completed ${call.toolCallId}`);
        told.push({ what: "completed", call, signal });
      },
      failed: (call) => {
        order.push(`failed ${call.toolCallId}`);
        told.push({ what: "failed", call });
      },
    };
    const gated = gatedWith(async (call, signal) => {
      order.push(`gate ${call.toolCallId}`);
      return rule(call, signal);
    });
    return { context: { ...gated.context, fileChanges: observer }, order, told };
  };

  /** A run whose first turn has opened on `context`. */
  const opened = async (context: Context, adapter = adapterWith()) => {
    const input = runInput();
    const run = adapter.createRun(input, context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]));
    await flush();
    return { adapter, run, query };
  };

  it.each([
    ["Edit", { file_path: "/work/repo/a.ts", old_string: "a", new_string: "b" }, ["/work/repo/a.ts"]],
    ["MultiEdit", { file_path: "/work/repo/a.ts", edits: [{ old_string: "a", new_string: "b" }] }, ["/work/repo/a.ts"]],
    ["MultiEdit", { edits: [{ file_path: "z.ts", old_string: "z", new_string: "Z" }, { file_path: "a.ts", old_string: "a", new_string: "A" }, { file_path: "z.ts", old_string: "Z", new_string: "ZZ" }] }, ["z.ts", "a.ts"]],
    ["Write", { file_path: "src/new.ts", content: "export {};" }, ["src/new.ts"]],
    ["NotebookEdit", { notebook_path: "/work/repo/book.ipynb", new_source: "print(1)" }, ["/work/repo/book.ipynb"]],
  ] as const)("captures before a %s the gate let through writes, and reports its completion with the call and path it announced", async (tool, toolInput, paths) => {
    let finishCapture: () => void = () => undefined;
    const { context, order, told } = observing(undefined, () => new Promise((resolve) => (finishCapture = resolve)));
    const { query } = await opened(context);
    const abort = new AbortController();
    const hooked = query.preToolUse(tool, toolInput, { toolUseID: "toolu_file", signal: abort.signal });
    let answered = false;
    void hooked.then(() => (answered = true));
    await flush();
    // The CLI runs the call once the hook answers: not before the capture has finished.
    expect(order).toEqual(["gate toolu_file", "before toolu_file"]);
    expect(answered).toBe(false);
    finishCapture();
    expect(await hooked).toEqual({});
    expect(told[0]).toEqual({ what: "before", call: { toolCallId: "toolu_file", tool, paths, cwd: "/work/repo" }, signal: abort.signal });
    await query.postToolUse(tool, toolInput, { type: "update" }, { toolUseID: "toolu_file" });
    expect(order).toEqual(["gate toolu_file", "before toolu_file", "captured toolu_file", "completed toolu_file"]);
    expect(told[1]?.call).toBe(told[0]?.call);
  });

  it("observes nothing of a call the gate denies, nor of a gate prompt until it is answered, nor of a call the CLI gave up on", async () => {
    let allow: () => void = () => undefined;
    const { context, order, told } = observing((call, signal) => {
      if (call.toolCallId === "toolu_denied") return { decision: "deny", message: "Denied by containment." };
      if (call.toolCallId === "toolu_given_up")
        return new Promise((resolve) => signal?.addEventListener("abort", () => resolve({ decision: "deny", message: "The provider gave up on this call." }), { once: true }));
      return new Promise((resolve) => (allow = () => resolve({ decision: "allow" })));
    });
    const { query } = await opened(context);
    expect(await query.preToolUse("Write", { file_path: "/etc/passwd", content: "" }, { toolUseID: "toolu_denied" })).toEqual(hookDenies("Denied by containment."));
    const abort = new AbortController();
    const givenUp = query.preToolUse("Edit", { file_path: "/work/repo/a.ts" }, { toolUseID: "toolu_given_up", signal: abort.signal });
    const parked = query.preToolUse("Edit", { file_path: "/work/repo/b.ts" }, { toolUseID: "toolu_parked" });
    await flush();
    expect(told).toEqual([]);
    abort.abort();
    expect(await givenUp).toEqual(hookDenies("The provider gave up on this call."));
    allow();
    expect(await parked).toEqual({});
    expect(order).toEqual(["gate toolu_denied", "gate toolu_given_up", "gate toolu_parked", "before toolu_parked", "captured toolu_parked"]);
  });

  it("reports a file tool that failed as failed, never as a completed change", async () => {
    const { context, order } = observing();
    const { query } = await opened(context);
    await query.preToolUse("Edit", { file_path: "/work/repo/a.ts", old_string: "missing", new_string: "b" }, { toolUseID: "toolu_edit" });
    await query.postToolUseFailure("Edit", { file_path: "/work/repo/a.ts", old_string: "missing", new_string: "b" }, "String to replace not found in file.", { toolUseID: "toolu_edit" });
    await query.postToolUse("Edit", { file_path: "/work/repo/a.ts", old_string: "missing", new_string: "b" }, {}, { toolUseID: "toolu_edit" });
    expect(order).toEqual(["gate toolu_edit", "before toolu_edit", "captured toolu_edit", "failed toolu_edit"]);
  });

  it("observes no other tool, no shell command's writes, no file call naming no path or no id, and no completion it was never told of", async () => {
    const { context, order, told } = observing();
    const { query } = await opened(context);
    const calls = [
      ["Bash", { command: "sed -i s/a/b/ a.ts > b.ts" }, "toolu_shell"],
      ["Read", { file_path: "/work/repo/a.ts" }, "toolu_read"],
      ["mcp__files__write", { file_path: "/work/repo/a.ts" }, "toolu_mcp"],
      ["Write", { content: "no path" }, "toolu_nopath"],
      ["Edit", { file_path: "/work/repo/a.ts" }, ""],
    ] as const;
    for (const [tool, toolInput, toolUseID] of calls) {
      expect(await query.preToolUse(tool, toolInput, { toolUseID })).toEqual({});
      await query.postToolUse(tool, toolInput, {}, { toolUseID });
    }
    // A completion of a recognised tool's call that was never announced: the gate never saw it, so nothing was captured.
    await query.postToolUse("Write", { file_path: "/work/repo/c.ts", content: "" }, {}, { toolUseID: "toolu_unannounced" });
    await query.postToolUseFailure("Write", { file_path: "/work/repo/c.ts", content: "" }, "Failed.", { toolUseID: "toolu_unannounced" });
    expect(told).toEqual([]);
    expect(order).toEqual(["gate toolu_shell", "gate toolu_read", "gate toolu_mcp", "gate toolu_nopath", expect.stringMatching(/^gate /)]);
  });

  it("reports a call that ran on another path than it announced as failed: its capture is not of what changed", async () => {
    const { context, order } = observing();
    const { query } = await opened(context);
    await query.preToolUse("Write", { file_path: "/work/repo/a.ts", content: "x" }, { toolUseID: "toolu_write" });
    // Another hook rewrote the call's input after this one read it.
    await query.postToolUse("Write", { file_path: "/work/repo/elsewhere.ts", content: "x" }, {}, { toolUseID: "toolu_write" });
    expect(order).toEqual(["gate toolu_write", "before toolu_write", "captured toolu_write", "failed toolu_write"]);
  });

  it("lets the call go on when the capture fails, logs it, and still reports how the call ended", async () => {
    const { context, order } = observing(undefined, async () => {
      throw new Error("The disk is full.");
    });
    const { query } = await opened(context);
    expect(await query.preToolUse("Edit", { file_path: "/work/repo/a.ts" }, { toolUseID: "toolu_edit" })).toEqual({});
    expect(diagnostics.some((line) => line.includes("toolu_edit") && line.includes("The disk is full."))).toBe(true);
    await query.postToolUse("Edit", { file_path: "/work/repo/a.ts" }, {}, { toolUseID: "toolu_edit" });
    expect(order).toEqual(["gate toolu_edit", "before toolu_edit", "completed toolu_edit"]);
  });

  it("answers the file hooks as before when the run has no observer", async () => {
    const { context, checked } = gatedWith(() => ({ decision: "allow" }));
    const { query } = await opened(context);
    expect(await query.preToolUse("Edit", { file_path: "/work/repo/a.ts" }, { toolUseID: "toolu_edit" })).toEqual({});
    expect(await query.postToolUse("Edit", { file_path: "/work/repo/a.ts" }, {}, { toolUseID: "toolu_edit" })).toEqual({});
    expect(await query.postToolUseFailure("Edit", { file_path: "/work/repo/a.ts" }, "Failed.", { toolUseID: "toolu_edit" })).toEqual({});
    expect(checked.map(({ call }) => call.toolCallId)).toEqual(["toolu_edit"]);
  });

  it("tells the observer a call announced on a process that then ends has failed", async () => {
    const { context, order } = observing();
    const { query, run } = await opened(context);
    await query.preToolUse("Edit", { file_path: "/work/repo/a.ts" }, { toolUseID: "toolu_edit" });
    await run.dispose();
    expect(order).toEqual(["gate toolu_edit", "before toolu_edit", "captured toolu_edit", "failed toolu_edit"]);
  });

  it("observes a kept process's next run through that run's observer, and ends a call announced before it on the observer that was told of it", async () => {
    const first = observing();
    const adapter = adapterWith();
    const input = runInput();
    const run = adapter.createRun(input, first.context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]));
    await flush();
    // A background subagent's edit, announced during the first run, ends after the next one has joined the process.
    await query.preToolUse("Edit", { file_path: "/work/repo/a.ts" }, { toolUseID: "toolu_sub", agentId: "agent_1" });
    query.emit(sdk.tasks({ task_id: "task_1" }), sdk.result(PROVIDER_SESSION));
    await drain(run);
    run.release();
    const second = observing();
    const next = runInput({ target: { kind: "resume", providerSessionId: PROVIDER_SESSION } });
    adapter.createRun(next, second.context);
    await query.promptsPushed(2);
    expect(fake.queries).toHaveLength(1);
    await query.postToolUse("Edit", { file_path: "/work/repo/a.ts" }, {}, { toolUseID: "toolu_sub", agentId: "agent_1" });
    await query.preToolUse("Write", { file_path: "/work/repo/b.ts", content: "" }, { toolUseID: "toolu_next" });
    await query.postToolUse("Write", { file_path: "/work/repo/b.ts", content: "" }, {}, { toolUseID: "toolu_next" });
    expect(first.order).toEqual(["gate toolu_sub", "before toolu_sub", "captured toolu_sub", "completed toolu_sub"]);
    expect(second.order).toEqual(["gate toolu_next", "before toolu_next", "captured toolu_next", "completed toolu_next"]);
  });

  it("keeps the Stop hook on a kept process, and every tool hook and the Stop hook on the cold start after it", async () => {
    const adapter = adapterWith();
    const input = runInput();
    const run = adapter.createRun(input, observing().context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]), sdk.toolUse("toolu_cron", "CronCreate"), sdk.toolResult("toolu_cron"), sdk.result(PROVIDER_SESSION));
    await drain(run);
    run.release();
    // Kept by the schedule: the next run joins the process, whose Stop hook still follows the CLI's list of schedules.
    const next = runInput({ target: { kind: "resume", providerSessionId: PROVIDER_SESSION } });
    const joined = adapter.createRun(next, observing().context);
    await query.promptsPushed(2);
    expect(fake.queries).toHaveLength(1);
    const stop = query.options.hooks?.Stop?.[0]?.hooks[0];
    await stop?.({ hook_event_name: "Stop", session_id: "s", transcript_path: "", cwd: "/work/repo", stop_hook_active: false, session_crons: [] } as never, undefined, { signal: new AbortController().signal });
    expect(port).toEqual(["hold schedule:claude-schedules", "unhold schedule:claude-schedules"]);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_2", [next.prompt[0]?.messageId as string]), sdk.result(PROVIDER_SESSION));
    await drain(joined);
    joined.release();
    await adapter.stopProcess(SESSION);
    // A cold start registers the same hooks, gating and observing through its own run's context.
    const cold = observing();
    adapter.createRun(runInput({ target: { kind: "resume", providerSessionId: PROVIDER_SESSION } }), cold.context);
    const fresh = await started(2);
    expect(Object.keys(fresh.options.hooks ?? {})).toEqual(Object.keys(query.options.hooks ?? {}));
    expect(Object.keys(fresh.options.hooks ?? {})).toEqual(["PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop"]);
    expect(await fresh.preToolUse("Edit", { file_path: "/work/repo/a.ts" }, { toolUseID: "toolu_cold" })).toEqual({});
    await fresh.postToolUse("Edit", { file_path: "/work/repo/a.ts" }, {}, { toolUseID: "toolu_cold" });
    expect(cold.order).toEqual(["gate toolu_cold", "before toolu_cold", "captured toolu_cold", "completed toolu_cold"]);
  });
});

describe("an in-process tool's declared access and its images (#540)", () => {
  /** A red pixel's bytes, as a tool's screenshot would carry them (not a real image: the adapter passes bytes on unread). */
  const SHOT = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

  /** A browser-shaped server built afresh, as the factory builds one per run: open declares browse, read declares fetch, close declares nothing. */
  const browserServer = (calls: string[] = []): InProcessToolServer => ({
    name: "browser",
    external: false,
    tools: [
      {
        name: "browser_open",
        description: "Opens a page.",
        inputSchema: { type: "object", properties: { address: { type: "string" } } },
        access: (input) => ({ kind: "browse", urls: typeof input["address"] === "string" ? [input["address"]] : [] }),
        call: async (input) => {
          calls.push(`open ${String(input["address"])}`);
          return { text: "Opened.", isError: false };
        },
      },
      {
        name: "web_read",
        description: "Reads a page without a browser.",
        inputSchema: { type: "object", properties: { url: { type: "string" } } },
        access: (input) => ({ kind: "fetch", urls: typeof input["url"] === "string" ? [input["url"]] : [] }),
        call: async () => ({ text: "Read.", isError: false }),
      },
      { name: "browser_close", description: "Lets the page go.", inputSchema: { type: "object", properties: {} }, call: async () => ({ text: "Closed.", isError: false }) },
      {
        name: "browser_screenshot",
        description: "A screenshot.",
        inputSchema: { type: "object", properties: {} },
        call: async () => ({ text: "The page at https://example.com/.", isError: false, images: [{ mediaType: "image/jpeg", data: SHOT }] }),
      },
    ],
  });

  const opened = async (context: Context, overrides: Partial<RunInput> = {}) => {
    const adapter = adapterWith();
    const input = runInput({ toolServers: [browserServer()], ...overrides });
    const run = adapter.createRun(input, context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]));
    await flush();
    return { adapter, input, run, query };
  };

  it("hands the gate what the tool declares from the hook, naming the address in the summary, and other for a tool that declares nothing", async () => {
    const { context, checked } = gatedWith(() => ({ decision: "allow" }));
    const { query } = await opened(context);
    expect(await query.preToolUse("mcp__browser__browser_open", { address: "https://www.paypal.com/" }, { toolUseID: "toolu_open" })).toEqual({});
    expect(await query.preToolUse("mcp__browser__web_read", { url: "http://169.254.169.254/latest" }, { toolUseID: "toolu_read" })).toEqual({});
    expect(await query.preToolUse("mcp__browser__browser_close", { address: "https://www.paypal.com/" }, { toolUseID: "toolu_close" })).toEqual({});
    expect(checked.map(({ call }) => call)).toEqual([
      {
        toolCallId: "toolu_open",
        tool: "mcp__browser__browser_open",
        summary: "mcp__browser__browser_open https://www.paypal.com/",
        access: { kind: "browse", urls: ["https://www.paypal.com/"] },
        input: { address: "https://www.paypal.com/" },
      },
      {
        toolCallId: "toolu_read",
        tool: "mcp__browser__web_read",
        summary: "mcp__browser__web_read http://169.254.169.254/latest",
        access: { kind: "fetch", urls: ["http://169.254.169.254/latest"] },
        input: { url: "http://169.254.169.254/latest" },
      },
      {
        toolCallId: "toolu_close",
        tool: "mcp__browser__browser_close",
        summary: "mcp__browser__browser_close",
        access: { kind: "other" },
        input: { address: "https://www.paypal.com/" },
      },
    ]);
  });

  it("hands the gate the declared access from canUseTool too, for a call the hook never saw, and the gate's denial is the provider's", async () => {
    const { context, checked } = gatedWith((call) => (call.access.kind === "fetch" ? { decision: "deny", message: "Denied by containment: no network." } : { decision: "allow" }));
    const { query } = await opened(context);
    expect(await query.canUseTool("mcp__browser__web_read", { url: "https://example.com/" }, { toolUseID: "toolu_unhooked" })).toMatchObject({
      behavior: "deny",
      message: "Denied by containment: no network.",
    });
    expect(checked.map(({ call }) => [call.toolCallId, call.access])).toEqual([["toolu_unhooked", { kind: "fetch", urls: ["https://example.com/"] }]]);
  });

  it("keeps a session's process for a run whose tools are built afresh with the same declarations, and reads its calls as declared", async () => {
    const adapter = adapterWith();
    const { context, checked } = gatedWith(() => ({ decision: "allow" }));
    const input = runInput({ toolServers: [browserServer()] });
    const run = adapter.createRun(input, context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]), sdk.toolUse("toolu_cron", "CronCreate", { cron: "0 * * * *" }), sdk.toolResult("toolu_cron"), sdk.result(PROVIDER_SESSION));
    await drain(run);
    run.release();
    const next = adapter.createRun(runInput({ toolServers: [browserServer()], target: { kind: "resume", providerSessionId: PROVIDER_SESSION } }), context);
    const prompts = await query.promptsPushed(2);
    expect(fake.queries).toHaveLength(1);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_2", [prompts[1]?.uuid as string]));
    await flush();
    await query.preToolUse("mcp__browser__browser_open", { address: "https://example.com/" }, { toolUseID: "toolu_next" });
    expect(checked.map(({ call }) => call.access)).toEqual([{ kind: "browse", urls: ["https://example.com/"] }]);
    query.emit(sdk.result(PROVIDER_SESSION));
    await drain(next);
  });

  it("answers an image result as image content after the text, which the CLI receives beside it, and a text-only result as text alone", async () => {
    const { query } = await opened(contextWith());
    const shot = await query.callTool("browser", "browser_screenshot", {}, "toolu_shot");
    expect(shot.content).toEqual([
      { type: "text", text: "The page at https://example.com/." },
      { type: "image", data: Buffer.from(SHOT).toString("base64"), mimeType: "image/jpeg" },
    ]);
    expect(shot.isError).toBeUndefined();
    expect((await query.callTool("browser", "browser_open", { address: "https://example.com/" })).content).toEqual([{ type: "text", text: "Opened." }]);
  });
});

describe("the sandbox's ask for a host (SandboxNetworkAccess)", () => {
  const workspace: RunInput["containment"] = {
    level: "workspace",
    mechanism: "bubblewrap",
    scratchDirectory: "/data/containment/session/scratch",
    temporaryDirectory: "/data/containment/session/tmp",
    writable: ["/work/repo", "/data/containment/session/scratch", "/data/containment/session/tmp"],
    readOnly: [],
    network: true,
  };

  it("is answered by the adapter once the gate lets the host through, asking nobody: the network is open at workspace", async () => {
    const { context, checked } = gatedWith((call) => (call.access.kind === "fetch" && call.access.urls.includes("169.254.169.254") ? { decision: "deny", message: "Denylisted." } : { decision: "allow" }));
    const input = runInput({ containment: workspace });
    adapterWith().createRun(input, context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]));
    await flush();
    expect(await query.canUseTool("SandboxNetworkAccess", { host: "registry.npmjs.org" }, { toolUseID: "net_1", title: "Allow network connection to registry.npmjs.org?" })).toEqual({
      behavior: "allow",
      updatedInput: { host: "registry.npmjs.org" },
      toolUseID: "net_1",
    });
    expect(await query.canUseTool("SandboxNetworkAccess", { host: "169.254.169.254" }, { toolUseID: "net_2" })).toEqual({ behavior: "deny", message: "Denylisted.", toolUseID: "net_2" });
    expect(checked.map(({ call }) => [call.tool, call.access])).toEqual([
      ["SandboxNetworkAccess", { kind: "fetch", urls: ["registry.npmjs.org"] }],
      ["SandboxNetworkAccess", { kind: "fetch", urls: ["169.254.169.254"] }],
    ]);
    expect(context.asked).toEqual([]);
  });

  it("opens no turn for an ask that comes between the CLI's turns, from a command still running in the background", async () => {
    const { context } = gatedWith(() => ({ decision: "allow" }));
    const input = runInput({ containment: workspace });
    const run = adapterWith().createRun(input, context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]), sdk.result(PROVIDER_SESSION));
    await drain(run);
    expect(await query.canUseTool("SandboxNetworkAccess", { host: "github.com" }, { toolUseID: "net_3" })).toMatchObject({ behavior: "allow" });
    expect(context.adopted).toEqual([]);
    expect(context.asked).toEqual([]);
  });
});

describe("an approved plan", () => {
  it("leaves the process in the mode it continues in, so a later run in plan moves the CLI back to plan", async () => {
    const adapter = adapterWith();
    const context = contextWith(async (request) => (request.kind === "plan" ? { decision: "allow", mode: "acceptEdits" } : { decision: "deny" }));
    const input = runInput({ mode: "plan" });
    const first = adapter.createRun(input, context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]));
    await flush();
    expect(await query.canUseTool("ExitPlanMode", { plan: "1. Read" }, { toolUseID: "toolu_plan" })).toMatchObject({
      behavior: "allow",
      updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    });
    query.emit(sdk.result(PROVIDER_SESSION));
    await drain(first);
    first.release();
    // The CLI is in acceptEdits now: a run that asks for acceptEdits sends nothing, and one that asks for plan moves it back.
    const second = adapter.createRun(runInput({ mode: "acceptEdits", target: { kind: "resume", providerSessionId: PROVIDER_SESSION } }), context);
    await query.promptsPushed(2);
    expect(query.modes).toEqual([]);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_2", [query.prompts[1]?.uuid as string]), sdk.result(PROVIDER_SESSION));
    await drain(second);
    second.release();
    adapter.createRun(runInput({ mode: "plan", target: { kind: "resume", providerSessionId: PROVIDER_SESSION } }), context);
    await query.promptsPushed(3);
    expect(query.modes).toEqual(["plan"]);
  });
});

describe("under auto", () => {
  it("hands the classifier's fallback prompt to the broker as a permission prompt with the provider's reason", async () => {
    const adapter = adapterWith();
    const context = contextWith(async () => ({ decision: "allow" }));
    const input = runInput({ mode: "auto", ceiling: "auto" });
    adapter.createRun(input, context);
    const query = await started();
    expect(query.options.permissionMode).toBe("auto");
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]));
    await flush();
    await query.canUseTool("Bash", { command: "npm publish" }, { toolUseID: "toolu_publish", decisionReason: "The classifier could not rule on this: publishing needs approval." });
    expect(context.asked).toEqual([
      expect.objectContaining({ kind: "permission", promptId: "toolu_publish", detail: expect.objectContaining({ reason: "The classifier could not rule on this: publishing needs approval." }) }),
    ]);
  });
});

describe("stopping delegated work", () => {
  it("stops a task through the SDK, bounded by the control timeout: a stop that never answers is refused after it, and the run goes on", async () => {
    fake.controls = { stopTask: () => new Promise<void>(() => undefined) };
    const adapter = adapterWith();
    const input = runInput();
    const run = adapter.createRun(input, contextWith());
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]), sdk.tasks({ task_id: "task_1" }));
    await flush();
    const stopping = Promise.resolve(run.stopTask?.("task_1")).then(
      () => "stopped",
      (error: unknown) => (error as Error).message,
    );
    await flush();
    expect(query.stoppedTasks).toEqual(["task_1"]);
    clock.advance(DEFAULT_TIMINGS.controlTimeoutMs);
    expect(await stopping).toMatch(/No answer after/);
    expect(query.closed).toBe(false);
    query.emit(sdk.result(PROVIDER_SESSION));
    expect(ends(await drain(run))).toEqual([expect.objectContaining({ reason: "completed" })]);
  });

  it("refuses to stop a task on a process that has been stopped", async () => {
    const adapter = adapterWith();
    const input = runInput();
    const run = adapter.createRun(input, contextWith());
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]), sdk.tasks({ task_id: "task_1" }));
    await flush();
    await adapter.stopProcess(SESSION);
    await expect(Promise.resolve(run.stopTask?.("task_1"))).rejects.toThrow(/closing/);
    expect(query.stoppedTasks).toEqual([]);
  });
});

describe("a mode change on a live run", () => {
  it("is declared: the descriptor has modeChange", () => {
    expect(CLAUDE_DESCRIPTOR.modeChange).toBe(true);
  });

  it("reaches the SDK's mode setter once per change, and the next run on the process is not moved again", async () => {
    const adapter = adapterWith();
    const input = runInput();
    const run = adapter.createRun(input, contextWith());
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]));
    await flush();
    await run.setMode?.("plan");
    await run.setMode?.("plan");
    expect(query.modes).toEqual(["plan"]);
    query.emit(sdk.result(PROVIDER_SESSION));
    await drain(run);
    run.release();
    const next = runInput({ mode: "plan", target: { kind: "resume", providerSessionId: PROVIDER_SESSION } });
    adapter.createRun(next, contextWith());
    await query.promptsPushed(2);
    expect(query.modes).toEqual(["plan"]);
  });

  it("applies a change made before the process spawned to the spawn itself", async () => {
    fake.stored.set(PROVIDER_SESSION, [
      { type: "user", uuid: "p1", message: { role: "user", content: "First" } },
      { type: "assistant", uuid: "a1", message: { role: "assistant", content: [] } },
      { type: "user", uuid: "p2", message: { role: "user", content: "Second" } },
    ]);
    let read: () => void = () => undefined;
    const reading = new Promise<void>((resolve) => (read = resolve));
    hooks.sdk = { query: fake.query, getSessionMessages: async (id: string, options: unknown) => (await reading, fake.getSessionMessages(id, options)) };
    const run = adapterWith().createRun(runInput({ target: { kind: "fork", providerSessionId: PROVIDER_SESSION, atMessageId: "p2" } }), contextWith());
    await run.setMode?.("plan");
    read();
    const query = await started();
    expect(query.options.permissionMode).toBe("plan");
    expect(query.modes).toEqual([]);
  });

  it("refuses bypass on a process spawned without the opt-in, and a change on an ended run", async () => {
    const adapter = adapterWith();
    const input = runInput();
    const run = adapter.createRun(input, contextWith());
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]));
    await flush();
    await expect(run.setMode?.("bypassPermissions")).rejects.toThrow(/bypass/);
    query.emit(sdk.result(PROVIDER_SESSION));
    await drain(run);
    await expect(run.setMode?.("plan")).rejects.toThrow(/ended/);
    expect(query.modes).toEqual([]);
  });

  it("waits for the move onto a run that is under way, so the CLI and the record both end in the change", async () => {
    let release: () => void = () => undefined;
    fake.controls = { flagSettings: () => new Promise<void>((resolve) => (release = resolve)) };
    const adapter = adapterWith();
    const context = contextWith();
    const input = runInput();
    const first = adapter.createRun(input, context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]), sdk.result(PROVIDER_SESSION));
    await drain(first);
    first.release();
    // The next run moves the process to plan and high effort; the effort call is held.
    const second = adapter.createRun(runInput({ mode: "plan", effort: "high", target: { kind: "resume", providerSessionId: PROVIDER_SESSION } }), context);
    await vi.waitFor(() => expect(query.flags).toHaveLength(1));
    expect(query.modes).toEqual(["plan"]);
    const changed = second.setMode?.("acceptEdits");
    await flush();
    release();
    await changed;
    expect(query.modes).toEqual(["plan", "acceptEdits"]);
    await query.promptsPushed(2);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_2", [query.prompts[1]?.uuid as string]), sdk.result(PROVIDER_SESSION));
    await drain(second);
    second.release();
    // The record says acceptEdits, as the CLI is: a run asking for plan moves it again.
    adapter.createRun(runInput({ mode: "plan", effort: "high", target: { kind: "resume", providerSessionId: PROVIDER_SESSION } }), context);
    await query.promptsPushed(3);
    expect(query.modes).toEqual(["plan", "acceptEdits", "plan"]);
  });

  it("takes bypass on a process spawned under a bypass ceiling", async () => {
    const adapter = adapterWith();
    const input = runInput({ ceiling: "bypassPermissions" });
    const run = adapter.createRun(input, contextWith());
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]));
    await flush();
    await run.setMode?.("bypassPermissions");
    expect(query.modes).toEqual(["bypassPermissions"]);
  });
});

describe("a withdraw", () => {
  it("withdraws a queued message through the cancel-by-id control, so an interrupt never hands it back", async () => {
    const steer = message("Wait, do this instead");
    const other = message("And this");
    fake.controls = {
      interruptReceipt: async () => ({ still_queued: [], cancelled: [other.messageId] }),
      cancelled: (uuid) => uuid === steer.messageId,
    };
    const adapter = adapterWith();
    const run = adapter.createRun(runInput(), contextWith());
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [query.prompts[0]?.uuid as string]));
    await flush();
    await run.send(steer);
    await run.send(other);
    expect(await run.withdraw?.(steer.messageId)).toEqual({ withdrawn: true });
    expect(query.cancelRequests).toEqual([steer.messageId]);
    // Only what the CLI still held is handed back; the withdrawn one is gone.
    expect(await run.interrupt()).toEqual({ stillQueued: [other.messageId] });
  });

  it("answers not withdrawn when the CLI says it no longer holds the message: it was read", async () => {
    const steer = message("Wait, do this instead");
    fake.controls = { cancelled: () => false };
    const adapter = adapterWith();
    const run = adapter.createRun(runInput(), contextWith());
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [query.prompts[0]?.uuid as string]));
    await flush();
    await run.send(steer);
    expect(await run.withdraw?.(steer.messageId)).toEqual({ withdrawn: false });
    expect(query.cancelRequests).toEqual([steer.messageId]);
  });

  it("answers not withdrawn, asking the CLI nothing, for a message a turn has been seen reading", async () => {
    const steer = message("Also check the tests");
    fake.controls = { cancelled: () => true };
    const adapter = adapterWith();
    const input = runInput();
    const run = adapter.createRun(input, contextWith());
    const query = await started();
    const promptId = input.prompt[0]?.messageId as string;
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [promptId]));
    await run.send(steer);
    await query.promptsPushed(2);
    query.emit(sdk.text("msg_2", "Checking the tests too.", [promptId, steer.messageId]));
    await flush();
    expect(await run.withdraw?.(steer.messageId)).toEqual({ withdrawn: false });
    expect(query.cancelRequests).toEqual([]);
  });

  it("takes a message back from the prompt pump before the CLI has read it, asking the CLI nothing", async () => {
    fake.controls = { cancelled: () => true };
    const adapter = adapterWith();
    const run = adapter.createRun(runInput(), contextWith());
    // Sent before the process has spawned, and withdrawn before the SDK reads the pump.
    const early = message("Sent before the spawn");
    const sending = run.send(early);
    const withdrawing = run.withdraw?.(early.messageId);
    await sending;
    expect(await withdrawing).toEqual({ withdrawn: true });
    const query = await started();
    await flush();
    expect(query.prompts.map((prompt) => prompt.uuid)).not.toContain(early.messageId);
    expect(query.cancelRequests).toEqual([]);
  });

  it("refuses when the SDK has no cancel-by-id control: the message cannot be taken back", async () => {
    const steer = message("Wait, do this instead");
    const adapter = adapterWith();
    const run = adapter.createRun(runInput(), contextWith());
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [query.prompts[0]?.uuid as string]));
    await flush();
    await run.send(steer);
    await query.promptsPushed(2);
    await expect(run.withdraw?.(steer.messageId)).rejects.toThrow(WithdrawUnsupported);
    expect(query.cancelRequests).toEqual([]);
  });

  it("remembers a cancel it sent that timed out: the withdraw throws, and asked again it answers withdrawn without asking the CLI twice", async () => {
    const steer = message("Wait, do this instead");
    fake.controls = { cancelled: () => new Promise<boolean>(() => undefined) };
    const adapter = adapterWith();
    const run = adapter.createRun(runInput(), contextWith());
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [query.prompts[0]?.uuid as string]));
    await flush();
    await run.send(steer);
    await query.promptsPushed(2);
    const first = run.withdraw?.(steer.messageId);
    await vi.waitFor(() => expect(query.cancelRequests).toEqual([steer.messageId]));
    clock.advance(DEFAULT_TIMINGS.controlTimeoutMs);
    await expect(first).rejects.toThrow(/did not answer the withdraw/);
    // The CLI may have cancelled it all the same: asked again, it is withdrawn, and no second cancel is sent.
    expect(await run.withdraw?.(steer.messageId)).toEqual({ withdrawn: true });
    expect(query.cancelRequests).toEqual([steer.messageId]);
    // And no interrupt hands it back.
    fake.controls = { ...fake.controls, interruptReceipt: async () => ({ still_queued: [], cancelled: [] }) };
    expect(await run.interrupt()).toEqual({ stillQueued: [] });
  });

  it("answers withdrawn again for a message it cancelled, where the CLI would now say it holds nothing", async () => {
    const steer = message("Wait, do this instead");
    let asked = 0;
    fake.controls = { cancelled: () => ++asked === 1 };
    const adapter = adapterWith();
    const run = adapter.createRun(runInput(), contextWith());
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [query.prompts[0]?.uuid as string]));
    await flush();
    await run.send(steer);
    expect(await run.withdraw?.(steer.messageId)).toEqual({ withdrawn: true });
    expect(await run.withdraw?.(steer.messageId)).toEqual({ withdrawn: true });
    expect(query.cancelRequests).toEqual([steer.messageId]);
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
      used.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart(`msg_${randomUUID()}`, [input.prompt[0]?.messageId as string]), ...extra, sdk.result(PROVIDER_SESSION));
      const done = await events.done;
      run.release();
      return done;
    } };
  };

  it("keeps the process when its run is released, holding nothing, until the pool stops it", async () => {
    const adapter = adapterWith();
    const turn = await oneTurn(adapter, runInput());
    await turn.finish();
    expect(turn.query.closed).toBe(false);
    expect(port).toEqual([]);
    await adapter.stopProcess(SESSION);
    expect(turn.query.closed).toBe(true);
    expect(turn.query.promptEnded).toBe(true);
    // The pool stopped it: no exit of its own is reported.
    expect(port).toEqual([]);
  });

  it("keeps the process while a background task outlives the turn, and serves the next run on it with no second spawn", async () => {
    const adapter = adapterWith();
    const first = await oneTurn(adapter, runInput());
    await first.finish(sdk.tasks({ task_id: "task_1", description: "Explore" }));
    expect(first.query.closed).toBe(false);
    expect(port).toEqual(["hold task:task_1"]);
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

  /** A result's `modelUsage`: the process's spend since it started, as the CLI counts it (#1949). */
  const spentSoFar = (inputTokens: number, outputTokens: number, cacheReadInputTokens: number, costUSD: number) => ({
    "claude-haiku-4-5": { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens: 40, costUSD, contextWindow: 200000 },
  });
  const turnSpend = (inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, costUsd: number) => [
    { model: "claude-haiku-4-5", inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, contextWindow: 200000 },
  ];
  const usageOf = (events: AdapterEvent[]) => events.flatMap((event) => (event.type === "usage.reported" ? [event.payload.models] : event.type === "end" ? [event.usage] : []));

  it("reports each turn's own spend, the difference from the kept process's last cumulative reading, and starts again on a new process", async () => {
    const adapter = adapterWith();
    const opening = runInput();
    const first = await oneTurn(adapter, opening);
    first.query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [opening.prompt[0]?.messageId as string]), sdk.result(PROVIDER_SESSION, { modelUsage: spentSoFar(100, 379, 47000, 0.25) }));
    expect(usageOf(await first.events.done)).toEqual([turnSpend(100, 379, 47000, 40, 0.25), turnSpend(100, 379, 47000, 40, 0.25)]);
    first.run.release();
    const next = runInput({ target: { kind: "resume", providerSessionId: PROVIDER_SESSION } });
    const second = await oneTurn(adapter, next, first.query);
    first.query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_2", [next.prompt[0]?.messageId as string]), sdk.result(PROVIDER_SESSION, { modelUsage: spentSoFar(130, 2679, 71000, 0.375) }));
    // The second turn's own: 30 in, 2,300 out, 24,000 cache reads and nothing written, $0.125; never the process's running total.
    expect(usageOf(await second.events.done)).toEqual([turnSpend(30, 2300, 24000, 0, 0.125), turnSpend(30, 2300, 24000, 0, 0.125)]);
    second.run.release();
    await adapter.stopProcess(SESSION);
    const fresh = runInput({ target: { kind: "resume", providerSessionId: PROVIDER_SESSION } });
    const third = await oneTurn(adapter, fresh);
    expect(third.query).not.toBe(first.query);
    third.query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_3", [fresh.prompt[0]?.messageId as string]), sdk.result(PROVIDER_SESSION, { modelUsage: spentSoFar(500, 3000, 80000, 0.5) }));
    // A new process counts from nothing: its first reading is its first turn's whole.
    expect(usageOf(await third.events.done)).toEqual([turnSpend(500, 3000, 80000, 40, 0.5), turnSpend(500, 3000, 80000, 40, 0.5)]);
  });

  it("reports none for a turn stopped before it spent anything, never the turn before's figures", async () => {
    const adapter = adapterWith();
    const opening = runInput();
    const first = await oneTurn(adapter, opening);
    first.query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [opening.prompt[0]?.messageId as string]), sdk.result(PROVIDER_SESSION, { modelUsage: spentSoFar(100, 2679, 71000, 0.375) }));
    await first.events.done;
    first.run.release();
    const next = runInput({ target: { kind: "resume", providerSessionId: PROVIDER_SESSION } });
    const stopped = await oneTurn(adapter, next, first.query);
    first.query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_2", [next.prompt[0]?.messageId as string]));
    await vi.waitFor(() => expect(stopped.events.events.length).toBeGreaterThan(0));
    expect(await stopped.run.interrupt()).toEqual({ stillQueued: [] });
    // The request it cut off was never counted, so the process's total is the one the turn before ended on.
    first.query.emit({ ...sdk.interruptedResult(PROVIDER_SESSION), modelUsage: spentSoFar(100, 2679, 71000, 0.375) });
    const events = await stopped.events.done;
    expect(events.filter((event) => event.type === "usage.reported")).toEqual([]);
    expect(ends(events)).toEqual([expect.objectContaining({ reason: "interrupted", usage: null })]);
  });

  it("holds the process for each live background task on the pool's port, and lets each go as it settles", async () => {
    const adapter = adapterWith();
    const turn = await oneTurn(adapter, runInput());
    await turn.finish(sdk.tasks({ task_id: "task_1" }, { task_id: "task_2" }));
    turn.query.emit(sdk.tasks({ task_id: "task_2" }), sdk.taskNotification("task_1"), sdk.tasks());
    await flush();
    expect(port).toEqual(["hold task:task_1", "hold task:task_2", "unhold task:task_1", "unhold task:task_2"]);
    expect(turn.query.closed).toBe(false);
  });

  it("holds the process for a registered schedule under one synthetic id", async () => {
    const adapter = adapterWith();
    const turn = await oneTurn(adapter, runInput());
    await turn.finish(sdk.toolUse("toolu_cron", "CronCreate", { cron: "0 * * * *" }), sdk.toolResult("toolu_cron"), sdk.toolUse("toolu_wake", "ScheduleWakeup"), sdk.toolResult("toolu_wake"));
    expect(port).toEqual(["hold schedule:claude-schedules"]);
    expect(turn.query.closed).toBe(false);
  });

  it("tells the port the process exited when it dies on its own, and lets its holds go", async () => {
    const adapter = adapterWith();
    const turn = await oneTurn(adapter, runInput());
    await turn.finish(sdk.tasks({ task_id: "task_1" }));
    turn.query.fail(new Error("the CLI exited with code 1"));
    await vi.waitFor(() => expect(port).toContain("exited"));
    expect(port).toEqual(["hold task:task_1", "unhold task:task_1", "exited"]);
  });

  it("kills the process's child with SIGKILL when stopped with kill, waiting for nothing", async () => {
    const adapter = adapterWith();
    const turn = await oneTurn(adapter, runInput());
    const spawnProcess = turn.query.options.spawnClaudeCodeProcess;
    expect(typeof spawnProcess).toBe("function");
    const abort = new AbortController();
    const child = spawnProcess?.({ command: process.execPath, args: ["-e", "setInterval(() => undefined, 1000)"], env: { PATH: process.env["PATH"] }, signal: abort.signal }) as unknown as import("node:child_process").ChildProcess;
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
    await adapter.stopProcess(SESSION, { kill: true });
    expect(await exited).toBe("SIGKILL");
    expect(turn.query.closed).toBe(true);
  });

  it("resolves a stop whose child failed to spawn, which never emits exit", async () => {
    const adapter = adapterWith();
    const turn = await oneTurn(adapter, runInput());
    const spawnProcess = turn.query.options.spawnClaudeCodeProcess;
    const child = spawnProcess?.({ command: "/nonexistent/claude-agent-sdk/claude", args: [], env: { PATH: process.env["PATH"] }, signal: new AbortController().signal }) as unknown as import("node:child_process").ChildProcess;
    const events: string[] = [];
    for (const name of ["error", "exit", "close"]) child.on(name, () => events.push(name));
    // Stopped at once, before Node has reported the failure: the child has neither an exit code nor a signal yet.
    const stopped = adapter.stopProcess(SESSION).then(() => "stopped");
    const late = new Promise((resolve) => setTimeout(() => resolve("still waiting"), 2_000));
    expect(await Promise.race([stopped, late])).toBe("stopped");
    expect(events).toEqual(["error", "close"]);
  });

  it("spawns fresh for a run that asks for bypass of a process started without it, and refuses while it holds work", async () => {
    const adapter = adapterWith();
    const first = await oneTurn(adapter, runInput());
    await first.finish(sdk.tasks({ task_id: "task_1" }));
    expect(() => adapter.createRun(runInput({ mode: "bypassPermissions", ceiling: "bypassPermissions", target: { kind: "resume", providerSessionId: PROVIDER_SESSION } }), contextWith())).toThrow(/still has work running/);
    first.query.emit(sdk.tasks());
    await new Promise((resolve) => setTimeout(resolve, 5));
    adapter.createRun(runInput({ mode: "bypassPermissions", ceiling: "bypassPermissions", target: { kind: "resume", providerSessionId: PROVIDER_SESSION } }), contextWith());
    const second = await started(2);
    expect(first.query.closed).toBe(true);
    expect(second.options).toMatchObject({ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, resume: PROVIDER_SESSION });
  });

  it("spawns fresh for a run at another containment level, or with other denylist rules to project, since the sandbox and the rules are fixed at spawn", async () => {
    const adapter = adapterWith();
    const resume = { kind: "resume", providerSessionId: PROVIDER_SESSION } as const;
    const first = await oneTurn(adapter, runInput());
    await first.finish();
    const contained: RunInput["containment"] = { ...runInput().containment, level: "workspace", mechanism: "bubblewrap" };
    const second = await oneTurn(adapter, runInput({ containment: contained, target: resume }));
    expect(first.query.closed).toBe(true);
    expect(second.query.options.sandbox).toMatchObject({ enabled: true });
    await second.finish();
    const projected: RunInput["denylist"] = { paths: ["/home/david/.ssh"], exempt: [], commandPatterns: ["sudo *"] };
    const third = await oneTurn(adapter, runInput({ containment: contained, denylist: projected, target: resume }));
    expect(second.query.closed).toBe(true);
    expect(third.query.options).toMatchObject({ disallowedTools: ["Bash(sudo *)"], sandbox: { filesystem: { denyRead: ["/home/david/.ssh"] } } });
    await third.finish();
    // The same level and the same rules: the kept process serves it.
    const fourth = await oneTurn(adapter, runInput({ containment: contained, denylist: { ...projected }, target: resume }), third.query);
    await fourth.finish();
    expect(fake.queries).toHaveLength(3);
  });

  it("spawns fresh when the attached bank directories change, including with containment off, and reuses an unchanged attachment", async () => {
    const adapter = adapterWith();
    const resume = { kind: "resume", providerSessionId: PROVIDER_SESSION } as const;
    const first = await oneTurn(adapter, runInput({ additionalDirectories: ["/data/banks/personal"] }));
    await first.finish(sdk.tasks({ task_id: "task_1" }));
    expect(() => adapter.createRun(runInput({ additionalDirectories: ["/data/banks/team"], target: resume }), contextWith())).toThrow(/still has work running/);
    first.query.emit(sdk.tasks());
    await vi.waitFor(() => expect(port).toContain("unhold task:task_1"));
    const second = await oneTurn(adapter, runInput({ additionalDirectories: ["/data/banks/team"], target: resume }));
    expect(first.query.closed).toBe(true);
    expect(second.query.options.additionalDirectories).toEqual(["/data/banks/team"]);
    await second.finish();
    const third = await oneTurn(adapter, runInput({ additionalDirectories: ["/data/banks/team"], target: resume }), second.query);
    await third.finish();
    expect(fake.queries).toHaveLength(2);
    const fourth = await oneTurn(adapter, runInput({ additionalDirectories: [], target: resume }));
    expect(second.query.closed).toBe(true);
    expect(fourth.query.options.additionalDirectories).toBeUndefined();
    await fourth.finish();
  });

  it("spawns fresh for a run whose containment closes other paths, a worktree made since the last, since the sandbox's denyWrite is fixed at spawn (#791)", async () => {
    const adapter = adapterWith();
    const resume = { kind: "resume", providerSessionId: PROVIDER_SESSION } as const;
    const closing = (...worktrees: string[]): RunInput["containment"] => ({
      ...runInput().containment,
      level: "workspace",
      mechanism: "bubblewrap",
      readOnly: ["hooks", "config", "config.worktree", ...worktrees.map((name) => `worktrees/${name}/config.worktree`)].map((path) => `/work/repo/.git/${path}`),
    });
    const first = await oneTurn(adapter, runInput({ containment: closing() }));
    await first.finish();
    const second = await oneTurn(adapter, runInput({ containment: closing("feature"), target: resume }));
    expect(first.query.closed).toBe(true);
    expect(second.query.options.sandbox?.filesystem?.denyWrite).toContain("/work/repo/.git/worktrees/feature/config.worktree");
    await second.finish();
    // The same paths closed: the kept process serves it.
    const third = await oneTurn(adapter, runInput({ containment: closing("feature"), target: resume }), second.query);
    await third.finish();
    expect(fake.queries).toHaveLength(2);
  });

  it("spawns fresh, with the opt-in, for a run under a bypass ceiling in a lower mode, so its mode can later be changed to bypass", async () => {
    const adapter = adapterWith();
    const first = await oneTurn(adapter, runInput());
    await first.finish();
    adapter.createRun(runInput({ mode: "acceptEdits", ceiling: "bypassPermissions", target: { kind: "resume", providerSessionId: PROVIDER_SESSION } }), contextWith());
    const second = await started(2);
    expect(first.query.closed).toBe(true);
    expect(second.options).toMatchObject({ permissionMode: "acceptEdits", allowDangerouslySkipPermissions: true });
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

  it("ends a fork from a message it cannot place, rather than forking the whole session", async () => {
    const adapter = adapterWith();
    fake.stored.set(PROVIDER_SESSION, [
      { type: "user", uuid: "p1", message: { role: "user", content: "First" } },
      { type: "assistant", uuid: "a1", message: { role: "assistant", content: [] } },
    ]);
    // Not in the stored chain, and first in it (nothing comes before it to fork from).
    for (const atMessageId of ["nowhere", "p1"]) {
      const run = adapter.createRun(runInput({ target: { kind: "fork", providerSessionId: PROVIDER_SESSION, atMessageId } }), contextWith());
      expect(ends(await drain(run))).toEqual([
        expect.objectContaining({ reason: "error", error: expect.objectContaining({ message: expect.stringMatching(new RegExp(`${atMessageId} is not in the stored conversation`)) }) }),
      ]);
    }
    expect(fake.queries).toHaveLength(0);
  });

  it("tells the port no process ran when nothing spawned, whether the launch failed or the run was interrupted while its resume point was read", async () => {
    const adapter = adapterWith();
    const failed = adapter.createRun(runInput({ target: { kind: "rewind", providerSessionId: PROVIDER_SESSION, toMessageId: "nowhere" } }), contextWith());
    expect(ends(await drain(failed))).toEqual([expect.objectContaining({ reason: "error" })]);
    expect(port).toEqual(["exited"]);

    port.length = 0;
    fake.stored.set(PROVIDER_SESSION, [
      { type: "user", uuid: "p1", message: { role: "user", content: "First" } },
      { type: "assistant", uuid: "a1", message: { role: "assistant", content: [] } },
      { type: "user", uuid: "p2", message: { role: "user", content: "Second" } },
    ]);
    let read: () => void = () => undefined;
    const reading = new Promise<void>((resolve) => (read = resolve));
    hooks.sdk = { query: fake.query, getSessionMessages: async (id: string, options: unknown) => (await reading, fake.getSessionMessages(id, options)) };
    const run = adapter.createRun(runInput({ target: { kind: "fork", providerSessionId: PROVIDER_SESSION, atMessageId: "p2" } }), contextWith());
    const events = drain(run);
    expect(await run.interrupt()).toEqual({ stillQueued: [] });
    read();
    expect(ends(await events)).toEqual([expect.objectContaining({ reason: "interrupted", cause: "user" })]);
    await vi.waitFor(() => expect(port).toEqual(["exited"]));
    expect(fake.queries).toHaveLength(0);
  });

  it("stops the session's process for the pool whatever it holds, and resolves once it has stopped", async () => {
    const adapter = adapterWith();
    const turn = await oneTurn(adapter, runInput());
    await turn.finish(sdk.tasks({ task_id: "task_1" }));
    await adapter.stopProcess(SESSION);
    expect(turn.query.closed).toBe(true);
    await adapter.stopProcess(SESSION);
  });
});

describe("the process environment (#307)", () => {
  /** A run's process environment under `key` that supplies `variables`, counting the spawns it supplied. */
  const supplying = (variables: Readonly<Record<string, string>>, key = "forge generation 1") => {
    const supplied = { count: 0 };
    const environment: ProcessEnvironment = {
      key,
      supply: async () => {
        supplied.count += 1;
        return { variables, release: () => undefined };
      },
    };
    return { environment, supplied };
  };

  it("layers what the spawn is supplied over the scrubbed environment, once per spawn: a supplied name holding _TOKEN reaches the process, never a stripped one or the harness's own", async () => {
    const adapter = adapterWith({ hostEnv: { PATH: "/usr/bin", GH_TOKEN: "the shell's", ANTHROPIC_API_KEY: "sk-ant-shell" } });
    const { environment, supplied } = supplying({
      GH_TOKEN: "token-for-tests",
      FORGE_WORK_TOKEN: "forge-token-for-tests",
      AGENT_HARNESS_RUN_SECRET: "secret-for-tests",
      ANTHROPIC_API_KEY: "sk-ant-supplied",
      CLAUDE_CONFIG_DIR: "/elsewhere",
      CLAUDE_CODE_PROJECT_DIR_NAME: "elsewhere",
    });
    const first = runInput({ processEnvironment: environment });
    const run = adapter.createRun(first, contextWith());
    const query = await started();

    expect(query.env).toMatchObject({ PATH: "/usr/bin", GH_TOKEN: "token-for-tests", FORGE_WORK_TOKEN: "forge-token-for-tests", AGENT_HARNESS_RUN_SECRET: "secret-for-tests" });
    expect(query.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(query.env["CLAUDE_CONFIG_DIR"]).toBe("/data/accounts/work");
    expect(query.env["CLAUDE_CODE_PROJECT_DIR_NAME"]).toBe(SESSION);
    // Only ever in the process's environment: nothing else query() is handed carries them.
    const beside = JSON.stringify({ ...query.options, env: undefined });
    for (const value of ["token-for-tests", "secret-for-tests"]) expect(beside).not.toContain(value);

    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [first.prompt[0]?.messageId as string]), sdk.result(PROVIDER_SESSION));
    await drain(run);
    run.release();
    // The next run attaches to the process: nothing is supplied again.
    const next = runInput({ processEnvironment: environment, target: { kind: "resume", providerSessionId: PROVIDER_SESSION } });
    adapter.createRun(next, contextWith());
    await query.promptsPushed(2);
    expect(fake.queries).toHaveLength(1);
    expect(supplied.count).toBe(1);
  });

  it.each(["workspace", "workspace-no-network"] as const)(
    "lets a contained command at %s write the directories its spawn was supplied as the holder's own, a key-manager CLI's per-holder directory, beside the run's writable set (#1119)",
    async (level) => {
      const adapter = adapterWith();
      const holderDirectory = "/data/agent-harness/key-manager-cli/doppler-3f9a2c";
      const environment: ProcessEnvironment = {
        key: "key-managers generation 1",
        supply: async () => ({ variables: { DOPPLER_CONFIG_DIR: holderDirectory }, writable: [holderDirectory], release: () => undefined }),
      };
      const contained: RunInput["containment"] = { ...runInput().containment, level, mechanism: "bubblewrap", network: level === "workspace" };
      adapter.createRun(runInput({ containment: contained, processEnvironment: environment }), contextWith());
      const query = await started();
      expect(query.options.sandbox?.filesystem?.allowWrite).toEqual(["/work/repo", "/data/containment/session/scratch", "/data/containment/session/tmp", holderDirectory]);
    },
  );

  it("sets no sandbox at off for a spawn supplied directories to write, since nothing is contained", async () => {
    const adapter = adapterWith();
    const environment: ProcessEnvironment = {
      key: "key-managers generation 1",
      supply: async () => ({ variables: {}, writable: ["/data/agent-harness/key-manager-cli/doppler-3f9a2c"], release: () => undefined }),
    };
    adapter.createRun(runInput({ processEnvironment: environment }), contextWith());
    const query = await started();
    expect(query.options).not.toHaveProperty("sandbox");
  });

  it("serves a run whose key differs on a fresh process, the kept one let go with its queued message handed on, and attaches a run with the same key", async () => {
    const adapter = adapterWith();
    const context = contextWith();
    const before = supplying({ HARNESS_GENERATION: "1" }, "forge generation 1");
    const input = runInput({ processEnvironment: before.environment });
    const run = adapter.createRun(input, context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]), sdk.toolUse("toolu_cron", "CronCreate", { cron: "0 * * * *" }), sdk.toolResult("toolu_cron"));
    await flush();
    const queued = message("Then tidy up");
    await run.send(queued);
    query.emit(sdk.result(PROVIDER_SESSION));
    await drain(run);
    run.release();

    const after = supplying({ HARNESS_GENERATION: "2" }, "forge generation 2");
    const changed = runInput({ processEnvironment: after.environment, target: { kind: "resume", providerSessionId: PROVIDER_SESSION } });
    const second = adapter.createRun(changed, context);
    const fresh = await fake.made(2);
    const prompts = await fresh.promptsPushed(2);
    expect(query.closed).toBe(true);
    expect(prompts.map((prompt) => prompt.uuid)).toEqual([changed.prompt[0]?.messageId, queued.messageId]);
    expect(fresh.env["HARNESS_GENERATION"]).toBe("2");
    // Let go by the adapter, not exited: the pool's record of the session's process is the fresh one's, whose release it holds.
    await flush();
    expect(port).not.toContain("exited");
    fresh.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_2", [changed.prompt[0]?.messageId as string, queued.messageId]), sdk.result(PROVIDER_SESSION));
    await drain(second);
    second.release();

    const same = runInput({ processEnvironment: supplying({ HARNESS_GENERATION: "2" }, "forge generation 2").environment, target: { kind: "resume", providerSessionId: PROVIDER_SESSION } });
    adapter.createRun(same, context);
    await fresh.promptsPushed(3);
    expect(fake.queries).toHaveLength(2);
    expect([before.supplied.count, after.supplied.count]).toEqual([1, 1]);
  });

  it("asks nothing of it for a run interrupted before its process spawned", async () => {
    const adapter = adapterWith();
    fake.stored.set(PROVIDER_SESSION, [
      { type: "user", uuid: "p1", message: { role: "user", content: "First" } },
      { type: "assistant", uuid: "a1", message: { role: "assistant", content: [] } },
      { type: "user", uuid: "p2", message: { role: "user", content: "Second" } },
    ]);
    let read: () => void = () => undefined;
    const reading = new Promise<void>((resolve) => (read = resolve));
    hooks.sdk = { query: fake.query, getSessionMessages: async (id: string, options: unknown) => (await reading, fake.getSessionMessages(id, options)) };
    const { environment, supplied } = supplying({ HARNESS_TEST_TOKEN: "token-for-tests" });
    const run = adapter.createRun(runInput({ processEnvironment: environment, target: { kind: "fork", providerSessionId: PROVIDER_SESSION, atMessageId: "p2" } }), contextWith());
    const events = drain(run);

    await run.interrupt();
    read();

    expect(ends(await events)).toEqual([expect.objectContaining({ reason: "interrupted" })]);
    await vi.waitFor(() => expect(port).toEqual(["exited"]));
    expect(supplied.count).toBe(0);
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
    expect(events.map((event) => event.type)).toEqual(["session.provider-linked", "tasks.changed", "context.reported", "assistant.text", "end"]);
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

  it("ends a subagent's prompt turn with the transport error when the process dies under its parked prompt, not completed", async () => {
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
    await vi.waitFor(() => expect(context.asked).toHaveLength(1));
    const read = reading(promptTurn);
    query.fail(new Error("the CLI exited with code 1"));
    expect(await asked).toMatchObject({ behavior: "deny" });
    expect(ends(await read.done)).toEqual([expect.objectContaining({ reason: "error", error: expect.objectContaining({ code: "transport", message: expect.stringContaining("exited with code 1") }) })]);
  });
});

describe("plan usage", () => {
  it("preserves an unknown limit for details and reports its identifier once through the adapter diagnostic", async () => {
    fake.controls = { usage: { name: "usage", answer: async () => ({
      rate_limits_available: true,
      rate_limits: { iguana_necktie: { utilization: 37, resets_at: "2026-09-30T00:00:00Z" } },
    }) } };
    const adapter = adapterWith();
    expect((await adapter.usage({ id: "work", directory: "/data/accounts/work" })).windows).toEqual([
      { window: "iguana_necktie", utilisation: 0.37, resetsAt: "2026-09-30T00:00:00.000Z" },
    ]);
    await adapter.usage({ id: "other", directory: "/data/accounts/other" });
    expect(diagnostics.filter((line) => line.includes("iguana_necktie"))).toEqual(["Claude reported an unknown plan-usage window: iguana_necktie"]);
  });

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
      runCommand: async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "milo@example.com", orgName: "Milo's" }), stderr: "" }),
    });
    expect((await adapter.usage({ id: "work", directory: "/d" })).identity).toEqual({ provider: "claude", email: "milo@example.com", organisation: "Milo's" });
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

  it("lists the commands for a workspace without starting a turn, flagged built-in where the CLI marks them Claude Code's own (#503)", async () => {
    // As the pinned CLI (2.1.283) answers: its own marked, a project's command and the generation plugin's member unmarked.
    fake.controls = {
      supportedCommands: async () => [
        { name: "compact", description: "Clear the conversation history but keep a summary", argumentHint: "<optional custom summarization instructions>", builtin: true },
        { name: "review", description: "Review the branch", argumentHint: "[branch]" },
        { name: "agent-harness:tdd", description: "Test first", argumentHint: "<feature>", aliases: ["tdd"] },
      ],
    };
    const adapter = adapterWith();
    const scope = { trusted: false, skillSet: EMPTY_RUN_SKILL_SET };
    expect(await adapter.commands({ id: "work", directory: "/d" }, { kind: "directory", path: "/work/repo" }, scope)).toEqual([
      { name: "compact", description: "Clear the conversation history but keep a summary", builtin: true },
      { name: "review", description: "Review the branch", builtin: false },
      { name: "agent-harness:tdd", description: "Test first", builtin: false },
    ]);
    expect(fake.last().options.cwd).toBe("/work/repo");
    expect(fake.last().prompts).toEqual([]);
  });

  it("describes itself: the four modes, the append channel, a trusted repository's instructions, .claude/skills and commands its own to load, a provider queue that steers, containment enforced", () => {
    expect(CLAUDE_DESCRIPTOR).toMatchObject({
      containment: true,
      provider: "claude",
      modes: ["acceptEdits", "plan", "auto", "bypassPermissions"].map((mode) => ({ mode, available: true, reason: null })),
      instructionChannel: { kind: "system-prompt-append", maxCharacters: null },
      nativeProjectInstructions: true,
      nativeSkillRoots: [".claude/skills", ".claude/commands"],
      providerQueue: true,
      withdraw: true,
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

  it("refuses a message sent to it, so the environment holds it and no interrupt could leave it for the CLI to run", async () => {
    const { turn, query } = await promptTurn();
    await expect(turn.send(message("While you wait"))).rejects.toThrow(/prompt/);
    expect(query.prompts).toHaveLength(1);
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
    const adapter = adapterWith();
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

  it("keeps the bound on an undecided init when a waiting run is interrupted meanwhile, so the silence still lets the process go", async () => {
    fake.controls = { cancelled: () => true };
    const adapter = adapterWith();
    const run = adapter.createRun(runInput(), contextWith());
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION));
    await flush();
    // Withdrawn from the CLI's queue while the init waits for what follows it.
    const interrupting = run.interrupt();
    await flush();
    // The interrupt waits out the decision's settle first, and the window goes on.
    clock.advance(DEFAULT_TIMINGS.decisionSettleMs);
    expect(await interrupting).toEqual({ stillQueued: [] });
    expect(ends(await drain(run))).toEqual([expect.objectContaining({ reason: "interrupted" })]);
    run.release();
    clock.advance(DEFAULT_TIMINGS.openTimeoutMs - DEFAULT_TIMINGS.decisionSettleMs);
    await flush();
    // The init was dropped: a run the process cannot serve replaces it rather than being refused as busy.
    adapter.createRun(runInput({ mode: "bypassPermissions", ceiling: "bypassPermissions", target: { kind: "resume", providerSessionId: PROVIDER_SESSION } }), contextWith());
    await started(2);
    expect(query.closed).toBe(true);
  });

  it("clears a settle debt however the turn it waited on ended, so a later delivery failure is still the waiting run's", async () => {
    const adapter = adapterWith();
    const context = contextWith();
    const input = runInput();
    const first = adapter.createRun(input, context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]), sdk.tasks({ task_id: "task_1" }));
    await flush();
    // The level empties while the turn is open: the settle grace waits for the turn's end.
    query.emit(sdk.taskNotification("task_1"), sdk.tasks());
    await flush();
    // The turn is ended from outside rather than at a result, and the CLI's next message finds it ended.
    (first as unknown as { end(end: { reason: "error"; error: { message: string; code: null } }): void }).end({ reason: "error", error: { message: "Ended elsewhere.", code: null } });
    query.emit(sdk.text("msg_1", "Late words."));
    await flush();
    clock.advance(DEFAULT_TIMINGS.settleGraceMs);
    first.release();
    const next = runInput({ target: { kind: "resume", providerSessionId: PROVIDER_SESSION } });
    const run = adapter.createRun(next, context);
    await query.promptsPushed(2);
    const read = reading(run);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.result(PROVIDER_SESSION, { subtype: "success", is_error: true, result: "API Error: 529 overloaded", num_turns: 0 }));
    await vi.waitFor(() => expect(ends(read.events)).toEqual([expect.objectContaining({ reason: "error" })]));
    expect(context.adopted).toEqual([]);
  });

  it("does not give a delivery failure naming no one to the waiting run while a scheduled job could be what failed", async () => {
    const adapter = adapterWith();
    const context = contextWith();
    const input = runInput();
    const first = adapter.createRun(input, context);
    const query = await started();
    query.emit(
      sdk.init(PROVIDER_SESSION),
      sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]),
      sdk.toolUse("toolu_wake", "ScheduleWakeup"),
      sdk.toolResult("toolu_wake"),
      sdk.result(PROVIDER_SESSION),
    );
    await drain(first);
    first.release();
    const next = runInput({ target: { kind: "resume", providerSessionId: PROVIDER_SESSION } });
    const run = adapter.createRun(next, context);
    await query.promptsPushed(2);
    const read = reading(run);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.result(PROVIDER_SESSION, { subtype: "success", is_error: true, result: "API Error: 529 overloaded", num_turns: 0 }));
    await vi.waitFor(() => expect(context.adopted).toHaveLength(1));
    await flush();
    expect(read.events).toEqual([]);
  });

  it("ends a run whose CLI sends init and then nothing with an error once the open timeout passes, and is not held busy by it after", async () => {
    const adapter = adapterWith();
    const run = adapter.createRun(runInput(), contextWith());
    const query = await started();
    const read = reading(run);
    // A narrating CLI decides whose turn this is from what follows init: here nothing does.
    query.emit(sdk.init(PROVIDER_SESSION));
    await flush();
    clock.advance(59_999);
    await flush();
    expect(read.events).toEqual([]);
    clock.advance(1);
    expect(ends(await read.done)).toEqual([expect.objectContaining({ reason: "error", error: expect.objectContaining({ code: "not_opened" }) })]);
    run.release();
    // The undecided init no longer counts as work: a run the process cannot serve replaces it rather than being refused.
    adapter.createRun(runInput({ mode: "bypassPermissions", ceiling: "bypassPermissions", target: { kind: "resume", providerSessionId: PROVIDER_SESSION } }), contextWith());
    await started(2);
    expect(query.closed).toBe(true);
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

  it("withdraws the prompt of a run the open timeout ends, and what was sent onto it, so a CLI that opens late does not run them", async () => {
    fake.controls = { cancelled: () => true };
    const adapter = adapterWith();
    const input = runInput();
    const run = adapter.createRun(input, contextWith());
    const query = await started();
    const followUp = message("And this");
    await run.send(followUp);
    await query.promptsPushed(2);
    const read = reading(run);
    clock.advance(DEFAULT_TIMINGS.openTimeoutMs);
    expect(ends(await read.done)).toEqual([expect.objectContaining({ reason: "error", error: expect.objectContaining({ code: "not_opened", message: expect.stringContaining("send again") }) })]);
    expect(query.cancelRequests).toEqual([input.prompt[0]?.messageId, followUp.messageId]);
  });

  it("does not ask for the prompt again when the open timeout ends a run whose prompt the CLI will not give back", async () => {
    fake.controls = { cancelled: () => false };
    const adapter = adapterWith();
    const input = runInput();
    const run = adapter.createRun(input, contextWith());
    const query = await started();
    const read = reading(run);
    clock.advance(DEFAULT_TIMINGS.openTimeoutMs);
    const [end] = ends(await read.done);
    expect(query.cancelRequests).toEqual([input.prompt[0]?.messageId]);
    expect(end).toEqual(expect.objectContaining({ reason: "error", error: expect.objectContaining({ code: "not_opened", message: expect.stringContaining("may still run it") }) }));
    expect(JSON.stringify(end)).not.toContain("send again");
  });

  it("withdraws the prompt of a run it ends when the CLI sends init and then nothing", async () => {
    fake.controls = { cancelled: () => true };
    const adapter = adapterWith();
    const input = runInput();
    const run = adapter.createRun(input, contextWith());
    const query = await started();
    const read = reading(run);
    query.emit(sdk.init(PROVIDER_SESSION));
    await flush();
    clock.advance(DEFAULT_TIMINGS.openTimeoutMs);
    expect(ends(await read.done)).toEqual([expect.objectContaining({ reason: "error", error: expect.objectContaining({ code: "not_opened", message: expect.stringContaining("send again") }) })]);
    expect(query.cancelRequests).toEqual([input.prompt[0]?.messageId]);
  });

  it("withdraws what was sent onto a run that has not opened with its prompt, and hands those messages back", async () => {
    fake.controls = { cancelled: () => true };
    const adapter = adapterWith();
    const input = runInput();
    const run = adapter.createRun(input, contextWith());
    const query = await started();
    const followUp = message("And this");
    await run.send(followUp);
    await query.promptsPushed(2);
    expect(await run.interrupt()).toEqual({ stillQueued: [followUp.messageId] });
    expect(query.cancelRequests).toEqual([input.prompt[0]?.messageId, followUp.messageId]);
    expect(ends(await drain(run))).toEqual([expect.objectContaining({ reason: "interrupted" })]);
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
    const bypass = runInput({ mode: "bypassPermissions", ceiling: "bypassPermissions", target: { kind: "resume", providerSessionId: PROVIDER_SESSION } });
    adapter.createRun(bypass, context);
    const fresh = await fake.made(2);
    const prompts = await fresh.promptsPushed(2);
    expect(query.closed).toBe(true);
    expect(prompts.map((prompt) => prompt.uuid)).toEqual([bypass.prompt[0]?.messageId, queued.messageId]);
  });

  it("serves a run whose instructions differ from the kept process's on a fresh process spawned with them, and attaches one whose instructions match", async () => {
    const adapter = adapterWith();
    const context = contextWith();
    const input = runInput({ instructions: "Composed." });
    const run = adapter.createRun(input, context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]), sdk.toolUse("toolu_cron", "CronCreate", { cron: "0 * * * *" }), sdk.toolResult("toolu_cron"), sdk.result(PROVIDER_SESSION));
    await drain(run);
    run.release();
    // The same instructions attach to the kept process.
    const same = adapter.createRun(runInput({ instructions: "Composed.", target: { kind: "resume", providerSessionId: PROVIDER_SESSION } }), context);
    await query.promptsPushed(2);
    expect(fake.queries).toHaveLength(1);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_2", [(await query.promptsPushed(2))[1]?.uuid as string]), sdk.result(PROVIDER_SESSION));
    await drain(same);
    same.release();
    // A run with its own instructions after the composed ones needs a process that was given them.
    const own = runInput({ instructions: "Composed.\n\nPersona: tidy.", target: { kind: "resume", providerSessionId: PROVIDER_SESSION } });
    adapter.createRun(own, context);
    const fresh = await fake.made(2);
    expect(query.closed).toBe(true);
    expect(fresh.options.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "Composed.\n\nPersona: tidy." });
  });

  it("serves a run whose trust differs from the kept process's on a fresh process with the project settings it admits, and attaches one whose trust is the same (#500)", async () => {
    const adapter = adapterWith();
    const context = contextWith();
    const input = runInput({ trusted: false });
    const run = adapter.createRun(input, context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]), sdk.toolUse("toolu_cron", "CronCreate", { cron: "0 * * * *" }), sdk.toolResult("toolu_cron"), sdk.result(PROVIDER_SESSION));
    await drain(run);
    run.release();
    expect(query.options).toMatchObject({ settingSources: [], strictMcpConfig: true });
    // Still undecided: the kept process serves it.
    const same = adapter.createRun(runInput({ trusted: false, target: { kind: "resume", providerSessionId: PROVIDER_SESSION } }), context);
    await query.promptsPushed(2);
    expect(fake.queries).toHaveLength(1);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_2", [(await query.promptsPushed(2))[1]?.uuid as string]), sdk.result(PROVIDER_SESSION));
    await drain(same);
    same.release();
    // Trusted since: a process that loads the repository's project settings, and never its local ones or its MCP servers.
    adapter.createRun(runInput({ trusted: true, target: { kind: "resume", providerSessionId: PROVIDER_SESSION } }), context);
    const fresh = await fake.made(2);
    expect(query.closed).toBe(true);
    expect(fresh.options).toMatchObject({ settingSources: ["project"], strictMcpConfig: true });
  });

  it("serves a run whose skill set's fingerprint differs from the kept process's on a fresh process resuming from the store with the new generation, and attaches one whose fingerprint is the same (#495)", async () => {
    const store = { append: async () => undefined, load: async () => null, listUnrenamedSummaries: async () => [] };
    const adapter = adapterWith({ sessionStore: store });
    const context = contextWith();
    const input = runInput({ skillSet: skillSetOf("3f9a") });
    const run = adapter.createRun(input, context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]), sdk.toolUse("toolu_cron", "CronCreate", { cron: "0 * * * *" }), sdk.toolResult("toolu_cron"), sdk.result(PROVIDER_SESSION));
    await drain(run);
    run.release();
    expect(query.options.plugins).toEqual([{ type: "local", path: "/data/skills/generations/3f9a" }]);
    // The same fingerprint, resolved again for the next run: the kept process serves it.
    const same = adapter.createRun(runInput({ skillSet: skillSetOf("3f9a"), target: { kind: "resume", providerSessionId: PROVIDER_SESSION } }), context);
    await query.promptsPushed(2);
    expect(fake.queries).toHaveLength(1);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_2", [(await query.promptsPushed(2))[1]?.uuid as string]), sdk.result(PROVIDER_SESSION));
    await drain(same);
    same.release();
    // A skill created since: a process spawned with the new generation, resuming the conversation through the store.
    adapter.createRun(runInput({ skillSet: { ...skillSetOf("7c1e"), hiddenNativeNames: [] }, target: { kind: "resume", providerSessionId: PROVIDER_SESSION } }), context);
    // A cold resume through the store refreshes the login on an unsampled query first (#229): the run's is the next.
    const fresh = await fake.made(3);
    expect(query.closed).toBe(true);
    expect(fresh.options).toMatchObject({ resume: PROVIDER_SESSION, sessionStore: store, plugins: [{ type: "local", path: "/data/skills/generations/7c1e" }] });
    expect(fresh.options).not.toHaveProperty("settings");
  });

  it("serves a run whose in-process tools differ from the kept process's on a fresh process, and attaches one whose tools are the same (#139)", async () => {
    const adapter = adapterWith();
    const context = contextWith();
    const serverOf = (description: string): InProcessToolServer => ({
      name: "client",
      external: true,
      tools: [{ name: "get_weather", description, inputSchema: { type: "object", properties: { city: { type: "string" } } }, call: async () => ({ text: "Sunny", isError: false }) }],
    });
    const input = runInput({ toolServers: [serverOf("The weather.")] });
    const run = adapter.createRun(input, context);
    const query = await started();
    expect(query.options.allowedTools).toEqual(["mcp__client"]);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]), sdk.toolUse("toolu_cron", "CronCreate", { cron: "0 * * * *" }), sdk.toolResult("toolu_cron"), sdk.result(PROVIDER_SESSION));
    await drain(run);
    run.release();
    // The same tools, built afresh for the next run of the session, attach to the kept process.
    const same = adapter.createRun(runInput({ toolServers: [serverOf("The weather.")], target: { kind: "resume", providerSessionId: PROVIDER_SESSION } }), context);
    await query.promptsPushed(2);
    expect(fake.queries).toHaveLength(1);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_2", [(await query.promptsPushed(2))[1]?.uuid as string]), sdk.result(PROVIDER_SESSION));
    await drain(same);
    same.release();
    // Tools the model would see otherwise need a process started with them.
    adapter.createRun(runInput({ toolServers: [serverOf("The weather, today.")], target: { kind: "resume", providerSessionId: PROVIDER_SESSION } }), context);
    const fresh = await fake.made(2);
    expect(query.closed).toBe(true);
    expect(Object.keys(fresh.options.mcpServers ?? {})).toEqual(["client"]);
  });

  it("keeps serving the session from the fresh process once the one it replaced has closed twice, disposed and then its pump ended", async () => {
    const adapter = adapterWith();
    const context = contextWith();
    const input = runInput();
    const run = adapter.createRun(input, context);
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]), sdk.toolUse("toolu_cron", "CronCreate", { cron: "0 * * * *" }), sdk.toolResult("toolu_cron"), sdk.result(PROVIDER_SESSION));
    await drain(run);
    run.release();
    // A run the kept process cannot serve replaces it: disposed (its first close), its pump ends later (its second).
    const bypass = runInput({ mode: "bypassPermissions", ceiling: "bypassPermissions", target: { kind: "resume", providerSessionId: PROVIDER_SESSION } });
    const second = adapter.createRun(bypass, context);
    const fresh = await fake.made(2);
    await fresh.promptsPushed(1);
    await flush();
    expect(query.closed).toBe(true);
    fresh.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_2", [bypass.prompt[0]?.messageId as string]), sdk.result(PROVIDER_SESSION));
    await drain(second);
    second.release();

    const third = runInput({ mode: "bypassPermissions", ceiling: "bypassPermissions", target: { kind: "resume", providerSessionId: PROVIDER_SESSION } });
    adapter.createRun(third, context);
    await fresh.promptsPushed(2);
    expect(fake.queries).toHaveLength(2);
  });

  it("takes no schedule hold for a CronCreate or a ScheduleWakeup that was denied or failed, and one for a create that succeeded", async () => {
    const adapter = adapterWith();
    const input = runInput();
    const run = adapter.createRun(input, contextWith());
    const query = await started();
    query.emit(
      sdk.init(PROVIDER_SESSION),
      sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]),
      sdk.toolUse("toolu_denied", "CronCreate", { cron: "0 * * * *" }),
      sdk.toolResult("toolu_denied", "The user denied this tool call.", true),
      sdk.toolUse("toolu_wake", "ScheduleWakeup"),
      sdk.toolResult("toolu_wake", "Could not schedule.", true),
    );
    await flush();
    expect(port).toEqual([]);
    query.emit(sdk.toolUse("toolu_cron", "CronCreate", { cron: "0 * * * *" }));
    await flush();
    // Counted on its outcome, not its start: an ask may still deny it.
    expect(port).toEqual([]);
    query.emit(sdk.toolResult("toolu_cron"), sdk.result(PROVIDER_SESSION));
    await drain(run);
    expect(port).toEqual(["hold schedule:claude-schedules"]);
  });

  it("follows the CLI's own list of the session's schedules at each stop, so a one-shot job that expired lets the hold go", async () => {
    const adapter = adapterWith();
    const input = runInput();
    const run = adapter.createRun(input, contextWith());
    const query = await started();
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]), sdk.toolUse("toolu_cron", "CronCreate"), sdk.toolResult("toolu_cron"));
    await flush();
    expect(port).toEqual(["hold schedule:claude-schedules"]);
    const stop = query.options.hooks?.Stop?.[0]?.hooks[0];
    expect(stop).toBeDefined();
    const stopped = (crons: { id: string; schedule: string; recurring: boolean; prompt: string }[]) =>
      stop?.({ hook_event_name: "Stop", session_id: "s", transcript_path: "", cwd: "/work/repo", stop_hook_active: false, session_crons: crons } as never, undefined, { signal: new AbortController().signal });
    expect(await stopped([{ id: "c1", schedule: "30 9 25 9 *", recurring: false, prompt: "Check the deploy" }])).toEqual({});
    expect(port).toEqual(["hold schedule:claude-schedules"]);
    await stopped([]);
    expect(port).toEqual(["hold schedule:claude-schedules", "unhold schedule:claude-schedules"]);
    query.emit(sdk.result(PROVIDER_SESSION));
    await drain(run);
  });

  it("lets the schedule hold go once CronDelete removes the job", async () => {
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
    expect(port).toEqual(["hold schedule:claude-schedules", "unhold schedule:claude-schedules"]);
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

  it("names the machine's own directory for accounts.adopt: the host's CLAUDE_CONFIG_DIR, else ~/.claude, resolved once", () => {
    expect(adapterWith().ambientDirectory()).toBe("/home/david/.claude");
    const configured = adapterWith({ hostEnv: { PATH: "/usr/bin", HOME: "/home/david", CLAUDE_CONFIG_DIR: "/srv/claude" } });
    expect(configured.ambientDirectory()).toBe("/srv/claude");
  });

  it("reads an account with no directory's status under the ambient default, set explicitly", async () => {
    const seen: string[] = [];
    const adapter = adapterWith({
      hostEnv: { PATH: "/usr/bin", HOME: "/home/milo" },
      runCommand: async (_executable, _argv, env) => {
        seen.push(env["CLAUDE_CONFIG_DIR"] ?? "unset");
        return { code: 1, stdout: '{"loggedIn": false}', stderr: "" };
      },
    });
    await adapter.status({ id: "ambient", directory: null });
    expect(seen).toEqual(["/home/milo/.claude"]);
  });
});

describe("the unsampled queries", () => {
  it("keep no transcript, load no plugins for a model listing, and list commands as a run would offer them: the generation as the plugin, a trusted repository's project settings, the hidden native names off", async () => {
    fake.controls = { supportedModels: async () => [], supportedCommands: async () => [] };
    const adapter = adapterWith({ autoMemoryRoot: "/data/auto-memory" });
    await adapter.models({ id: "work", directory: "/d" });
    expect(fake.last().options).toMatchObject({ persistSession: false, settingSources: [] });
    expect(fake.last().options).not.toHaveProperty("plugins");
    await adapter.commands({ id: "work", directory: "/d" }, { kind: "directory", path: "/work/repo" }, { trusted: true, skillSet: skillSetOf("3f9a") });
    expect(fake.last().options).toMatchObject({
      persistSession: false,
      settingSources: ["project"],
      plugins: [{ type: "local", path: "/data/skills/generations/3f9a" }],
      settings: { skillOverrides: { triage: "off" } },
    });
    // A listing keeps no memory: the flag settings carry only what hides a skill.
    expect(fake.last().options.settings).toEqual({ skillOverrides: { triage: "off" } });
    await adapter.commands({ id: "work", directory: "/d" }, { kind: "directory", path: "/work/repo" }, { trusted: false, skillSet: EMPTY_RUN_SKILL_SET });
    expect(fake.last().options.settingSources).toEqual([]);
    expect(fake.last().options).not.toHaveProperty("plugins");
    expect(fake.last().options).not.toHaveProperty("settings");
  });

  it("lists commands in a worktree, or below its root, from its main checkout's project configuration as a run there loads it, and from none untrusted", async () => {
    fake.controls = { supportedCommands: async () => [] };
    const { root, checkout, worktree, below } = linkedWorktree();
    try {
      const adapter = adapterWith();
      for (const path of [worktree, below]) {
        await adapter.commands({ id: "work", directory: "/d" }, { kind: "directory", path }, { trusted: true, skillSet: EMPTY_RUN_SKILL_SET });
        expect(fake.last().options).toMatchObject({ cwd: path, settingSources: ["project"], projectConfigRoot: checkout });
      }
      await adapter.commands({ id: "work", directory: "/d" }, { kind: "directory", path: worktree }, { trusted: false, skillSet: EMPTY_RUN_SKILL_SET });
      expect(fake.last().options).not.toHaveProperty("projectConfigRoot");
      await adapter.commands({ id: "work", directory: "/d" }, { kind: "directory", path: checkout }, { trusted: true, skillSet: EMPTY_RUN_SKILL_SET });
      expect(fake.last().options).not.toHaveProperty("projectConfigRoot");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("answers a member's invocation: /agent-harness:<name> for one the generation links, /<name> for a native one", () => {
    const adapter = adapterWith();
    expect(adapter.invocationText({ name: "tdd", native: false })).toBe("/agent-harness:tdd");
    expect(adapter.invocationText({ name: "release", native: true })).toBe("/release");
  });
});
