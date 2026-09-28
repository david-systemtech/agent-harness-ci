import { z } from "zod";
import { MessageDelivery, MessageId, RunId } from "./adapter.js";
import { AttachmentInput } from "./methods/runs.js";
import { ClampReason } from "./permissions.js";
import { Mode } from "./permissions-modes.js";
import { JsonObject, Sequence } from "./primitives.js";
import { AutoDecider, PromptDecisionValue, PromptKind } from "./prompts.js";
import { SessionId } from "./sessions.js";
import { InterruptCause, RunEndReason, ToolStatus } from "./transcript.js";

/**
 * The completions surface (claude-adapter spec, "The completions surface";
 * ADR 0015): the OpenAI-shaped HTTP routes programs such as the Hermes bots
 * talk to, on the wire's port, authenticated by the bearer token of a client
 * session of kind `program`. What is fixed here is what crosses HTTP: the
 * paths, the request with the harness's extension namespace, the chunk and
 * the whole completion the answer takes, the model listing, and the error
 * body. The environment's `completions/` module serves them.
 */

/** The extension namespace the harness's own fields travel in, on requests and on answers. */
export const COMPLETIONS_NAMESPACE = "agent-harness";

/** Where the OpenAI-shaped routes live: every other path under it answers 501 with a sentence. */
export const OPENAI_PATH_PREFIX = "/v1/";

/** The chat completion route. */
export const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

/** The model listing; `/v1/models/<id>` reads one, the id being the rest of the path, slash and all. */
export const MODELS_PATH = "/v1/models";

/** The most characters `systemPrompt` carries, and the most a request appends to the composed instructions in all. */
export const MAX_SYSTEM_PROMPT_CHARS = 200_000;

/** How long a stream may be silent before an SSE comment goes out, so a quiet tool call never looks like a dead socket (a measured pacing). */
export const COMPLETIONS_HEARTBEAT_MS = 15_000;

/** OpenAI parameters the surface cannot honour: refused with 400 unless the request sets `ignoreUnsupported`, then ignored and reported. */
export const REJECTED_PARAMETERS = [
  "response_format",
  "temperature",
  "top_p",
  "seed",
  "n",
  "logprobs",
  "top_logprobs",
  "frequency_penalty",
  "presence_penalty",
  "logit_bias",
] as const;

/** OpenAI parameters that change nothing here: ignored, and reported as ignored. */
export const IGNORED_PARAMETERS = ["user", "metadata", "store", "service_tier", "parallel_tool_calls"] as const;

/**
 * How long a caller has to answer a call to one of its own tools (#139,
 * client-tool passthrough): the call's handler stays parked this long, then
 * the model is handed an error result for it and the run goes on. Ten
 * minutes, a chosen default.
 */
export const CLIENT_TOOL_CALL_EXPIRY_MS = 10 * 60_000;

/** The most tools a request declares, as OpenAI takes. */
export const MAX_CLIENT_TOOLS = 128;

