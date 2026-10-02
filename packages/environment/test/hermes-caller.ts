import { CHAT_COMPLETIONS_PATH, COMPLETIONS_NAMESPACE, ChatCompletionChunk, type ChatMessage, type ChatToolCall, type CompletionsAnswerExtension } from "@agent-harness/contracts";

/**
 * A scripted Hermes caller (switch-over spec, "Hermes cut-over and Bank
 * migration"; #1193): the requests the pinned Hermes (v2026.9.24, commit
 * f97608f) sends a chat-completions provider, with the butler's deployment
 * settings in the built `agent-harness` namespace, posted over real HTTP
 * with a program's bearer token and read back as SSE; and the agent loop
 * Hermes runs on an answer: a call to one of its tools is run here and its
 * result sent back as a tool message naming the call's id, until an answer
 * stops. Nothing here reaches a real Hermes, a provider or the network.
 *
 * Where each shape is read from, in Hermes's source at that tag:
 * - **A chat turn**: `agent/transports/chat_completions.py` (`_base_kwargs`:
 *   the model, the system prompt and the whole conversation as `messages`,
 *   its tools with no `tool_choice`, no temperature on a custom route), the
 *   custom provider's profile (`plugins/model-providers/custom`: a top-level
 *   `reasoning_effort`, `medium` when the agent sets none), streamed with
 *   `stream_options.include_usage` (`agent/chat_completion_helpers.py`), and
 *   the named provider's `extra_body` merged into the body
 *   (`agent/agent_init.py`), which is where the namespace rides.
 * - **An auxiliary call** (`agent/auxiliary_client.py`, `call_llm`): its own
 *   `auxiliary.<task>.extra_body` and `reasoning_effort` only, never the
 *   provider's `extra_body` (`_get_task_extra_body`); compression sends one
 *   user message and no `max_tokens` (`agent/context_compressor.py`); the
 *   title call sends a system and a user message, `max_tokens` 512, a JSON
 *   schema `response_format` and its reasoning off, which the custom profile
 *   sends as `reasoning_effort: none` (`agent/title_generator.py`).
 */

/** Hermes's own system prompt, as it opens every request: the persona file and its procedures. A fixture's text, not the deployed one. */
export const HERMES_SYSTEM_PROMPT = "You are Butler, David's assistant in a Matrix chat. Answer in plain words.";

/** The deployment's appended instructions, `systemPrompt` in the namespace. A fixture's text, not the deployed one. */
export const BUTLER_INSTRUCTIONS = "Output no text while working; write one final message when done.";

/** The deployment's fields for every chat turn: the named provider's `extra_body`, under the built namespace. */
export const BUTLER_EXTENSION = {
  ignoreUnsupported: true,
  systemPrompt: BUTLER_INSTRUCTIONS,
  permissionMode: "bypassPermissions",
  attended: false,
} as const;

const fn = (name: string, description: string, properties: Record<string, unknown>, required: readonly string[]) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

/** Hermes's tools as a chat turn declares them: the ones the deployment's turns send, their schemas cut down. */
export const HERMES_TOOLS = [
  fn("memory", "Save or remove a durable note about the user.", { action: { type: "string", enum: ["add", "remove"] }, content: { type: "string" } }, ["action"]),
  fn("skill_manage", "Create, edit or delete one of your skills.", { action: { type: "string" }, name: { type: "string" } }, ["action", "name"]),
  fn("cronjob_manage", "Schedule, list or remove a scheduled job.", { action: { type: "string" }, schedule: { type: "string" } }, ["action"]),
  fn("session_search", "Search earlier conversations.", { query: { type: "string" } }, ["query"]),
] as const;

/** A route a chat command picks (`/opus-xh`): a model id and the effort pinned in the namespace's `thinking`. */
export interface HermesRoute {
  readonly model: string;
  readonly thinking: string;
}

/** A chat turn's body as Hermes sends it: the conversation after the system prompt, and the session it names, if any. */
export const chatTurn = (route: HermesRoute, conversation: readonly ChatMessage[], sessionId: string | null): Record<string, unknown> => ({
  model: route.model,
  messages: [{ role: "system", content: HERMES_SYSTEM_PROMPT }, ...conversation],
  tools: HERMES_TOOLS,
  reasoning_effort: "medium",
  stream: true,
  stream_options: { include_usage: true },
  [COMPLETIONS_NAMESPACE]: { ...BUTLER_EXTENSION, thinking: route.thinking, ...(sessionId !== null && { sessionId }) },
});

/** The compression summary call: one user message, streamed, and only what the task's own configuration adds (`top` beside the messages, `extension` as its `extra_body`). */
export const compressionCall = (model: string, top: Record<string, unknown> = {}, extension?: Record<string, unknown>): Record<string, unknown> => ({
  model,
  messages: [{ role: "user", content: "Summarise the conversation so far for a later turn to continue from." }],
  stream: true,
  stream_options: { include_usage: true },
  ...top,
  ...(extension !== undefined && { [COMPLETIONS_NAMESPACE]: extension }),
});

