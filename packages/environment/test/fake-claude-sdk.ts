import type { CanUseTool, HookEvent, HookInput, HookJSONOutput, McpSdkServerConfigWithInstance, Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * The Agent SDK's transport, scripted (claude-adapter spec, "Testing
 * Decisions", the adapter seam): a test replaces the SDK module with
 * `vi.hoisted` and `vi.mock` and routes `query()` here. Each call is a
 * `FakeQuery`: it records the options it was
 * called with (the process's environment among them), reads the streaming
 * input as the CLI would, yields the SDK messages the test emits, and keeps
 * the control methods a test drives or inspects. Nothing is spawned and no
 * credential is used.
 */

type Message = unknown;

/** What a tool hook is handed beside the call: its id, the SDK's signal, the subagent it comes from. */
export interface ToolHookExtra {
  readonly toolUseID?: string;
  readonly signal?: AbortSignal;
  readonly agentId?: string;
}

/**
 * Whether a hook matcher takes a tool, as the pinned CLI reads one: none,
 * empty or `*` takes every tool, and a list of plain names joined by `|`
 * takes those exact tools. The CLI reads anything else as a pattern, which
 * no run registers, so the fake refuses it rather than guess.
 */
const matcherTakes = (matcher: string | undefined, toolName: string): boolean => {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  if (!/^[a-zA-Z0-9_|]+$/.test(matcher)) throw new Error(`The fake reads no matcher pattern such as ${matcher}.`);
  return matcher.split("|").includes(toolName);
};

/** The control answers a test sets per query. */
export interface FakeControls {
  /** What an interrupt answers, given the options it was called with; preset: nothing still queued, nothing cancelled. */
  interruptReceipt?: (options: { cancelQueued?: boolean } | undefined) => Promise<{ still_queued: string[]; cancelled?: string[] } | undefined>;
  /** Leaves `interrupt` taking no options, as an SDK without `cancelQueued` has it. */
  plainInterrupt?: boolean;
  /** What `applyFlagSettings` answers once it has recorded the settings; preset: at once. */
  flagSettings?: () => Promise<void>;
  /** What `stopTask` answers once it has recorded the task; preset: at once. */
  stopTask?: (taskId: string) => Promise<void>;
  /** What `cancelAsyncMessage` answers per uuid, at once or when its promise settles; absent means the method is absent. */
  cancelled?: (uuid: string) => boolean | Promise<boolean>;
  accountInfo?: () => Promise<{ email?: string; organization?: string }>;
  /** The usage method: its name on the query, and its answer, given the query asked (its options, its environment). */
  usage?: { readonly name: string; readonly answer: (query: FakeQuery) => Promise<unknown> };
  supportedModels?: () => Promise<unknown[]>;
  supportedCommands?: () => Promise<SlashCommand[]>;
}

/** A row of `supportedCommands()` as the pinned SDK declares it: Claude Code's own marked `builtin`, the rest unmarked. */
export interface SlashCommand {
  name: string;
  description: string;
  argumentHint: string;
  aliases?: string[];
  builtin?: boolean;
}

export class FakeQuery {
  readonly options: Options;
  readonly prompts: SDKUserMessage[] = [];
  readonly #messages: Message[] = [];
  #waiting: { resolve: (result: IteratorResult<Message>) => void; reject: (error: unknown) => void } | undefined;
  #failure: { error: unknown } | undefined;
  #done = false;
  readonly #promptWaiters: (() => void)[] = [];
  closed = false;
  interrupts = 0;
  /** The options of each interrupt, in order. */
  readonly interruptOptions: ({ cancelQueued?: boolean } | undefined)[] = [];
  readonly models: string[] = [];
  readonly modes: string[] = [];
  readonly flags: unknown[] = [];
  readonly stoppedTasks: string[] = [];
  readonly cancelRequests: string[] = [];
  readonly controls: FakeControls;
  promptEnded = false;

  constructor(params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }, controls: FakeControls) {
    this.options = params.options ?? {};
    this.controls = controls;
    // A prompt stream that fails ends the query as a transport failure would, rather than as an unhandled rejection.
    if (typeof params.prompt !== "string") this.#read(params.prompt).catch((error: unknown) => this.fail(error));
    if (controls.usage !== undefined) {
      const { name, answer } = controls.usage;
      (this as unknown as Record<string, unknown>)[name] = async () => answer(this);
    }
    if (controls.plainInterrupt === true) {
      const counted = this.interrupt.bind(this);
      (this as unknown as Record<string, unknown>)["interrupt"] = () => counted(undefined);
    }
    if (controls.cancelled !== undefined) {
      const cancelled = controls.cancelled;
      (this as unknown as Record<string, unknown>)["cancelAsyncMessage"] = async (uuid: string) => {
        this.cancelRequests.push(uuid);
        return cancelled(uuid);
      };
    }
  }

  /** Reads the streaming input as the CLI does, for the whole life of the query. */
  async #read(prompt: AsyncIterable<SDKUserMessage>): Promise<void> {
    try {
      for await (const message of prompt) {
        this.prompts.push(message);
        for (const wake of this.#promptWaiters.splice(0)) wake();
      }
    } finally {
      // Ended or failed: whoever waits for more prompts is told there will be none.
      this.promptEnded = true;
      for (const wake of this.#promptWaiters.splice(0)) wake();
    }
  }

  /** The environment the CLI would have been spawned with. */
  get env(): Record<string, string | undefined> {
    return this.options.env ?? {};
  }

  /** Resolves once the adapter has pushed `count` prompts in all. */
  async promptsPushed(count: number): Promise<SDKUserMessage[]> {
    while (this.prompts.length < count) {
      if (this.promptEnded) throw new Error(`The prompt stream ended after ${this.prompts.length} prompt(s), not ${count}.`);
      await new Promise<void>((resolve) => this.#promptWaiters.push(resolve));
    }
    return this.prompts;
  }

  /** The SDK yields these, in order. */
  emit(...messages: Message[]): void {
    for (const message of messages) {
      const waiting = this.#waiting;
      if (waiting !== undefined) {
        this.#waiting = undefined;
        waiting.resolve({ value: message, done: false });
      } else this.#messages.push(message);
    }
  }

  /** The transport ends cleanly. */
  end(): void {
    this.#done = true;
    this.#wake();
  }

  /** The transport fails. */
  fail(error: unknown): void {
    this.#failure = { error };
    this.#wake();
  }

  #wake(): void {
    const waiting = this.#waiting;
    if (waiting === undefined) return;
    this.#waiting = undefined;
    if (this.#failure !== undefined) waiting.reject(this.#failure.error);
    else waiting.resolve({ value: undefined, done: true });
  }

  /**
   * The query's messages, read one at a time: the adapter's one reader, the
   * process's pump, awaits each `next()` before asking again and never leaves
   * one waiting. A second read while one waits would take the next message
   * from it, so it is refused rather than let a test pass on a lost message.
   */
  [Symbol.asyncIterator](): AsyncIterator<Message> {
    return {
      next: () =>
        new Promise<IteratorResult<Message>>((resolve, reject) => {
          if (this.#messages.length > 0) return resolve({ value: this.#messages.shift(), done: false });
          if (this.#failure !== undefined) return reject(this.#failure.error);
          if (this.#done || this.closed) return resolve({ value: undefined, done: true });
          if (this.#waiting !== undefined) return reject(new Error("The fake query is read one read at a time; a read is already waiting."));
          this.#waiting = { resolve, reject };
        }),
      return: async () => ({ value: undefined, done: true }),
    };
  }

  /** Asks the adapter's `canUseTool`, as the CLI does over the control channel. */
  canUseTool(toolName: string, input: Record<string, unknown>, extra: Partial<Parameters<CanUseTool>[2]> = {}) {
    const ask = this.options.canUseTool;
    if (ask === undefined) throw new Error("The run passed no canUseTool.");
    return ask(toolName, input, { signal: new AbortController().signal, toolUseID: `toolu_${Math.random().toString(36).slice(2)}`, requestId: crypto.randomUUID(), ...extra });
  }

  /**
   * Runs the `PreToolUse` hooks the run registered, as the CLI does before
   * its own evaluation of a tool call, and answers what the last one said.
   * `signal` is the one the SDK hands the callback: the CLI's cancel of the
   * hook's request (its timeout, the turn's interrupt) aborts it.
   */
  async preToolUse(toolName: string, input: Record<string, unknown>, extra: ToolHookExtra = {}): Promise<HookJSONOutput> {
    if ((this.options.hooks?.PreToolUse ?? []).length === 0) throw new Error("The run registered no PreToolUse hook.");
    return this.#toolHooks("PreToolUse", toolName, input, {}, extra);
  }

  /** Runs the `PostToolUse` hooks whose matcher takes the tool, as the CLI does once a call succeeded, with what the tool answered. */
  async postToolUse(toolName: string, input: Record<string, unknown>, response: unknown, extra: ToolHookExtra = {}): Promise<HookJSONOutput> {
    return this.#toolHooks("PostToolUse", toolName, input, { tool_response: response }, extra);
  }

  /** Runs the `PostToolUseFailure` hooks whose matcher takes the tool, as the CLI does once a call threw, with its error. */
  async postToolUseFailure(toolName: string, input: Record<string, unknown>, error: string, extra: ToolHookExtra = {}): Promise<HookJSONOutput> {
    return this.#toolHooks("PostToolUseFailure", toolName, input, { error }, extra);
  }

  /**
   * Runs an event's hooks whose matcher takes the tool, one after another,
   * and answers what the last one said. The CLI runs them in parallel; every
   * run registers one callback per event, for which the two are the same.
   */
  async #toolHooks(event: HookEvent, toolName: string, input: Record<string, unknown>, fields: Record<string, unknown>, extra: ToolHookExtra): Promise<HookJSONOutput> {
    const toolUseID = extra.toolUseID ?? `toolu_${Math.random().toString(36).slice(2)}`;
    const hookInput = {
      hook_event_name: event,
      session_id: "s",
      transcript_path: "/tmp/transcript.jsonl",
      cwd: "/work/repo",
      tool_name: toolName,
      tool_input: input,
      tool_use_id: toolUseID,
      ...fields,
      ...(extra.agentId !== undefined && { agent_id: extra.agentId }),
    } as HookInput;
    let output: HookJSONOutput = {};
    for (const matcher of this.options.hooks?.[event] ?? []) {
      if (!matcherTakes(matcher.matcher, toolName)) continue;
      for (const hook of matcher.hooks) output = await hook(hookInput, toolUseID, { signal: extra.signal ?? new AbortController().signal });
    }
    return output;
  }

  /**
   * Calls a tool of an in-process server the run was given, as the CLI
   * does: an MCP client connected to the server's instance over MCP's
   * in-memory transport, the call naming its `tool_use` id in `_meta`.
   * Answers the content blocks the CLI would receive.
   */
  async callTool(server: string, tool: string, args: Record<string, unknown>, toolUseID = `toolu_${Math.random().toString(36).slice(2)}`): Promise<CallToolResult> {
    const config = this.options.mcpServers?.[server];
    if (config === undefined || config.type !== "sdk" || !("instance" in config)) throw new Error(`The run was given no in-process server ${server}.`);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await (config as McpSdkServerConfigWithInstance).instance.connect(serverSide);
    const client = new Client({ name: "claude-code", version: "fake" });
    await client.connect(clientSide);
    try {
      return (await client.callTool({ name: tool, arguments: args, _meta: { "claudecode/toolUseId": toolUseID } })) as CallToolResult;
    } finally {
      await client.close();
    }
  }

  // The pinned SDK's run-time signature: `interrupt(e)`, taking `{cancelQueued}` its declarations omit.
  async interrupt(options?: { cancelQueued?: boolean }): Promise<{ still_queued: string[]; cancelled?: string[] } | undefined> {
    this.interrupts += 1;
    this.interruptOptions.push(options);
    return this.controls.interruptReceipt?.(options) ?? { still_queued: [], ...(options?.cancelQueued === true && { cancelled: [] }) };
  }

  async setModel(model?: string): Promise<void> {
    if (model !== undefined) this.models.push(model);
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.modes.push(mode);
  }

  async applyFlagSettings(settings: unknown): Promise<void> {
    this.flags.push(settings);
    await this.controls.flagSettings?.();
  }

  async stopTask(taskId: string): Promise<void> {
    this.stoppedTasks.push(taskId);
    await this.controls.stopTask?.(taskId);
  }

  async accountInfo(): Promise<{ email?: string; organization?: string }> {
    return this.controls.accountInfo?.() ?? { email: "david@example.com", organization: "David's Organization" };
  }

  async supportedModels(): Promise<unknown[]> {
    return this.controls.supportedModels?.() ?? [];
  }

  async supportedCommands(): Promise<SlashCommand[]> {
    return this.controls.supportedCommands?.() ?? [];
  }

  close(): void {
    this.closed = true;
    this.#done = true;
    this.#wake();
  }
}

/** Every query the adapter made, in order, and the controls the next ones get. */
export class FakeSdk {
  readonly queries: FakeQuery[] = [];
  controls: FakeControls = {};
  /** What `getSessionMessages` answers, per provider session. */
  readonly stored = new Map<string, { type: string; uuid: string; message?: unknown }[]>();
  readonly storedReads: { sessionId: string; options: unknown; configDir: string | undefined }[] = [];
  /** The `made(count)` calls still waiting, by count. */
  readonly #madeWaiters = new Map<number, ((query: FakeQuery) => void)[]>();

  readonly query = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): FakeQuery => {
    const made = new FakeQuery(params, this.controls);
    this.queries.push(made);
    for (const resolve of this.#madeWaiters.get(this.queries.length) ?? []) resolve(made);
    this.#madeWaiters.delete(this.queries.length);
    return made;
  };

  readonly getSessionMessages = async (sessionId: string, options: unknown) => {
    this.storedReads.push({ sessionId, options, configDir: process.env["CLAUDE_CONFIG_DIR"] });
    return (this.stored.get(sessionId) ?? []).map((entry) => ({ ...entry, session_id: sessionId, parent_tool_use_id: null, parent_agent_id: null }));
  };

  /** The last query the adapter made, of any kind: a run's, or an unsampled control query's (models, commands, usage). */
  last(): FakeQuery {
    const found = this.queries.at(-1);
    if (found === undefined) throw new Error("The adapter made no query.");
    return found;
  }

  /** Resolves once the adapter has made `count` queries: it waits on that query itself, so the test's own timeout is the only bound (#1761). */
  made(count: number): Promise<FakeQuery> {
    const found = this.queries[count - 1];
    if (found !== undefined) return Promise.resolve(found);
    return new Promise((resolve) => this.#madeWaiters.set(count, [...(this.#madeWaiters.get(count) ?? []), resolve]));
  }
}

/** SDK messages a test emits, in the pinned SDK's shapes. */
export const sdk = {
  init: (sessionId: string, extra: Record<string, unknown> = {}) => ({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    cwd: "/work/repo",
    model: "claude-opus-5",
    tools: [],
    mcp_servers: [],
    permissionMode: "acceptEdits",
    slash_commands: [],
    apiKeySource: "none",
    claude_code_version: "2.1.281",
    output_style: "default",
    skills: [],
    plugins: [],
    capabilities: ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1"],
    uuid: crypto.randomUUID(),
    ...extra,
  }),
  /** The first reply of a turn, stamped with the prompts it consumed. */
  replyStart: (messageId: string, owners: readonly string[]) => ({
    type: "stream_event",
    event: { type: "message_start", message: { id: messageId, type: "message", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    parent_tool_use_id: null,
    session_id: "s",
    uuid: crypto.randomUUID(),
    ...(owners.length > 0 && { user_message_uuid: owners.at(-1), user_message_uuids: [...owners] }),
  }),
  textDelta: (index: number, text: string) => ({
    type: "stream_event",
    event: { type: "content_block_delta", index, delta: { type: "text_delta", text } },
    parent_tool_use_id: null,
    session_id: "s",
    uuid: crypto.randomUUID(),
  }),
  blockStart: (index: number) => ({
    type: "stream_event",
    event: { type: "content_block_start", index, content_block: { type: "text", text: "" } },
    parent_tool_use_id: null,
    session_id: "s",
    uuid: crypto.randomUUID(),
  }),
  text: (messageId: string, text: string, owners: readonly string[] = []) => ({
    type: "assistant",
    message: { id: messageId, type: "message", role: "assistant", model: "claude-opus-5", content: [{ type: "text", text }], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } },
    parent_tool_use_id: null,
    session_id: "s",
    uuid: crypto.randomUUID(),
    ...(owners.length > 0 && { user_message_uuid: owners.at(-1), user_message_uuids: [...owners] }),
  }),
  toolUse: (id: string, name: string, input: Record<string, unknown> = {}) => ({
    type: "assistant",
    message: { id: `msg_${id}`, type: "message", role: "assistant", model: "claude-opus-5", content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } },
    parent_tool_use_id: null,
    session_id: "s",
    uuid: crypto.randomUUID(),
  }),
  toolResult: (id: string, content: unknown = "ok", isError = false) => ({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
    parent_tool_use_id: null,
    session_id: "s",
    uuid: crypto.randomUUID(),
  }),
  tasks: (...tasks: { task_id: string; description?: string }[]) => ({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: tasks.map((task) => ({ task_type: "local_agent", description: "Background work", ...task })),
    session_id: "s",
    uuid: crypto.randomUUID(),
  }),
  taskNotification: (taskId: string, status = "completed") => ({
    type: "system",
    subtype: "task_notification",
    task_id: taskId,
    status,
    output_file: "/tmp/out",
    summary: "Done.",
    session_id: "s",
    uuid: crypto.randomUUID(),
  }),
  rateLimit: (window: string, status: string, utilization?: number) => ({
    type: "rate_limit_event",
    rate_limit_info: { status, rateLimitType: window, ...(utilization !== undefined && { utilization }) },
    session_id: "s",
    uuid: crypto.randomUUID(),
  }),
  result: (sessionId: string, extra: Record<string, unknown> = {}) => ({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 10,
    duration_api_ms: 9,
    num_turns: 1,
    result: "Done.",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
    permission_denials: [],
    session_id: sessionId,
    uuid: crypto.randomUUID(),
    ...extra,
  }),
  interruptedResult: (sessionId: string) => ({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    duration_ms: 10,
    duration_api_ms: 9,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
    permission_denials: [],
    errors: ["Request was aborted."],
    session_id: sessionId,
    uuid: crypto.randomUUID(),
  }),
};