/** What a tool's name may be, as OpenAI takes it: 1 to 64 letters, digits, underscores and hyphens. */
export const CLIENT_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The harness's fields on a request, under `agent-harness`. Every field may
 * be absent or null; null is taken as absent. `forkSession` and
 * `rewindToMessageId` go through `sessions.fork` and `sessions.rewind`
 * (#137).
 */
export const CompletionsExtension = z
  .object({
    sessionId: SessionId.nullish().meta({ description: "The session to continue; a fresh session when absent. The answer carries the session's id." }),
    permissionMode: Mode.nullish().meta({
      description: "The mode the turn asks for: clamped to the client session's ceiling, and the clamp reported as agent-harness.clamped on the first chunk; the unattended default when absent.",
    }),
    systemPrompt: z
      .string()
      .max(MAX_SYSTEM_PROMPT_CHARS)
      .nullish()
      .meta({ description: "Text appended after the environment's composed instructions, never replacing them; at most 200,000 characters." }),
    alwaysOnSkills: z
      .array(z.string().min(1))
      .nullish()
      .meta({ description: "Accepted and reported as ignored on the first chunk until the skill set (ticket 89) honours it." }),
    forkSession: z.boolean().nullish().meta({ description: "Run the turn on a fork of sessionId rather than on sessionId itself." }),
    rewindToMessageId: MessageId.nullish().meta({ description: "Rewind sessionId to this user message before the turn runs." }),
    attachments: z.array(AttachmentInput).max(20).nullish().meta({ description: "Images or files sent with the trailing user message." }),
    thinking: z.string().min(1).nullish().meta({ description: "The reasoning effort; the top-level reasoning_effort is its alias." }),
    workspace: z
      .string()
      .min(1)
      .nullish()
      .meta({
        description:
          "A directory the environment has, for a fresh session: an absolute path, or one from its home (~); one it cannot use is refused 400 with its problem. With none the session gets a scratch workspace of its own.",
      }),
    attended: z
      .boolean()
      .nullish()
      .meta({ description: "A person is present to answer prompts: they park until a client answers. False when absent: the unattended rule answers them." }),
    after: Sequence.nullish().meta({ description: "On a session whose run is live, the log sequence to attach from: the events of the run after it are sent first." }),
    ignoreUnsupported: z.boolean().nullish().meta({ description: "Ignore, and report, the OpenAI parameters the surface would otherwise refuse with 400." }),
  })
  .meta({ description: "The harness's fields on a completions request, under agent-harness." });
export type CompletionsExtension = z.infer<typeof CompletionsExtension>;

/** Who wrote a message of the conversation. */
export const CHAT_ROLES = ["system", "developer", "user", "assistant", "tool"] as const;
export const ChatRole = z.enum(CHAT_ROLES).meta({
  description: "Who wrote a message: system or developer (instructions, appended after the composed ones), user, assistant, or tool (a tool's result).",
});
export type ChatRole = z.infer<typeof ChatRole>;

/** One part of a message's content; only text parts are read. */
export const ChatContentPart = z
  .looseObject({
    type: z.string().min(1).meta({ description: "The part's kind: text is read; images travel as agent-harness.attachments." }),
    text: z.string().optional(),
  })
  .meta({ description: "One part of a message's content." });
export type ChatContentPart = z.infer<typeof ChatContentPart>;

/** A message of the conversation as OpenAI shapes it. */
export const ChatMessage = z
  .looseObject({
    role: ChatRole,
    content: z.union([z.string(), z.array(ChatContentPart)]).nullish(),
    name: z.string().nullish(),
    tool_call_id: z.string().nullish(),
    tool_calls: z.array(z.looseObject({})).nullish(),
  })
  .meta({ description: "A message of the conversation: its role and its content, a string or text parts." });
export type ChatMessage = z.infer<typeof ChatMessage>;

/** A function the caller declares: the model may call it, and the call comes back to the caller to run (#139). */
export const ChatToolFunction = z
  .looseObject({
    name: z.string().regex(CLIENT_TOOL_NAME_PATTERN).meta({ description: "1 to 64 letters, digits, underscores and hyphens; unique among the request's tools." }),
    description: z.string().nullish(),
    parameters: JsonObject.nullish().meta({
      description: "The call's arguments as a JSON Schema object, handed to the model as written; an object with no properties when absent.",
    }),
    strict: z.boolean().nullish().meta({ description: "Not honoured: reported ignored when true." }),
  })
  .meta({ description: "A function the caller declares and runs itself." });
export type ChatToolFunction = z.infer<typeof ChatToolFunction>;

/**
 * One of the caller's tools, as OpenAI shapes it. Only functions are served:
 * another type is refused unless the request ignores what it cannot honour.
 */
export const ChatTool = z
  .looseObject({
    type: z.string().min(1).meta({ description: "function; another type is refused with 400, or ignored under ignoreUnsupported." }),
    function: ChatToolFunction.optional(),
  })
  .meta({ description: "A tool the caller declares: the model's calls to it come back as tool_calls, and the caller sends each result as a tool message." });
export type ChatTool = z.infer<typeof ChatTool>;

/**
 * Whether the model may call the caller's tools: `auto` (the default) or
 * `none` (the tools are withheld from the run). `required` and a named
 * function are refused with 400, or ignored under `ignoreUnsupported`.
 */
export const ChatToolChoice = z
  .union([
    z.string().min(1),
    z.looseObject({ type: z.string().min(1), function: z.looseObject({ name: z.string().min(1) }).optional() }),
  ])
  .meta({ description: "auto or none; required and a named function are refused, or ignored under ignoreUnsupported." });
export type ChatToolChoice = z.infer<typeof ChatToolChoice>;

/**
 * `POST /v1/chat/completions`: OpenAI's request, read loosely. The trailing
 * message is the user's, the turn; or it is one or more tool messages, the
 * results of calls to the caller's tools (#139), which resume the parked
 * turn that made them. Parameters outside the ones named here are ignored.
 */
export const ChatCompletionRequest = z
  .looseObject({
    model: z.string().min(1).meta({ description: "<account label slug>/<model or family>, or a bare model or family on the default account." }),
    messages: z.array(ChatMessage).min(1),
    stream: z.boolean().nullish(),
    stream_options: z.looseObject({ include_usage: z.boolean().nullish() }).nullish(),
    max_tokens: z.int().positive().nullish().meta({ description: "Bounds the answer: it stops at about this many tokens (four characters each), finish_reason length." }),
    max_completion_tokens: z.int().positive().nullish().meta({ description: "The newer name of max_tokens; max_tokens wins when both are set." }),
    stop: z
      .union([z.string().min(1), z.array(z.string().min(1)).max(4)])
      .nullish()
      .meta({ description: "Up to four sequences the answer stops before, finish_reason stop." }),
    reasoning_effort: z.string().min(1).nullish().meta({ description: "An alias of agent-harness.thinking, which wins when both are set." }),
    tools: z
      .array(ChatTool)
      .max(MAX_CLIENT_TOOLS)
      .nullish()
      .meta({ description: "The caller's own tools: served to the run, each call handed back as tool_calls and answered by a follow-up's tool messages." }),
    tool_choice: ChatToolChoice.nullish(),
    [COMPLETIONS_NAMESPACE]: CompletionsExtension.nullish(),
  })
  .meta({ description: "A chat completion request, OpenAI's shape with the harness's extension namespace." });
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequest>;

/** Why an answer ended. */
export const COMPLETION_FINISH_REASONS = ["stop", "length", "tool_calls", "error"] as const;
export const CompletionFinishReason = z.enum(COMPLETION_FINISH_REASONS).meta({
  description:
    "Why the answer ended: stop (the run completed, or a stop sequence), length (max_tokens), tool_calls (the model called the caller's tools: send their results to resume the turn), or error (the run ended any other way; the chunk carries error).",
});
export type CompletionFinishReason = z.infer<typeof CompletionFinishReason>;

/** A call the model made to one of the caller's tools, parked until the caller answers it with a tool message naming its id. */
export const ChatToolCall = z
  .object({
    id: z.string().min(1).meta({ description: "Minted by the environment: the follow-up's tool message names it as tool_call_id." }),
    type: z.literal("function"),
    function: z.object({
      name: z.string().min(1).meta({ description: "The tool's name as the request declared it." }),
      arguments: z.string().meta({ description: "The call's arguments, as JSON text." }),
    }),
  })
  .meta({ description: "A call to one of the caller's tools." });
export type ChatToolCall = z.infer<typeof ChatToolCall>;

/** A call to one of the caller's tools as a chunk's delta carries it: whole, in one chunk, at its index among the answer's calls. */
export const ChatToolCallDelta = ChatToolCall.extend({ index: z.int().nonnegative() }).meta({
  description: "A call to one of the caller's tools, whole, at its index among the calls of the answer.",
});
export type ChatToolCallDelta = z.infer<typeof ChatToolCallDelta>;

/** The mode a request asked for, lowered: what it got, under which ceiling, and why. */
export const CompletionsClamp = z
  .object({ requested: Mode, effective: Mode, ceiling: Mode, reason: ClampReason })
  .meta({ description: "A permissionMode the turn could not have: the mode it got instead, the ceiling, and why." });
export type CompletionsClamp = z.infer<typeof CompletionsClamp>;

/** The agent's own work, which never appears as tool_calls: it rides agent-harness.activity on a chunk with an empty delta. */
export const CompletionsActivity = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("tool.started"), toolCallId: z.string().min(1), name: z.string().min(1), title: z.string().nullable() }),
    z.object({ type: z.literal("tool.ended"), toolCallId: z.string().min(1), status: ToolStatus }),
    z.object({ type: z.literal("prompt.opened"), promptId: z.string().min(1), kind: PromptKind, summary: z.string() }),
    z.object({
      type: z.literal("prompt.answered"),
      promptId: z.string().min(1),
      decision: PromptDecisionValue,
      auto: AutoDecider.nullable().meta({ description: "The rule that answered; null when a person did." }),
    }),
  ])
  .meta({ description: "What the agent did that is not text: a tool call it started or ended, a prompt raised or answered." });
