import {
  COMPLETIONS_NAMESPACE,
  COMPLETIONS_NAMESPACE_ALIAS,
  ChatCompletionRequest,
  CompletionsExtension as ExtensionSchema,
  IGNORED_PARAMETERS,
  MAX_SYSTEM_PROMPT_CHARS,
  PASSTHROUGH_PARAMETERS,
  REJECTED_PARAMETERS,
  type AttachmentInput,
  type ChatMessage,
  type CompletionsExtension,
  type Mode,
} from "@agent-harness/contracts";
import { CompletionsRefusal, paramOf } from "./errors.js";

/**
 * A completions request read into a turn (claude-adapter spec, "The
 * completions surface"): the schema checked, the two namespaces merged (the
 * harness's key wins a field both set), the parameters it cannot honour
 * refused or, under `ignoreUnsupported`, ignored and reported, and the
 * messages split into the turn (the trailing user message), the instructions
 * it appends (system and developer messages) and the conversation before it.
 */

/** How many characters a token stands for when `max_tokens` bounds an answer: a chosen default, since no tokenizer runs here. */
export const CHARACTERS_PER_TOKEN = 4;

/** The extension's fields as the turn reads them: the namespaces merged, null taken as absent. */
export interface TurnExtension {
  readonly sessionId: string | null;
  readonly permissionMode: Mode | null;
  readonly systemPrompt: string | null;
  readonly alwaysOnSkills: readonly string[] | null;
  readonly forkSession: boolean;
  readonly rewindToMessageId: string | null;
  readonly attachments: readonly AttachmentInput[];
  readonly workspace: string | null;
  readonly attended: boolean;
  /** Whether the request set `attended` at all, so a turn that cannot use it reports it ignored. */
  readonly attendedSet: boolean;
  readonly after: number | null;
}

/** A request as a turn. */
export interface TurnRequest {
  readonly model: string;
  readonly stream: boolean;
  readonly includeUsage: boolean;
  /** The answer stops after about this many characters (`max_tokens` at `CHARACTERS_PER_TOKEN`); null for no bound. */
  readonly maxCharacters: number | null;
  readonly stop: readonly string[];
  readonly effort: string | null;
  /** Which field named the effort: `agent-harness.thinking`, else `reasoning_effort`; null for none. */
  readonly effortParam: string | null;
  readonly extension: TurnExtension;
  /** What was accepted and ignored, as request paths, in the order the surface reads them. */
  readonly ignored: readonly string[];
  /** The request's own instructions, after the composed ones: `systemPrompt`, then the system and developer messages in order. */
  readonly appendedInstructions: string;
  /** Where those came from, as request paths (`agent-harness.systemPrompt`, `messages.0`), for a turn that cannot take them to report. */
  readonly instructionSources: readonly string[];
  /** The turn: the trailing user message's text. */
  readonly text: string;
  /** The conversation before the turn, system and developer messages aside: the preamble of a fresh session. */
  readonly earlier: readonly ChatMessage[];
}

const invalid = (message: string, param: string | null): CompletionsRefusal => new CompletionsRefusal(400, "invalid_params", message, { param });

/** A field is set when it is present and not null. */
const isSet = (value: unknown): boolean => value !== undefined && value !== null;

/** The two namespaces as one: the alias's fields, then the harness's over them, a null standing for absent. */
const merged = (request: ChatCompletionRequest): CompletionsExtension => {
  const set = (extension: CompletionsExtension | null | undefined) =>
    Object.fromEntries(Object.entries(extension ?? {}).filter(([, value]) => isSet(value))) as CompletionsExtension;
  return { ...set(request[COMPLETIONS_NAMESPACE_ALIAS]), ...set(request[COMPLETIONS_NAMESPACE]) };
};

/**
 * A message's text: a string as it is, text parts joined with a newline.
 * Other parts are refused (images travel as `agent-harness.attachments`)
 * unless the request ignores what it cannot honour, when each is reported.
 */
const textOf = (message: ChatMessage, index: number, tolerate: boolean, ignored: string[]): string => {
  const { content } = message;
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  const texts: string[] = [];
  for (const [partIndex, part] of content.entries()) {
    if (part.type === "text") {
      texts.push(part.text ?? "");
      continue;
    }
    const path = `messages.${index}.content.${partIndex}`;
    if (!tolerate) {
      throw new CompletionsRefusal(400, "unsupported_content", `A ${part.type} part is not read here; send images and files as ${COMPLETIONS_NAMESPACE}.attachments.`, {
        param: `messages.${index}.content`,
      });
    }
    if (!ignored.includes(path)) ignored.push(path);
  }
  return texts.join("\n");
};

