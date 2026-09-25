import {
  COMPLETIONS_NAMESPACE,
  type AssistantDeltaPayload,
  type AssistantTextPayload,
  type ChatCompletionChunk,
  type CompletionFinishReason,
  type CompletionUsage,
  type CompletionsActivity,
  type CompletionsAnswerExtension,
  type CompletionsErrorDetail,
  type ModelUsage,
  type PromptAnsweredPayload,
  type PromptOpenedPayload,
  type RunEndedPayload,
  type RunStartedPayload,
  type ToolEndedPayload,
  type ToolStartedPayload,
  type UsageReportedPayload,
} from "@agent-harness/contracts";
import type { EventEnvelope } from "../event-log/event-log.js";

/**
 * The answer a turn gets (claude-adapter spec, "The completions surface":
 * streaming, non-streaming): the session's events, in log order, rendered
 * into OpenAI's chunks. One renderer serves both shapes: a stream sends each
 * chunk as it comes, a whole answer is folded from them.
 *
 * - The first chunk (the assistant's role) renders the first event of the
 *   followed run the answer meets: `run.started` for a new run, the steer's
 *   `message.sent` (or the first event after `after`) for an attached one;
 *   it carries the session, the run, the message, the mode, the clamp and
 *   what was ignored.
 * - Text renders from `assistant.delta` fragments, and from a settled
 *   `assistant.text` whatever its deltas did not carry; two text items are
 *   parted by a blank line. Thinking is not rendered.
 * - Tool calls and prompts ride `agent-harness.activity` on chunks with an
 *   empty delta; they never appear as `tool_calls`.
 * - `run.ended` of the followed run renders the final chunk: `stop` for a
 *   run that completed, else `error` with the error beside it; then, when
 *   asked, the usage chunk, from the run's last `usage.reported`.
 * - A stop sequence or `max_tokens` ends the answer where it falls (`stop`,
 *   `length`); the run goes on to its end on the session, as after a
 *   disconnect.
 *
 * Every chunk carries `agent-harness.seq`, the sequence of the event it
 * renders, so the sequences of a stream never go back.
 */

/** Holds back what might be the start of a stop sequence, and cuts the text at a stop sequence or at the character budget. */
export class TextGate {
  #pending = "";
  #emitted = 0;
  readonly #stops: readonly string[];
  readonly #max: number | null;

  constructor(stops: readonly string[], maxCharacters: number | null) {
    this.#stops = stops.filter((stop) => stop !== "");
    this.#max = maxCharacters;
  }