export type CompletionsActivity = z.infer<typeof CompletionsActivity>;

/** How the run an answer followed ended, on the final chunk. */
export const CompletionsRunEnd = z
  .object({ reason: RunEndReason, cause: InterruptCause.nullable() })
  .meta({ description: "How the run ended: its run.ended reason and, for an interrupted one, the cause." });
export type CompletionsRunEnd = z.infer<typeof CompletionsRunEnd>;

/**
 * The harness's fields on an answer, under `agent-harness`: on every chunk
 * `seq`, the log sequence of the event the chunk renders (a chunk carrying
 * a call to the caller's tools, which no event renders, the last one before
 * it); on the first, the session, the run, the message the turn was sent as,
 * the clamp and what was ignored; on the non-streaming answer, all of them
 * with the last event's sequence.
 */
export const CompletionsAnswerExtension = z
  .object({
    seq: Sequence.meta({ description: "The log sequence of the event the chunk renders; never decreasing along a stream." }),
    sessionId: SessionId.optional().meta({ description: "The session the turn ran on: continue it by sending it back as agent-harness.sessionId." }),
    runId: RunId.optional(),
    messageId: MessageId.optional().meta({
      description: "The message the turn was sent as: the prompt of a new run, or a steer. Absent on the answer to tool results, which resume a turn and send no message.",
    }),
    delivery: MessageDelivery.exclude(["steered"])
      .optional()
      .meta({
        description:
          "How the turn's message was sent, on the first chunk: prompt (it started a run), or queued (a run was live on the session; the answer follows the live run and then whichever run reads the message). Absent on the answer to tool results.",
      }),
    mode: Mode.optional().meta({ description: "The mode the run the answer follows is in." }),
    clamped: CompletionsClamp.nullable().optional().meta({ description: "The permissionMode asked for and lowered; null when nothing was." }),
    ignored: z.array(z.string().min(1)).optional().meta({ description: "The parameters and fields accepted and ignored, as request paths: temperature, agent-harness.alwaysOnSkills." }),
    activity: CompletionsActivity.optional(),
    ended: CompletionsRunEnd.optional(),
    waiting: MessageId.optional().meta({ description: "The turn's queued message still waits in the session's queue: the run it was sent to ended before reading it." }),
  })
  .meta({ description: "The harness's fields on an answer or a chunk." });