/** The title call, with whatever the task's own `extra_body` adds as `extension`. */
export const titleCall = (model: string, extension?: Record<string, unknown>): Record<string, unknown> => ({
  model,
  messages: [
    { role: "system", content: 'Name this conversation in a few words. Answer as JSON: {"title": "..."}' },
    { role: "user", content: "What is on the calendar today?" },
  ],
  max_tokens: 512,
  response_format: {
    type: "json_schema",
    json_schema: { name: "session_title", strict: true, schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false } },
  },
  reasoning_effort: "none",
  ...(extension !== undefined && { [COMPLETIONS_NAMESPACE]: extension }),
});

/** A streamed answer as Hermes reads it: the text, the calls to its tools, why it ended, the chunks, and whether `[DONE]` closed it. */
export interface StreamedAnswer {
  readonly content: string;
  readonly toolCalls: readonly ChatToolCall[];
  readonly finishReason: string | null;
  readonly chunks: readonly ChatCompletionChunk[];
  /** The first chunk's harness fields: the session, the run, the clamp, what was ignored. */
  readonly head: CompletionsAnswerExtension;
  /** The harness fields of the chunk with the finish reason: how the run the answer followed ended. */
  readonly atFinish: CompletionsAnswerExtension | null;
  readonly done: boolean;
}

/** Posts a body to the completions route with the program's bearer token. */
export const postCompletion = (origin: string, token: string, body: Record<string, unknown>): Promise<Response> =>
  fetch(`${origin}${CHAT_COMPLETIONS_PATH}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

/** Reads an SSE answer to its end: each `data:` line a chunk checked against the contract, comments skipped, `[DONE]` noted. */
export const readStream = async (response: Response): Promise<StreamedAnswer> => {
  if (response.status !== 200) throw new Error(`The completion answered ${response.status}: ${await response.text()}`);
  const chunks: ChatCompletionChunk[] = [];
  let done = false;
  for (const block of (await response.text()).split("\n\n")) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data === "") continue;
    if (data === "[DONE]") done = true;
    else chunks.push(ChatCompletionChunk.parse(JSON.parse(data)));
  }
  const [first] = chunks;
  if (first === undefined) throw new Error("The stream carried no chunk.");
  const finished = chunks.findLast((chunk) => (chunk.choices[0]?.finish_reason ?? null) !== null);
  return {
    content: chunks.map((chunk) => chunk.choices[0]?.delta.content ?? "").join(""),
    toolCalls: chunks.flatMap((chunk) => chunk.choices[0]?.delta.tool_calls ?? []).map(({ id, type, function: called }) => ({ id, type, function: called })),
    finishReason: finished?.choices[0]?.finish_reason ?? null,
    chunks,
    head: first[COMPLETIONS_NAMESPACE],
    atFinish: finished?.[COMPLETIONS_NAMESPACE] ?? null,
    done,
  };
};

/** One chat turn as the caller ran it: every answer it read on the way (one per call round), and the last. */
export interface HermesTurn {
  readonly answers: readonly StreamedAnswer[];
  readonly final: StreamedAnswer;
}

export interface HermesCallerOptions {
  /** `http://<host>:<port>` of the environment. */
  readonly origin: string;
  /** The program's bearer token: the deployment's one credential. */
  readonly token: string;
  readonly route: HermesRoute;
  /** What each of Hermes's tools answers a call, by name. */
  readonly tools?: Readonly<Record<string, (args: unknown) => string>>;
  /**
   * Whether the caller sends back the session id an answer carried: `never`
   * as the pinned Hermes does, every turn a fresh session and a tool result
   * matched by its call's id alone; `sent`, on the tool follow-ups and the next
   * turn, as the spec's continuation asks and a `/keep` chat does.
   */
  readonly sessionIds: "never" | "sent";
}

export interface HermesCaller {
  /** Every body it posted, in order. */
  readonly sent: readonly Record<string, unknown>[];
  /** Runs a chat turn: `text` after the conversation so far, on `route` when given (a chat command), until an answer stops. */
  chat(text: string, route?: HermesRoute): Promise<HermesTurn>;
}

export const hermesCaller = (options: HermesCallerOptions): HermesCaller => {
  const conversation: ChatMessage[] = [];
  const sent: Record<string, unknown>[] = [];
  let sessionId: string | null = null;

  const post = async (route: HermesRoute): Promise<StreamedAnswer> => {
    const body = chatTurn(route, conversation, options.sessionIds === "sent" ? sessionId : null);
    sent.push(body);
    const answer = await readStream(await postCompletion(options.origin, options.token, body));
    sessionId = answer.head.sessionId ?? sessionId;
    return answer;
  };

  const run = (call: ChatToolCall): string => {
    const tool = options.tools?.[call.function.name];
    if (tool === undefined) throw new Error(`The caller has no tool ${call.function.name}.`);
    return tool(JSON.parse(call.function.arguments) as unknown);
  };

  return {
    sent,
    async chat(text, route = options.route) {
      conversation.push({ role: "user", content: text });
      const answers: StreamedAnswer[] = [];
      for (;;) {
        const answer = await post(route);
        answers.push(answer);
        if (answer.finishReason !== "tool_calls") {
          conversation.push({ role: "assistant", content: answer.content });
          return { answers, final: answer };
        }
        conversation.push({ role: "assistant", content: answer.content, tool_calls: answer.toolCalls.map((call) => ({ ...call })) });
        for (const call of answer.toolCalls) conversation.push({ role: "tool", tool_call_id: call.id, content: run(call) });
      }
    },
  };
};
