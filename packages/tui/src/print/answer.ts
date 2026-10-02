import { COMPLETIONS_NAMESPACE, ChatCompletionChunk, CompletionsErrorBody, type CompletionUsage, type RunEndReason } from "@agent-harness/contracts";
import { PrintFailure } from "./failure.js";
import type { FormatWriter, Narrator } from "./output.js";
import { eventData } from "./sse.js";

/**
 * A completions answer read as it streams (claude-adapter spec, "The
 * completions surface": streaming): what the result needs of it, each chunk
 * handed on as it comes, and the first chunk's word on where the turn went.
 */

/** What the print has learned, for its result. */
export interface Learned {
  environmentId: string | null;
  sessionId: string | null;
  runId: string | null;
  text: string;
  usage: CompletionUsage | null;
  reason: RunEndReason;
  error: string | null;
  /** The answer's final chunk came: `reason` is its run's end. */
  finished: boolean;
  /** The answer ended with its run completed, and nothing it sent still waits. */
  completed: boolean;
}

/** The turn as the answer's first chunk tells it: its session, the run the answer follows first, its message, and how that was delivered. */
export interface Head {
  readonly sessionId: string;
  readonly runId: string;
  readonly messageId: string;
  /** `prompt`: the message started the run; `queued`: it waits for a run to read it, the run named being the live one it was queued to. */
  readonly delivery: "prompt" | "queued";
}

/** The answer was let go of on purpose (SIGINT, or standard output closed): no failure of its own. */
export class AnswerAbandoned extends Error {}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The surface's refusal of a request, in its words, with the session and run it names; else the status. */
export const refusalOf = async (response: Response, learned: Learned, environment: string): Promise<PrintFailure> => {
  const parsed = CompletionsErrorBody.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return new PrintFailure(`${environment} answered ${response.status}.`);
  const fields = parsed.data[COMPLETIONS_NAMESPACE];
  if (fields?.sessionId !== undefined) learned.sessionId = fields.sessionId;
  if (fields?.runId !== undefined) learned.runId = fields.runId;
  if (fields?.ended !== undefined) learned.reason = fields.ended.reason;
  return new PrintFailure(parsed.data.error.message);
};

/** One event's data, parsed as JSON and read as a chunk. */
const chunkOf = (data: string): { readonly raw: unknown; readonly chunk: ChatCompletionChunk } => {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    throw new PrintFailure("The answer sent something that is not JSON.");
  }
  const parsed = ChatCompletionChunk.safeParse(raw);
  if (!parsed.success) throw new PrintFailure("The answer sent something that is not a completion chunk.");
  return { raw, chunk: parsed.data };
};

export interface AnswerReader {
  readonly environment: string;
  readonly learned: Learned;
  readonly writer: FormatWriter;
  readonly narrate: Narrator;
  /** Called once, with the first chunk that names the turn's message. */
  readonly head: (head: Head) => void;
  /** Aborted when the answer is let go of. */
  readonly signal: AbortSignal;
}

/** Reads the streamed answer to its end into `learned`; throws a `PrintFailure` when it is not a whole answer, `AnswerAbandoned` when let go of. */
export const readAnswer = async (body: ReadableStream<Uint8Array>, reader: AnswerReader): Promise<void> => {
  const { learned, writer, narrate } = reader;
  /** The final chunk's error: said once the usage after it is read too. */
  let failed: string | undefined;
  const events = eventData(body);
  for (;;) {
    let next: IteratorResult<string>;
    try {
      next = await events.next();
    } catch (error) {
      if (reader.signal.aborted) throw new AnswerAbandoned();
      throw new PrintFailure(`The answer from ${reader.environment} broke off: ${messageOf(error)}.`);
    }
    if (next.done === true) break;
    let raw: unknown;
    let chunk: ChatCompletionChunk;
    try {
      ({ raw, chunk } = chunkOf(next.value));
    } catch (error) {
      await events.return();
      throw error;
    }
    const fields = chunk[COMPLETIONS_NAMESPACE];
    if (fields.sessionId !== undefined) learned.sessionId = fields.sessionId;
    if (fields.runId !== undefined) learned.runId = fields.runId;
    if (fields.sessionId !== undefined && fields.runId !== undefined && fields.messageId !== undefined && fields.delivery !== undefined) {
      reader.head({ sessionId: fields.sessionId, runId: fields.runId, messageId: fields.messageId, delivery: fields.delivery });
    }
    const choice = chunk.choices[0];
    const content = choice?.delta.content;
    if (content !== undefined) learned.text += content;
    if (chunk.usage !== undefined) learned.usage = chunk.usage;
    writer.chunk(raw, content);
    if (fields.clamped != null) narrate.clamped(fields.clamped);
    if (fields.ignored !== undefined) narrate.ignored(fields.ignored);
    if (fields.activity !== undefined) narrate.activity(fields.activity);
    if (choice?.finish_reason == null) continue;
    learned.finished = true;
    if (fields.ended !== undefined) learned.reason = fields.ended.reason;
    learned.completed = choice.finish_reason === "stop" && fields.ended?.reason === "completed" && fields.waiting === undefined;
    failed = chunk.error?.message ?? (fields.waiting === undefined ? undefined : "The message still waits in the session's queue: no run has read it.");
  }
  if (!learned.finished) throw new PrintFailure("The answer ended before its run did.");
  if (failed !== undefined) throw new PrintFailure(failed);
};