export type CompletionsAnswerExtension = z.infer<typeof CompletionsAnswerExtension>;

/** Token use as OpenAI reports it, from the run's usage.reported. */
export const CompletionUsage = z
  .object({
    prompt_tokens: z.int().nonnegative(),
    completion_tokens: z.int().nonnegative(),
    total_tokens: z.int().nonnegative(),
    prompt_tokens_details: z.object({ cached_tokens: z.int().nonnegative() }),
  })
  .meta({ description: "The run's token use: input with cache reads and writes as prompt tokens, output as completion tokens." });
export type CompletionUsage = z.infer<typeof CompletionUsage>;

/** An error as OpenAI's body carries it, with the harness's reason as the code. */
export const CompletionsErrorDetail = z
  .object({
    message: z.string().min(1),
    type: z.string().min(1).meta({ description: "OpenAI's error family: invalid_request_error, authentication_error, permission_error, not_found_error, conflict_error, server_error." }),
    code: z.string().min(1).nullable().meta({ description: "The harness's reason: unauthorized, forbidden, model_not_found, run_active, unavailable." }),
    param: z.string().nullable().meta({ description: "The request field at fault, when one is." }),
  })
  .meta({ description: "What went wrong, as OpenAI shapes it." });
export type CompletionsErrorDetail = z.infer<typeof CompletionsErrorDetail>;

