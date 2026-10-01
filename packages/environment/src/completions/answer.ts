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
  type MessageRequeuedPayload,
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
import type { ParkedCall } from "./passthrough.js";

/**
 * The answer a turn gets (claude-adapter spec, "The completions surface":
 * streaming, non-streaming): the session's events, in log order, rendered
 * into OpenAI's chunks. One renderer serves both shapes: a stream sends each
 * chunk as it comes, a whole answer is folded from them.
 *
 * - The first chunk (the assistant's role) renders the first event of the
 *   followed run the answer meets: `run.started` for a new run, the queued message's
 *   `message.sent` (or the first event after `after`) for an attached one;
 *   it carries the session, the run, the message, the mode, the clamp and
 *   what was ignored.
 * - Text renders from `assistant.delta` fragments, and from a settled
 *   `assistant.text` whatever its deltas did not carry; two text items are
 *   parted by a blank line. Thinking is not rendered.
 * - The agent's own tool calls and prompts ride `agent-harness.activity` on
 *   chunks with an empty delta; they never appear as `tool_calls`.
 * - A call to one of the caller's own tools (#139, `passthrough.ts`) is a
 *   `tool_calls` delta, whole in one chunk, under the id the environment
 *   minted and the name the request declared; its transcript events are not
 *   activity. The answer ends with `finish_reason: tool_calls` a turn of the
 *   event loop after the first, with every call parked by then: the run
 *   waits on them, and a follow-up's tool messages resume it.
 * - `run.ended` of the followed run renders the final chunk: `stop` for a
 *   run that completed, else `error` with the error beside it; then, when
 *   asked, the usage chunk, from the run's last `usage.reported`.
 * - A stop sequence or `max_tokens` ends the answer where it falls (`stop`,
 *   `length`); the run goes on to its end on the session, as after a
 *   disconnect. So does the withdrawal of a queued turn's message
 *   (`error`, code `withdrawn`), which no run will read.
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
  push(text: string, lead = ""): { readonly out: string; readonly cut: "stop" | "length" | null } {
    // A lead (the blank line between two items) is not the model's text: what was held back goes out before it,
    // and no stop sequence is matched against either, since the item that held it back has ended.
    const fixed = lead === "" ? "" : this.#pending + lead;
    let candidate = lead === "" ? this.#pending + text : text;
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
    let out = fixed + candidate;
    if (this.#max !== null && this.#emitted + out.length + (cut === null ? this.#pending.length : 0) > this.#max) {
      // The budget falls before any stop sequence in the text: the answer ends for its length.
      out = (out + (cut === null ? this.#pending : "")).slice(0, Math.max(0, this.#max - this.#emitted));
      this.#pending = "";
      cut = "length";
    }
    this.#emitted += out.length;
    return { out, cut };
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
export type AnswerHead = Omit<CompletionsAnswerExtension, "seq" | "activity" | "ended" | "waiting">;

/** How an answer ended. */
export interface AnswerEnd {
  readonly finishReason: CompletionFinishReason;
  readonly seq: number;
  /** The followed run's end, when the answer ended with it. */
  readonly ended: RunEndedPayload | null;
  /** Set when the run did not complete, or the environment stopped the answer. */
  readonly error: CompletionsErrorDetail | null;
  /** The run's usage, when the answer ended with the run; null for one a stop sequence or the budget cut, before the run's spend is known. */
  readonly usage: CompletionUsage | null;
  /** The turn's message, still waiting in the session's queue: a queued one no run read, or a prompt its run never had (#833). */
  readonly waiting: string | null;
}

