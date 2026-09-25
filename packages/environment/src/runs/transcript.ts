import {
  SESSION_STREAM_KIND,
  eventTypeEntry,
  type AssistantTextPayload,
  type CommandRanPayload,
  type MessageDeliveredPayload,
  type MessageRequeuedPayload,
  type MessageSentPayload,
  type MessageWithdrawnPayload,
  type ParkedPrompt,
  type PromptAnsweredPayload,
  type PromptOpenedPayload,
  type RunEndedPayload,
  type RunStartedPayload,
  type RunSummary,
  type SessionRewoundPayload,
  type TasksChangedPayload,
  type ToolEndedPayload,
  type ToolStartedPayload,
  type ToolUpdatedPayload,
  type TranscriptItem,
  type UsageReportedPayload,
} from "@agent-harness/contracts";
import { decodeEvent, type EventRow } from "../event-log/database.js";
import type { EventEnvelope, EventLog } from "../event-log/event-log.js";
import { sessionStream } from "../sessions/streams.js";

/**
 * The transcript part of a session's snapshot (claude-adapter spec, the
 * snapshot `{summary, runs, items, parkedPrompts}`), folded from the
 * session's stream: a pure function of its events. The simplest thing that
 * gives `sessions.subscribeSession` its snapshot: the snapshot is only read
 * when replay from a client's cursor is out of bounds, and a projection of
 * items would be one more read model to rebuild. Deltas are left out, as the
 * spec says (and left out of the read, `readTranscriptEvents`): the snapshot
 * holds settled items, and a client applies deltas to the open item. The
 * fold is not bounded for a live session: compaction (#123) folds only
 * sessions long left untouched (ADR 0002), and a compacted session's fold
 * goes on from its compaction's snapshot (`sessionTranscript`).
 */