/** Every refusal's body, and a failed non-streaming turn's. */
export const CompletionsErrorBody = z
  .object({
    error: CompletionsErrorDetail,
    [COMPLETIONS_NAMESPACE]: z
      .object({ sessionId: SessionId.optional(), runId: RunId.optional(), ended: CompletionsRunEnd.optional() })
      .optional()
      .meta({ description: "The session and run a failed turn ran on, when it got that far." }),
  })
  .meta({ description: "An OpenAI-style error body." });
export type CompletionsErrorBody = z.infer<typeof CompletionsErrorBody>;

/** One chunk of a streamed answer, sent as an SSE data line. */
export const ChatCompletionChunk = z
  .object({
    id: z.string().min(1),
    object: z.literal("chat.completion.chunk"),
    created: z.int().nonnegative(),
    model: z.string().min(1),
    choices: z.array(
      z.object({
        index: z.int().nonnegative(),
        delta: z.object({ role: z.literal("assistant").optional(), content: z.string().optional(), tool_calls: z.array(ChatToolCallDelta).optional() }),
        finish_reason: CompletionFinishReason.nullable(),
      }),
    ),
    usage: CompletionUsage.optional().meta({ description: "On the usage chunk, sent last when stream_options.include_usage asks for it; its choices are empty." }),
    error: CompletionsErrorDetail.optional().meta({ description: "On the final chunk of a run that did not complete." }),
    [COMPLETIONS_NAMESPACE]: CompletionsAnswerExtension,
  })
  .meta({ description: "One chunk of a streamed chat completion, in OpenAI's order, with the harness's fields." });
export type ChatCompletionChunk = z.infer<typeof ChatCompletionChunk>;

/** A whole, non-streamed answer. */
export const ChatCompletion = z
  .object({
    id: z.string().min(1),
    object: z.literal("chat.completion"),
    created: z.int().nonnegative(),
    model: z.string().min(1),
    choices: z
      .array(
        z.object({
          index: z.int().nonnegative(),
          message: z.object({ role: z.literal("assistant"), content: z.string(), tool_calls: z.array(ChatToolCall).min(1).optional() }),
          finish_reason: CompletionFinishReason,
        }),
      )
      .length(1),
    usage: CompletionUsage.optional().meta({ description: "The run's usage; absent when a stop sequence or max_tokens ended the answer before the run did." }),
    [COMPLETIONS_NAMESPACE]: CompletionsAnswerExtension,
  })
  .meta({ description: "A whole chat completion: the assistant's message and the run's usage." });
export type ChatCompletion = z.infer<typeof ChatCompletion>;

/** One model of a signed-in account's catalogue. */
export const CompletionsModel = z
  .object({
    id: z.string().min(1).meta({ description: "<account label slug>/<model>: send it as model, or read it at /v1/models/<id>." }),
    object: z.literal("model"),
    created: z.int().nonnegative(),
    owned_by: z.string().min(1).meta({ description: "The provider." }),
    family: z.string().min(1),
    tier: z.int().meta({ description: "The adapter's ordinal tier: higher is stronger." }),
    [COMPLETIONS_NAMESPACE]: z.object({
      account: z.string().min(1).meta({ description: "The account's label." }),
      accountId: z.string().min(1),
    }),
  })
  .meta({ description: "A model a signed-in account offers, with its family, tier and account." });
export type CompletionsModel = z.infer<typeof CompletionsModel>;

/** `GET /v1/models`: every signed-in account's catalogue. */
export const CompletionsModelList = z
  .object({ object: z.literal("list"), data: z.array(CompletionsModel) })
  .meta({ description: "Every model of every signed-in account." });
export type CompletionsModelList = z.infer<typeof CompletionsModelList>;