export interface RendererOptions {
  readonly id: string;
  readonly created: number;
  readonly model: string;
  readonly head: AnswerHead;
  readonly stops: readonly string[];
  readonly maxCharacters: number | null;
  /** The run the answer follows first: the new run, or the run live when the turn was queued to it. */
  readonly runId: string;
  /** The turn's message, queued to a live run: the answer follows whichever run reads it, and ends with that run. Null for a new run. */
  readonly queuedMessage: string | null;
  /** Each chunk, in order. */
  readonly emit: (chunk: ChatCompletionChunk) => void;
  /** Once, when the answer is over. */
  readonly end: (end: AnswerEnd) => void;
  /**
   * Asked when the followed run ended without reading the queued message:
   * whether it is still with the provider, which will open a turn with it
   * (`wait`), or waits in the environment's queue with nothing to read it
   * (`queued`); called on a later turn of the event loop, once what the end
   * set off has been recorded.
   */
  readonly holderOf: (messageId: string) => "wait" | "queued" | "read";
  readonly later: (work: () => void) => void;
  /** Whether a tool call of the followed runs (by the provider's id) is one of the caller's: its tool events are not activity. */
  readonly isClientCall: (toolCallId: string) => boolean;
  /**
   * Called, on a later turn of the event loop, once a queued turn's answer
   * follows the run that reads its message: from then on it may return that
   * run's calls to the caller's tools, those parked before included.
   */
  readonly onReading?: () => void;
  /** The sequence the answer starts from before it renders an event: the log's head when an answer to tool results began following. Preset: 0. */
  readonly startSeq?: number;
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
  let readBy: string | null = options.queuedMessage === null ? options.runId : null;
  let headSent = false;
  let over = false;
  let lastSeq = options.startSeq ?? 0;
  /** The calls to the caller's tools this answer returned, in order; the answer ends on a later turn of the event loop after the first. */
  const returned: ParkedCall[] = [];
  let usage: readonly ModelUsage[] | null = null;
  let lastEnded: { payload: RunEndedPayload; seq: number } | null = null;
  /** A new run's prompt, once that run took it back unread (its adapter never had it, #833): the run's end names it waiting. */
  let takenBack: string | null = null;
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
      ...(end.waiting !== null && { waiting: end.waiting }),
    };
    chunk(end.seq, [{ index: 0, delta: {}, finish_reason: end.finishReason }], extension, end.error === null ? {} : { error: end.error });
    options.end({ ...end, seq: lastSeq, usage: end.ended === null ? null : usageOf(usage ?? end.ended.usage ?? null) });
  };

  /** Sends text for an item: a blank line first when another item's text went before it. */
  const text = (itemId: string, value: string, seq: number): void => {
    if (value === "") return;
    const before = sent.get(itemId);
    const lead = before === undefined && lastItem !== null && lastItem !== itemId ? "\n\n" : "";
    sent.set(itemId, (before ?? "") + value);
    lastItem = itemId;
    const { out, cut } = gate.push(value, lead);
    if (out !== "") chunk(seq, [{ index: 0, delta: { content: out }, finish_reason: null }]);
    if (cut !== null) finish({ finishReason: cut, seq, ended: null, error: null, waiting: null });
  };

  const activity = (seq: number, value: CompletionsActivity): void => chunk(seq, [{ index: 0, delta: {}, finish_reason: null }], { activity: value });

  /** The followed run has ended: the answer ends with it, unless it never read the queued message, when the run that does is waited for. */
  const runEnded = (payload: RunEndedPayload, seq: number): void => {
    lastEnded = { payload, seq };
    if (readBy === followed) return endWith(payload, seq, takenBack);
    const endedRun = followed;
    const queued = options.queuedMessage;
    options.later(() => {
      if (over || followed !== endedRun || queued === null) return;
      // A later turn of the event loop has no caller to catch for it: a failure ends the answer, never the process.
      try {
        const holder = options.holderOf(queued);
        if (holder === "wait") return;
        // A read-now's interrupt ended it (#228): its run of the queue starts once the interrupt has answered too, which
        // may be a later turn of the event loop, and reads the message, so the answer waits for that run.
        if (holder === "queued" && payload.reason === "interrupted" && payload.cause === "read-now") return;
        endWith(payload, seq, holder === "queued" ? queued : null);
      } catch (error) {
        console.error(`Finding where the queued message ${queued} waits failed:`, error);
        abandon("The environment failed to follow the run.", "internal");
      }
    });
  };

  /** The run the answer follows now reads its queued message: the answer may return the run's calls to the caller's tools. */
  const reading = (): void => {
    if (options.onReading !== undefined) options.later(options.onReading);
  };

  /**
   * Returns a call to the caller's tools, parked by the run the answer
   * follows: a `tool_calls` delta, whole, after whatever text was held back;
   * the answer ends a turn of the event loop after its first call, with
   * every call parked by then. False when the answer cannot return it: it is
   * over, or it follows a run that has not read its queued message.
   */
  const claim = (call: ParkedCall): boolean => {
    if (over || readBy !== followed) return false;
    head(lastSeq);
    if (returned.length === 0) {
      // Text held back for a stop sequence goes out before the calls: nothing follows them in this answer.
      const tail = gate.flush();
      if (tail !== "") chunk(lastSeq, [{ index: 0, delta: { content: tail }, finish_reason: null }]);
      options.later(() => {
        // A later turn of the event loop has no caller to catch for it: a failure is logged, never thrown.
        try {
          finish({ finishReason: "tool_calls", seq: lastSeq, ended: null, error: null, waiting: null });
        } catch (error) {
          console.error("Ending an answer on its calls to the caller's tools failed:", error);
        }
      });
    }
    const index = returned.length;
    returned.push(call);
    chunk(lastSeq, [{ index: 0, delta: { tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }] }, finish_reason: null }]);
    return true;
  };

  const abandon = (message: string, code: string): void => {
    if (over) return;
    head(lastSeq);
    finish({ finishReason: "error", seq: lastSeq, ended: null, error: { message, type: "server_error", code, param: null }, waiting: null });
  };

  const endWith = (payload: RunEndedPayload, seq: number, waiting: string | null = null): void => {
    const completed = payload.reason === "completed";
    finish({
      finishReason: completed ? "stop" : "error",
      seq,
      ended: payload,
      error: completed ? null : { message: endSentence(payload), type: "server_error", code: payload.reason, param: null },
      waiting,
    });
  };

  return {
    /** One event of the session, in log order. */
    event(event: EventEnvelope): void {
      if (over) return;
      const queued = options.queuedMessage;
      // Which run reads the queued message: the live one it is folded into, or a later one that opens with it.
      if (queued !== null) {
        if (event.type === "message.delivered" && event.payload["messageId"] === queued) {
          readBy = String(event.payload["runId"]);
          if (readBy === followed) reading();
        }
        if (event.type === "run.started") {
          const started = event.payload as RunStartedPayload;
          if (started.promptMessageId === queued || started.queuedMessageIds.includes(queued)) {
            followed = started.runId;
            readBy = started.runId;
            // The answer now ends with this run: its usage and its end are its own, never the run followed before.
            usage = null;
            lastEnded = null;
            reading();
          }
        }
        if (event.type === "message.requeued" && event.payload["messageId"] === queued && lastEnded !== null) runEnded(lastEnded.payload, lastEnded.seq);
        // Taken back before any run read it (`runs.withdraw`, #228): nothing will read it, so the answer ends here; the runs go on.
        if (event.type === "message.withdrawn" && event.payload["messageId"] === queued) {
          head(event.sequence);
          const error = { message: "The message was withdrawn before any run read it; its text is the session's draft.", type: "conflict_error", code: "withdrawn", param: null };
          return finish({ finishReason: "error", seq: event.sequence, ended: null, error, waiting: null });
        }
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
          // A call to the caller's own tools goes back to the caller as tool_calls, not as the agent's activity.
          if (options.isClientCall(toolCallId)) return;
          return activity(seq, { type: "tool.started", toolCallId, name, title });
        }
        case "tool.ended": {
          const { toolCallId, status } = event.payload as ToolEndedPayload;
          if (options.isClientCall(toolCallId)) return;
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
        case "message.requeued": {
          // The run a prompt turn started ends before its adapter had the prompt (interrupted while it composed its
          // instructions): the host takes the prompt back into the environment's queue just before the end, and the
          // next run reads it, so the answer ends naming it waiting, never following the run that reads it (#833).
          const { messageId } = event.payload as MessageRequeuedPayload;
          if (queued === null && messageId === options.head.messageId) takenBack = messageId;
          return;
        }
        case "run.ended":
          return runEnded(event.payload as RunEndedPayload, seq);
        default:
          return;
      }
    },
    claim,
    /** The environment is stopping, or the answer cannot go on: it ends with an error chunk, never a bare close. */
    abandon,
    isOver: (): boolean => over,
  };
};

export type Renderer = ReturnType<typeof createRenderer>;