/** Reads a request body, already parsed as JSON, into a turn; a refusal names the field at fault. */
export const readTurnRequest = (body: unknown): TurnRequest => {
  const parsed = ChatCompletionRequest.safeParse(body);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const param = issue === undefined ? null : paramOf(issue.path);
    throw invalid(`The request does not match the chat completion schema${param === null ? "" : ` at ${param}`}: ${issue?.message ?? "invalid"}.`, param);
  }
  const request = parsed.data;
  const extension = merged(request);
  const tolerate = extension.ignoreUnsupported === true;
  const ignored: string[] = [];

  for (const name of REJECTED_PARAMETERS) {
    if (!isSet(request[name])) continue;
    if (!tolerate) {
      throw new CompletionsRefusal(400, "unsupported_parameter", `${name} is not honoured here; leave it out, or set ${COMPLETIONS_NAMESPACE}.ignoreUnsupported to have it ignored.`, { param: name });
    }
    ignored.push(name);
  }
  for (const name of [...IGNORED_PARAMETERS, ...PASSTHROUGH_PARAMETERS]) if (isSet(request[name])) ignored.push(name);
  if (extension.alwaysOnSkills !== undefined && extension.alwaysOnSkills !== null) ignored.push(`${COMPLETIONS_NAMESPACE}.alwaysOnSkills`);
  // A field neither namespace knows (a browser field, a later version's) is dropped, and said so.
  const known = new Set(Object.keys(ExtensionSchema.shape));
  for (const namespace of [COMPLETIONS_NAMESPACE, COMPLETIONS_NAMESPACE_ALIAS]) {
    const raw = (body as Record<string, unknown>)[namespace];
    if (typeof raw !== "object" || raw === null) continue;
    for (const key of Object.keys(raw)) if (!known.has(key)) ignored.push(`${namespace}.${key}`);
  }

  const { messages } = request;
  const trailingIndex = messages.length - 1;
  const trailing = messages[trailingIndex];
  if (trailing === undefined || trailing.role !== "user") {
    throw invalid("The trailing message is the turn, and must be the user's.", "messages");
  }
  const text = textOf(trailing, trailingIndex, tolerate, ignored);
  if (text.trim() === "") throw invalid("The trailing user message has no text.", "messages");

  const instructions: string[] = [];
  const instructionSources: string[] = [];
  if (isSet(extension.systemPrompt) && (extension.systemPrompt as string).trim() !== "") {
    instructions.push(extension.systemPrompt as string);
    instructionSources.push(`${COMPLETIONS_NAMESPACE}.systemPrompt`);
  }
  const earlier: ChatMessage[] = [];
  messages.slice(0, trailingIndex).forEach((message, index) => {
    if (message.role === "system" || message.role === "developer") {
      const instruction = textOf(message, index, tolerate, ignored);
      if (instruction.trim() !== "") {
        instructions.push(instruction);
        instructionSources.push(`messages.${index}`);
      }
    } else {
      earlier.push({ ...message, content: textOf(message, index, tolerate, ignored) });
    }
  });
  const appendedInstructions = instructions.join("\n\n");
  if (appendedInstructions.length > MAX_SYSTEM_PROMPT_CHARS) {
    // The field at fault: the one source when there is one (systemPrompt alone never gets here, its schema bounds it), else the messages.
    const [only, ...more] = instructionSources;
    throw invalid(
      `The request's own instructions come to ${appendedInstructions.length} characters; at most ${MAX_SYSTEM_PROMPT_CHARS} are appended.`,
      only !== undefined && more.length === 0 ? only : "messages",
    );
  }

  const maxTokens = request.max_tokens ?? request.max_completion_tokens ?? null;
  const stop = request.stop === undefined || request.stop === null ? [] : typeof request.stop === "string" ? [request.stop] : request.stop;
  return {
    model: request.model,
    stream: request.stream === true,
    includeUsage: request.stream_options?.include_usage === true,
    maxCharacters: maxTokens === null ? null : maxTokens * CHARACTERS_PER_TOKEN,
    stop,
    effort: extension.thinking ?? request.reasoning_effort ?? null,
    effortParam: isSet(extension.thinking) ? `${COMPLETIONS_NAMESPACE}.thinking` : isSet(request.reasoning_effort) ? "reasoning_effort" : null,
    extension: {
      sessionId: extension.sessionId?.toLowerCase() ?? null,
      permissionMode: extension.permissionMode ?? null,
      systemPrompt: extension.systemPrompt ?? null,
      alwaysOnSkills: extension.alwaysOnSkills ?? null,
      forkSession: extension.forkSession === true,
      rewindToMessageId: extension.rewindToMessageId?.toLowerCase() ?? null,
      attachments: extension.attachments ?? [],
      workspace: extension.workspace ?? null,
      attended: extension.attended === true,
      attendedSet: isSet(extension.attended),
      after: extension.after ?? null,
    },
    ignored,
    appendedInstructions,
    instructionSources,
    text,
    earlier,
  };
};

/** How a message of the conversation reads in the preamble. */
const speaker = (message: ChatMessage): string => {
  switch (message.role) {
    case "user":
      return "User";
    case "assistant":
      return "Assistant";
    default:
      return typeof message.tool_call_id === "string" ? `Tool result (${message.tool_call_id})` : "Tool result";
  }
};

/** What an assistant message's tool calls say in the preamble: each function and its arguments, as the caller sent them. */
const toolCallsOf = (message: ChatMessage): string[] =>
  (message.tool_calls ?? []).map((call) => {
    const fn = (call as { function?: { name?: unknown; arguments?: unknown } }).function;
    const name = typeof fn?.name === "string" ? fn.name : "a tool";
    const args = typeof fn?.arguments === "string" ? fn.arguments : JSON.stringify(fn?.arguments ?? {});
    return `(called ${name} with ${args})`;
  });

/**
 * The prompt of a fresh session's first turn: the earlier messages as an
 * "earlier in this conversation" preamble, then the turn (Artemis's rule).
 * With nothing earlier it is the turn alone.
 */
export const withPreamble = (earlier: readonly ChatMessage[], text: string): string => {
  const lines = earlier.flatMap((message) => {
    const said = [typeof message.content === "string" ? message.content : "", ...(message.role === "assistant" ? toolCallsOf(message) : [])]
      .filter((part) => part.trim() !== "")
      .join(" ");
    return said === "" ? [] : [`${speaker(message)}: ${said}`];
  });
  if (lines.length === 0) return text;
  return `Earlier in this conversation:\n\n${lines.join("\n\n")}\n\n---\n\n${text}`;
};
