import type { CanUseTool, Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * The Agent SDK's transport, scripted (claude-adapter spec, "Testing
 * Decisions", the adapter seam; Artemis's `FakeQuery` in `claude.test.ts`):
 * a test replaces the SDK module with `vi.hoisted` and `vi.mock` and routes
 * `query()` here. Each call is a `FakeQuery`: it records the options it was
 * called with (the process's environment among them), reads the streaming
 * input as the CLI would, yields the SDK messages the test emits, and keeps
 * the control methods a test drives or inspects. Nothing is spawned and no
 * credential is used.
 */

type Message = unknown;

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
  /** What `cancelAsyncMessage` answers per uuid; absent means the method is absent. */
  cancelled?: (uuid: string) => boolean;
  accountInfo?: () => Promise<{ email?: string; organization?: string }>;
  /** The usage method: its name on the query, and its answer. */
  usage?: { readonly name: string; readonly answer: () => Promise<unknown> };
  supportedModels?: () => Promise<unknown[]>;
  supportedCommands?: () => Promise<{ name: string; description: string; argumentHint: string }[]>;
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
    if (typeof params.prompt !== "string") void this.#read(params.prompt);
    if (controls.usage !== undefined) {
      const { name, answer } = controls.usage;
      (this as unknown as Record<string, unknown>)[name] = async () => answer();
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
    for await (const message of prompt) {
      this.prompts.push(message);
      for (const wake of this.#promptWaiters.splice(0)) wake();
    }
    this.promptEnded = true;
  }

  /** The environment the CLI would have been spawned with. */
  get env(): Record<string, string | undefined> {
    return this.options.env ?? {};
  }

  /** Resolves once the adapter has pushed `count` prompts in all. */
  async promptsPushed(count: number): Promise<SDKUserMessage[]> {
    while (this.prompts.length < count) await new Promise<void>((resolve) => this.#promptWaiters.push(resolve));
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

  [Symbol.asyncIterator](): AsyncIterator<Message> {
    return {
      next: () =>
        new Promise<IteratorResult<Message>>((resolve, reject) => {
          if (this.#messages.length > 0) return resolve({ value: this.#messages.shift(), done: false });
          if (this.#failure !== undefined) return reject(this.#failure.error);
          if (this.#done || this.closed) return resolve({ value: undefined, done: true });
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

  async supportedCommands(): Promise<{ name: string; description: string; argumentHint: string }[]> {
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

  readonly query = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): FakeQuery => {
    const made = new FakeQuery(params, this.controls);
    this.queries.push(made);
    return made;
  };

  readonly getSessionMessages = async (sessionId: string, options: unknown) => {
    this.storedReads.push({ sessionId, options, configDir: process.env["CLAUDE_CONFIG_DIR"] });
    return (this.stored.get(sessionId) ?? []).map((entry) => ({ ...entry, session_id: sessionId, parent_tool_use_id: null, parent_agent_id: null }));
  };

  /** The run queries: those with a prompt that yields, as opposed to the unsampled control queries. */
  last(): FakeQuery {
    const found = this.queries.at(-1);
    if (found === undefined) throw new Error("The adapter made no query.");
    return found;
  }

  /** Resolves once the adapter has made `count` queries. */
  async made(count: number): Promise<FakeQuery> {
    for (let tries = 0; this.queries.length < count; tries += 1) {
      if (tries > 200) throw new Error(`The adapter made ${this.queries.length} queries, not ${count}.`);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    return this.queries[count - 1] as FakeQuery;
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