export interface TranscriptParts {
  readonly runs: RunSummary[];
  readonly items: TranscriptItem[];
  readonly parkedPrompts: ParkedPrompt[];
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
/** An item of a known kind, as the fold builds and then updates it. */
type ItemOf<K extends string> = Mutable<Extract<TranscriptItem, { kind: K }>>;
/** Any item as the fold holds it: of a known kind, or opaque. */
type Item = { kind: string; sequence: number };

/** Whether `type` is one the session stream's table knows: organisation, prompt or transcript. */
const knownType = (type: string): boolean => eventTypeEntry(SESSION_STREAM_KIND, type) !== undefined;

/**
 * The session's events the fold reads after `afterSequence`, oldest first:
 * every event of its stream but `assistant.delta`, left out in the query,
 * since the settled `assistant.text` and `assistant.thinking` carry the
 * whole text. Still the whole stream otherwise, or what follows its
 * compaction: compaction (#123) folds only sessions long left untouched
 * (ADR 0002), so for a live session the read grows with it.
 */
export const readTranscriptEvents = (log: Pick<EventLog, "read">, sessionId: string, afterSequence = 0): EventEnvelope[] =>
  log
    .read<EventRow>(
      `SELECT * FROM events WHERE stream_kind = '${SESSION_STREAM_KIND}' AND stream_id = ? AND sequence > ? AND type <> 'assistant.delta' ORDER BY sequence`,
      sessionId,
      afterSequence,
    )
    .map(decodeEvent);

/**
 * The session's transcript as of the log's head: its compaction's fold, if
 * it has been compacted (`sessions/compaction.ts`), folded on with the
 * events after it; else the fold of its whole stream.
 */
export const sessionTranscript = (log: Pick<EventLog, "read" | "readSnapshot">, sessionId: string): TranscriptParts => {
  const snapshot = log.readSnapshot(sessionStream(sessionId));
  const events = readTranscriptEvents(log, sessionId, snapshot?.sequence ?? 0);
  return snapshot === null ? foldTranscript(events) : foldTranscript(events, snapshot.payload as TranscriptParts);
};

/**
 * Folds one session's events, oldest first, into its runs, its settled
 * items and its parked prompts; from `from`, a fold of the events before
 * them (a compaction's snapshot), when given, which it leaves unchanged.
 * Folding on from a fold gives what folding every event would, but for an
 * event aimed at an item a rewind hid before the fold: that item is not in
 * the fold to update, and stays hidden either way.
 */
export const foldTranscript = (events: Iterable<EventEnvelope>, from?: TranscriptParts): TranscriptParts => {
  const start = from === undefined ? undefined : (structuredClone(from) as { runs: Mutable<RunSummary>[]; items: Item[]; parkedPrompts: ParkedPrompt[] });
  const runs = new Map<string, Mutable<RunSummary>>(start?.runs.map((run) => [run.runId, run]));
  let items: Item[] = start?.items ?? [];
  const parked = new Map<string, ParkedPrompt>(start?.parkedPrompts.map((prompt) => [prompt.promptId, prompt]));
  /** Items to update later, by the id their events carry. */
  const messages = new Map<string, ItemOf<"user-message">>();
  const toolCalls = new Map<string, ItemOf<"tool-call">>();
  const ledgers = new Map<string, ItemOf<"tasks">>();
  /** Prompt items not yet answered, by prompt id. */
  const prompts = new Map<string, ItemOf<"prompt">>();
  // The items of the fold it goes on from that later events update, by the ids those carry.
  for (const item of items) {
    if (item.kind === "user-message") {
      const message = item as unknown as ItemOf<"user-message">;
      messages.set(message.messageId, message);
    } else if (item.kind === "tool-call") {
      const call = item as unknown as ItemOf<"tool-call">;
      toolCalls.set(call.toolCallId, call);
    } else if (item.kind === "tasks") {
      const ledger = item as unknown as ItemOf<"tasks">;
      ledgers.set(ledger.runId, ledger);
    } else if (item.kind === "prompt") {
      const prompt = item as unknown as ItemOf<"prompt">;
      if (prompt.answer === null) prompts.set(prompt.promptId, prompt);
    }
  }

  const push = <I extends Item>(item: I): I => {
    items.push(item);
    return item;
  };

  for (const event of events) {
    const { sequence } = event;
    switch (event.type) {
      case "run.started": {
        const payload = event.payload as RunStartedPayload;
        runs.set(payload.runId, {
          runId: payload.runId,
          state: "running",
          origin: payload.origin,
          accountId: payload.accountId,
          model: payload.model,
          effort: payload.effort,
          mode: payload.mode,
          promptMessageId: payload.promptMessageId,
          queuedMessageIds: payload.queuedMessageIds,
          startedAt: event.occurredAt,
          endedAt: null,
          reason: null,
          cause: null,
          error: null,
          usage: null,
          durationMs: null,
        });
        break;
      }
      case "run.ended": {
        const payload = event.payload as RunEndedPayload;
        const run = runs.get(payload.runId);
        if (run === undefined) break;
        Object.assign(run, {
          state: "ended",
          endedAt: event.occurredAt,
          reason: payload.reason,
          cause: payload.cause,
          error: payload.error,
          usage: payload.usage ?? run.usage,
          durationMs: payload.durationMs,
        });
        break;
      }
      case "usage.reported": {
        const payload = event.payload as UsageReportedPayload;
        const run = runs.get(payload.runId);
        if (run !== undefined) run.usage = payload.models;
        break;
      }
      case "message.sent": {
        const payload = event.payload as MessageSentPayload;
        const item = push<ItemOf<"user-message">>({
          kind: "user-message",
          sequence,
          runId: payload.runId,
          messageId: payload.messageId,
          text: payload.text,
          attachments: payload.attachments,
          delivery: payload.delivery,
          heldBy: payload.heldBy,
          sentAt: event.occurredAt,
        });
        messages.set(payload.messageId, item);
        break;
      }
      case "message.delivered": {
        const payload = event.payload as MessageDeliveredPayload;
        const item = messages.get(payload.messageId);
        if (item !== undefined) Object.assign(item, { delivery: payload.delivery, heldBy: null, runId: payload.runId });
        break;
      }
      case "message.requeued": {
        // Queued again, in the environment's queue: after an interrupt, or a run that never reached its adapter.
        const item = messages.get((event.payload as MessageRequeuedPayload).messageId);
        if (item !== undefined) Object.assign(item, { delivery: "queued", heldBy: "environment" });
        break;
      }
      case "message.withdrawn": {
        // Taken back before any run read it (#228): its text is the draft now, so the queued row goes; the log keeps it.
        const { messageId } = event.payload as MessageWithdrawnPayload;
        const item = messages.get(messageId);
        if (item !== undefined) items = items.filter((held) => held !== item);
        messages.delete(messageId);
        break;
      }
      case "assistant.text":
      case "assistant.thinking": {
        const payload = event.payload as AssistantTextPayload;
        push({
          kind: event.type === "assistant.text" ? "assistant-text" : "assistant-thinking",
          sequence,
          runId: payload.runId,
          itemId: payload.itemId,
          text: payload.text,
          aborted: payload.aborted,
        });
        break;
      }
      case "tool.started": {
        const payload = event.payload as ToolStartedPayload;
        const item = push<ItemOf<"tool-call">>({
          kind: "tool-call",
          sequence,
          runId: payload.runId,
          toolCallId: payload.toolCallId,
          name: payload.name,
          input: payload.input,
          title: payload.title,
          agentId: payload.agentId,
          parentToolCallId: payload.parentToolCallId,
          status: "running",
          update: null,
          output: null,
          durationMs: null,
        });
        toolCalls.set(payload.toolCallId, item);
        break;
      }
      case "tool.updated": {
        const payload = event.payload as ToolUpdatedPayload;
        const item = toolCalls.get(payload.toolCallId);
        if (item !== undefined) item.update = payload.update;
        break;
      }
      case "tool.ended": {
        const payload = event.payload as ToolEndedPayload;
        const item = toolCalls.get(payload.toolCallId);
        if (item !== undefined) Object.assign(item, { status: payload.status, output: payload.output, durationMs: payload.durationMs });
        break;
      }
      case "command.ran": {
        const payload = event.payload as CommandRanPayload;
        push({ kind: "command", sequence, runId: payload.runId, name: payload.name, args: payload.args, output: payload.output });
        break;
      }
      case "tasks.changed": {
        const payload = event.payload as TasksChangedPayload;
        const held = ledgers.get(payload.runId);
        if (held !== undefined) held.tasks = payload.tasks;
        else ledgers.set(payload.runId, push<ItemOf<"tasks">>({ kind: "tasks", sequence, runId: payload.runId, tasks: payload.tasks }));
        break;
      }
      case "session.rewound": {
        // The rewound message and every item after it are hidden; they stay in the log.
        const { toMessageId } = event.payload as SessionRewoundPayload;
        const target = messages.get(toMessageId);
        if (target !== undefined) items = items.filter((item) => item.sequence < target.sequence);
        break;
      }
      case "prompt.opened": {
        // Parked until answered, and an item where it was asked, which its answer completes.
        const prompt = event.payload as PromptOpenedPayload;
        parked.set(prompt.promptId, { promptId: prompt.promptId, sequence, openedAt: event.occurredAt, prompt });
        prompts.set(prompt.promptId, push<ItemOf<"prompt">>({ kind: "prompt", sequence, runId: prompt.runId, promptId: prompt.promptId, prompt, answer: null }));
        break;
      }
      case "prompt.answered": {
        const answer = event.payload as PromptAnsweredPayload;
        parked.delete(answer.promptId);
        const item = prompts.get(answer.promptId);
        if (item !== undefined) item.answer = answer;
        prompts.delete(answer.promptId);
        break;
      }
      default:
        // An event of a type this environment does not know is kept, opaque (ADR 0001); a known one with no item is not an item.
        if (!knownType(event.type)) push({ kind: "opaque", sequence, type: event.type, payload: event.payload });
    }
  }
  return { runs: [...runs.values()], items: items as unknown as TranscriptItem[], parkedPrompts: [...parked.values()] };
};