  /** The text to send now, and whether the answer ends here, cut by a stop sequence or by the budget. */
  push(text: string): { readonly out: string; readonly cut: "stop" | "length" | null } {
    let candidate = this.#pending + text;
    this.#pending = "";
    let cut: "stop" | "length" | null = null;
    const at = this.#stops.map((stop) => candidate.indexOf(stop)).filter((index) => index >= 0);
    if (at.length > 0) {
      candidate = candidate.slice(0, Math.min(...at));
      cut = "stop";
    } else {
      // The longest end of the text that could begin a stop sequence waits for what follows it.
      const hold = Math.max(0, ...this.#stops.map((stop) => heldBack(candidate, stop)));
      this.#pending = candidate.slice(candidate.length - hold);
      candidate = candidate.slice(0, candidate.length - hold);
    }
    if (this.#max !== null && this.#emitted + candidate.length + (cut === null ? this.#pending.length : 0) > this.#max) {
      candidate = (candidate + (cut === null ? this.#pending : "")).slice(0, Math.max(0, this.#max - this.#emitted));
      this.#pending = "";
      cut = cut ?? "length";
    }
    this.#emitted += candidate.length;
    return { out: candidate, cut };
  }

  /** What was held back, sent at the end. */
  flush(): string {
    const room = this.#max === null ? this.#pending.length : Math.max(0, this.#max - this.#emitted);
    const out = this.#pending.slice(0, room);
    this.#pending = "";
    this.#emitted += out.length;
    return out;
  }
}

/** How much of the end of `text` is a proper beginning of `stop`. */
const heldBack = (text: string, stop: string): number => {
  for (let length = Math.min(text.length, stop.length - 1); length > 0; length -= 1) {
    if (stop.startsWith(text.slice(text.length - length))) return length;
  }
  return 0;
};

/** The usage OpenAI reports, from a run's per-model spend: input, cache reads and writes as prompt tokens. */
export const usageOf = (models: readonly ModelUsage[] | null): CompletionUsage => {
  const sum = (pick: (model: ModelUsage) => number) => (models ?? []).reduce((total, model) => total + pick(model), 0);
  const cached = sum((model) => model.cacheReadTokens);
  const prompt = sum((model) => model.inputTokens) + cached + sum((model) => model.cacheWriteTokens);
  const completion = sum((model) => model.outputTokens);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, prompt_tokens_details: { cached_tokens: cached } };
};

/** What the first chunk says of the turn, beside its sequence. */
export type AnswerHead = Omit<CompletionsAnswerExtension, "seq" | "activity" | "ended" | "queued">;

/** How an answer ended. */
export interface AnswerEnd {
  readonly finishReason: CompletionFinishReason;
  readonly seq: number;
  /** The followed run's end, when the answer ended with it. */
  readonly ended: RunEndedPayload | null;
  /** Set when the run did not complete, or the environment stopped the answer. */
  readonly error: CompletionsErrorDetail | null;
  readonly usage: CompletionUsage;
  /** The steered message still waits in the session's queue. */
  readonly queued: string | null;
}

export interface RendererOptions {
  readonly id: string;
  readonly created: number;
  readonly model: string;
  readonly head: AnswerHead;
  readonly stops: readonly string[];
  readonly maxCharacters: number | null;
  /** The run the answer follows first: the new run, or the run live when a steer was sent to it. */
  readonly runId: string;
  /** A steer's message: the answer follows whichever run reads it, and ends with that run. Null for a new run. */
  readonly steer: string | null;
  /** Each chunk, in order. */
  readonly emit: (chunk: ChatCompletionChunk) => void;
  /** Once, when the answer is over. */
  readonly end: (end: AnswerEnd) => void;
  /**
   * Asked when the followed run ended without reading the steer: whether the
   * steer is still with the provider, which will open a turn with it
   * (`wait`), or waits in the environment's queue with nothing to read it
   * (`queued`); called on a later turn of the event loop, once what the end
   * set off has been recorded.
   */
  readonly steerHolder: (messageId: string) => "wait" | "queued" | "read";
  readonly later: (work: () => void) => void;
}

/** The sentence of a run that did not complete. */
const endSentence = (ended: RunEndedPayload): string => {
  if (ended.error !== null) return ended.error.message;
  switch (ended.reason) {
    case "interrupted":
      return `The run was interrupted${ended.cause === null ? "" : ` (${ended.cause})`}.`;
    case "drained":
      return "The run was cut short by the environment's drain.";
    case "disposed":
      return "The run was stopped: its session was deleted or the environment closed.";
    default:
      return "The run failed.";
  }
};

/** Renders the session's events of a turn into chunks, and says when the answer is over. */
export const createRenderer = (options: RendererOptions) => {
  let followed = options.runId;
  let readBy: string | null = options.steer === null ? options.runId : null;
  let headSent = false;
  let over = false;
  let lastSeq = 0;
  let usage: readonly ModelUsage[] | null = null;
  let lastEnded: { payload: RunEndedPayload; seq: number } | null = null;
  const gate = new TextGate(options.stops, options.maxCharacters);
  /** The text sent for each item, and the item text was last sent for. */
  const sent = new Map<string, string>();
  let lastItem: string | null = null;

  const chunk = (
    seq: number,
    choices: ChatCompletionChunk["choices"],
    extension: Omit<CompletionsAnswerExtension, "seq"> = {},
    extra: Pick<ChatCompletionChunk, "usage" | "error"> = {},
  ): void => {
    lastSeq = Math.max(lastSeq, seq);
    options.emit({
      id: options.id,
      object: "chat.completion.chunk",
      created: options.created,
      model: options.model,
      choices,
      ...extra,
      [COMPLETIONS_NAMESPACE]: { seq: lastSeq, ...extension },
    });
  };

  const head = (seq: number): void => {
    if (headSent) return;
    headSent = true;
    chunk(seq, [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }], options.head);
  };

  const finish = (end: Omit<AnswerEnd, "usage">): void => {
    if (over) return;
    over = true;
    const tail = gate.flush();
    if (end.finishReason !== "length" && tail !== "") chunk(end.seq, [{ index: 0, delta: { content: tail }, finish_reason: null }]);
    const extension = {
      ...(end.ended !== null && { ended: { reason: end.ended.reason, cause: end.ended.cause } }),
      ...(end.queued !== null && { queued: end.queued }),
    };
    chunk(end.seq, [{ index: 0, delta: {}, finish_reason: end.finishReason }], extension, end.error === null ? {} : { error: end.error });
    options.end({ ...end, seq: lastSeq, usage: usageOf(usage ?? end.ended?.usage ?? null) });
  };

  /** Sends text for an item: a blank line first when another item's text went before it. */
  const text = (itemId: string, value: string, seq: number): void => {
    if (value === "") return;
    const before = sent.get(itemId);
    const lead = before === undefined && lastItem !== null && lastItem !== itemId ? "\n\n" : "";
    sent.set(itemId, (before ?? "") + value);
    lastItem = itemId;
    const { out, cut } = gate.push(lead + value);
    if (out !== "") chunk(seq, [{ index: 0, delta: { content: out }, finish_reason: null }]);
    if (cut !== null) finish({ finishReason: cut, seq, ended: null, error: null, queued: null });
  };

  const activity = (seq: number, value: CompletionsActivity): void => chunk(seq, [{ index: 0, delta: {}, finish_reason: null }], { activity: value });

  /** The followed run has ended: the answer ends with it, unless it never read the steer, when the run that does is waited for. */
  const runEnded = (payload: RunEndedPayload, seq: number): void => {
    lastEnded = { payload, seq };
    if (readBy === followed) return endWith(payload, seq);
    const endedRun = followed;
    options.later(() => {
      if (over || followed !== endedRun || options.steer === null) return;
      const holder = options.steerHolder(options.steer);
      if (holder === "wait") return;
      endWith(payload, seq, holder === "queued" ? options.steer : null);
    });
  };

  const endWith = (payload: RunEndedPayload, seq: number, queued: string | null = null): void => {
    const completed = payload.reason === "completed";
    finish({
      finishReason: completed ? "stop" : "error",
      seq,
      ended: payload,
      error: completed ? null : { message: endSentence(payload), type: "server_error", code: payload.reason, param: null },
      queued,
    });
  };

  return {
    /** One event of the session, in log order. */
    event(event: EventEnvelope): void {
      if (over) return;
      const steer = options.steer;
      // Which run reads the steer: the live one it is folded into, or a later one that opens with it.
      if (steer !== null) {
        if (event.type === "message.delivered" && event.payload["messageId"] === steer) readBy = String(event.payload["runId"]);
        if (event.type === "run.started") {
          const started = event.payload as RunStartedPayload;
          if (started.promptMessageId === steer || started.queuedMessageIds.includes(steer)) {
            followed = started.runId;
            readBy = started.runId;
          }
        }
        if (event.type === "message.requeued" && event.payload["messageId"] === steer && lastEnded !== null) runEnded(lastEnded.payload, lastEnded.seq);
      }
      if (event.correlationId !== followed) return;
      head(event.sequence);
      const seq = event.sequence;
      switch (event.type) {
        case "assistant.delta": {
          const { itemId, fragments } = event.payload as AssistantDeltaPayload;
          text(
            itemId,
            fragments
              .filter((fragment) => fragment.kind === "text")
              .map((fragment) => fragment.text)
              .join(""),
            seq,
          );
          return;
        }
        case "assistant.text": {
          const { itemId, text: settled } = event.payload as AssistantTextPayload;
          const before = sent.get(itemId) ?? "";
          if (settled.startsWith(before)) text(itemId, settled.slice(before.length), seq);
          return;
        }
        case "tool.started": {
          const { toolCallId, name, title } = event.payload as ToolStartedPayload;
          return activity(seq, { type: "tool.started", toolCallId, name, title });
        }
        case "tool.ended": {
          const { toolCallId, status } = event.payload as ToolEndedPayload;
          return activity(seq, { type: "tool.ended", toolCallId, status });
        }
        case "prompt.opened": {
          const { promptId, kind, summary } = event.payload as PromptOpenedPayload;
          return activity(seq, { type: "prompt.opened", promptId, kind, summary });
        }
        case "prompt.answered": {
          const { promptId, decision, decidedBy } = event.payload as PromptAnsweredPayload;
          return activity(seq, { type: "prompt.answered", promptId, decision, auto: typeof decidedBy === "string" ? null : decidedBy.auto });
        }
        case "usage.reported":
          usage = (event.payload as UsageReportedPayload).models;
          return;
        case "run.ended":
          return runEnded(event.payload as RunEndedPayload, seq);
        default:
          return;
      }
    },
    /** The environment is stopping: the answer ends with an error chunk, never a bare close. */
    abandon(message: string, code: string): void {
      if (over) return;
      head(lastSeq);
      finish({ finishReason: "error", seq: lastSeq, ended: null, error: { message, type: "server_error", code, param: null }, queued: null });
    },
    isOver: (): boolean => over,
  };
};

export type Renderer = ReturnType<typeof createRenderer>;
