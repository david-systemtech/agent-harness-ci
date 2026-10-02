import {
  SESSION_STREAM_KIND,
  eventTypeEntry,
  type AssistantDeltaPayload,
  type AssistantTextPayload,
  type CommandRanPayload,
  type ChecksFinishedPayload,
  type ChecksStartedPayload,
  type MessageDeliveredPayload,
  type MessageRequeuedPayload,
  type MessageSentPayload,
  type MessageWithdrawnPayload,
  type ParkedPrompt,
  type PromptAnsweredPayload,
  type PromptOpenedPayload,
  RunSuggestion,
  type RunEndedPayload,
  type RunStartedPayload,
  type RunSummary,
  type RunUpdateInterruptedPayload,
  type SessionHistoryImportedPayload,
  type SessionForkedPayload,
  type SessionRewindUndonePayload,
  type SessionRewoundPayload,
  type StandingRewind,
  type TasksChangedPayload,
  type ToolEndedPayload,
  type ToolStartedPayload,
  type ToolUpdatedPayload,
  type TranscriptItem,
  type UsageReportedPayload,
} from "@agent-harness/contracts";
import { parseActor } from "../event-log/envelope.js";
import { decodeEvent, type EventRow } from "../event-log/database.js";
import type { EventEnvelope, EventLog, Snapshot } from "../event-log/event-log.js";
import { sessionStream } from "../sessions/streams.js";

/**
 * The transcript part of a session's snapshot (claude-adapter spec, the
 * snapshot `{summary, runs, items, parkedPrompts, rewinds}`), folded from the
 * session's stream: a pure function of its events. The simplest thing that
 * gives `sessions.subscribeSession` its snapshot: the snapshot is only read
 * when replay from a client's cursor is out of bounds, and a projection of
 * items would be one more read model to rebuild. Deltas are left out, as the
 * spec says: the snapshot holds settled items, and a client applies deltas
 * to the open item. Only an item's first delta is read (the rest are left
 * out of the read, `readTranscriptEvents`), for where the item was opened:
 * the settled item sits at that sequence, as a client that heard the deltas
 * places it (#260). The
 * fold is not bounded for a live session: compaction (#123) folds only
 * sessions long left untouched (ADR 0002), and a compacted session's fold
 * goes on from its compaction's snapshot (`sessionTranscript`).
 */

export interface TranscriptParts {
  readonly suggestion?: RunSuggestion | null;
  readonly runs: RunSummary[];
  readonly items: TranscriptItem[];
  readonly parkedPrompts: ParkedPrompt[];
  /** The rewinds standing, with what each hid, a rewind a later one cut nested in it (#260). */
  readonly rewinds: StandingRewind[];
}

/**
 * The transcript parts a compaction stored: one stored before #260 carries
 * no rewinds, and is read as one with none standing (compaction never
 * folded a rewind that could still be undone, #218, and what an older one
 * hid was folded away with its events).
 */
export const storedTranscriptParts = (payload: unknown): TranscriptParts => {
  const parts = payload as Omit<TranscriptParts, "rewinds"> & { readonly rewinds?: StandingRewind[] };
  return { ...parts, rewinds: parts.rewinds ?? [] };
};

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
/** An item of a known kind, as the fold builds and then updates it. */
type ItemOf<K extends string> = Mutable<Extract<TranscriptItem, { kind: K }>>;
/** Any item as the fold holds it: of a known kind, opaque, or a rewind's fold. */
type Item = { kind: string; sequence: number };

/**
 * A rewind standing, as the fold holds it among the items, at its own
 * sequence where it cut the branch: what it hid, as held (a fold among
 * them nested), until an undo puts that back. The client runtime's reducer
 * holds a rewind the same way (`projections/session.ts`), so the snapshot's
 * rewinds are what a client that heard every event would draw. The two are
 * written twice, with the same names (`Fold`, `without`, `unfold`,
 * `listOf`, `everyItem`, `everyFold`), and the client runtime's
 * `session-rewinds.test.ts` checks they agree. No item the fold makes
 * otherwise has this kind: the environment folds an unknown event into kind
 * `opaque`.
 *
 * A fold is cut from the items settled when the rewind lands, and an
 * assistant item settles into the top-level items (`place`), so one opened
 * before a rewind and settled after it would sit ahead of the fold where a
 * client, holding it from its first delta, folds it. No log has that order:
 * a rewind is refused while a run is live (`sessions.rewind`'s `runActive`
 * check, `sessions/fork-rewind.ts`), an adapter settles its open items
 * before its end (`endTurn`, `adapters/claude/mapper.ts`), and the host
 * appends nothing of a run once it has ended it (`finish` sets `ended`
 * before `run.ended`, and `consume` drops what the stream yields after,
 * `adapter/host.ts`). A run's settles come before its `run.ended`, and so
 * before any rewind after its first delta.
 */
interface Fold extends Item {
  readonly kind: "rewound";
  readonly toMessageId: string;
  readonly text: string;
  undoable: boolean;
  hidden: Item[];
}

const isFold = (item: Item): item is Fold => item.kind === "rewound";
const bySequence = (a: Item, b: Item): number => a.sequence - b.sequence;

/** `list` without `item`, wherever it is held: at the top, or inside a fold. */
const without = (list: Item[], item: Item): Item[] => {
  if (list.includes(item)) return list.filter((held) => held !== item);
  for (const held of list) if (isFold(held)) held.hidden = without(held.hidden, item);
  return list;
};

/** `list` with `fold` taken away and what it hid put back in place, wherever the fold is held. */
const unfold = (list: Item[], fold: Fold): Item[] => {
  if (list.includes(fold)) return [...list.filter((held) => held !== fold), ...fold.hidden].sort(bySequence);
  for (const held of list) if (isFold(held)) held.hidden = unfold(held.hidden, fold);
  return list;
};

/** The items and the rewinds of a list as the snapshot carries them: the items apart, each fold a standing rewind. */
const partsOf = (list: readonly Item[]): { items: TranscriptItem[]; rewinds: StandingRewind[] } => ({
  items: list.filter((item) => !isFold(item)) as unknown as TranscriptItem[],
  rewinds: list.filter(isFold).map(({ sequence, toMessageId, text, undoable, hidden }) => ({ sequence, toMessageId, text, undoable, ...partsOf(hidden) })),
});

/** The list a snapshot's items and rewinds make, each rewind a fold at its sequence holding what it hid, the rewinds nested in it the same way. */
const listOf = (items: readonly Item[], rewinds: readonly StandingRewind[]): Item[] => [
  ...items,
  ...rewinds.map(({ sequence, toMessageId, text, undoable, items: hid, rewinds: nested }): Fold => ({ kind: "rewound", sequence, toMessageId, text, undoable, hidden: listOf(hid, nested) })),
].sort(bySequence);

/** Every item held, at the top or in a fold, the folds left out. */
const everyItem = (list: readonly Item[]): Item[] => list.flatMap((item) => (isFold(item) ? everyItem(item.hidden) : [item]));

/** Every fold held, at the top or nested, in no order. */
const everyFold = (list: readonly Item[]): Fold[] => list.flatMap((item) => (isFold(item) ? [...everyFold(item.hidden), item] : []));

/** Whether `type` is one the session stream's table knows: organisation, prompt or transcript. */
const knownType = (type: string): boolean => eventTypeEntry(SESSION_STREAM_KIND, type) !== undefined;

/**
 * The session's events the fold reads after `afterSequence`, oldest first:
 * every event of its stream but `assistant.delta`, since the settled
 * `assistant.text` and `assistant.thinking` carry the whole text, except
 * the first delta of each item and fragment kind, which says where the item
 * was opened (#260). The rest are left out in the query. Still the whole
 * stream otherwise, or what follows its compaction: compaction (#123) folds
 * only sessions long left untouched (ADR 0002), so for a live session the
 * read grows with it.
 */
export const readTranscriptEvents = (log: Pick<EventLog, "read">, sessionId: string, afterSequence = 0, includeOpenItems = false): EventEnvelope[] =>
  log
    .read<EventRow>(
      `SELECT * FROM events
       WHERE stream_kind = '${SESSION_STREAM_KIND}' AND stream_id = ? AND sequence > ?
         AND (type <> 'assistant.delta' OR ? OR sequence IN (
           SELECT MIN(d.sequence) FROM events d, json_each(d.payload, '$.fragments') f
           WHERE d.stream_kind = '${SESSION_STREAM_KIND}' AND d.stream_id = ? AND d.sequence > ? AND d.type = 'assistant.delta'
           GROUP BY json_extract(d.payload, '$.itemId'), json_extract(f.value, '$.kind')))
       ORDER BY sequence`,
      sessionId,
      afterSequence,
      includeOpenItems ? 1 : 0,
      sessionId,
      afterSequence,
    )
    .map(decodeEvent);

/**
 * The session's transcript as of the log's head: its compaction's fold, if
 * it has been compacted (`sessions/compaction.ts`), folded on with the
 * events after it; else the fold of its whole stream.
 */
export const sessionTranscript = (log: Pick<EventLog, "read" | "readSnapshot">, sessionId: string, includeOpenItems = false): TranscriptParts => {
  const snapshot = log.readSnapshot(sessionStream(sessionId));
  const events = readTranscriptEvents(log, sessionId, snapshot?.sequence ?? 0, includeOpenItems);
  return foldTranscript(events, snapshot === null ? undefined : readCompactedTranscript(log, snapshot), includeOpenItems);
};

/** A stored fold from before #632 omitted the fork's row; its retained session.forked restores it without rebuilding the removed transcript. */
export const readCompactedTranscript = (log: Pick<EventLog, "read">, snapshot: Snapshot): TranscriptParts => {
  const parts = storedTranscriptParts(snapshot.payload);
  if (parts.items.some((item) => item.kind === "forked")) return parts;
  const [row] = log.read<EventRow>(
    `SELECT * FROM events WHERE stream_kind = '${SESSION_STREAM_KIND}' AND stream_id = ? AND type = 'session.forked' AND sequence <= ? ORDER BY sequence LIMIT 1`,
    snapshot.stream.id,
    snapshot.sequence,
  );
  return row === undefined ? parts : { ...parts, items: [...foldTranscript([decodeEvent(row)]).items, ...parts.items].sort(bySequence) };
};

/**
 * Folds one session's events, oldest first, into its runs, its settled
 * items, its parked prompts and the rewinds standing; from `from`, a fold of
 * the events before them (a compaction's snapshot), when given, which it
 * leaves unchanged. A rewind to a message the items show (a message a
 * rewind hid hides nothing more) takes it and every item after it out of the
 * items into the rewind's fold, where a fold an earlier rewind made among
 * them is nested; the fold is undoable until a run starts on the session,
 * and stands until an undo (`session.rewind-undone`) naming it puts what it
 * hid back, in place (#218, #260). An assistant item sits at the sequence
 * of its first delta, where a client that heard the deltas opened it, or
 * of its settled event when it had none. Folding on from a fold gives what
 * folding every event would: the rewinds it carries hold what they hid. A
 * compaction's stored fold is read through `storedTranscriptParts` first.
 */
export const foldTranscript = (events: Iterable<EventEnvelope>, from?: TranscriptParts, includeOpenItems = false): TranscriptParts => {
  const start = from === undefined ? undefined : (structuredClone(from) as { runs: Mutable<RunSummary>[]; items: Item[]; parkedPrompts: ParkedPrompt[]; rewinds: StandingRewind[] });
  const runs = new Map<string, Mutable<RunSummary>>(start?.runs.map((run) => [run.runId, run]));
  let suggestion = from?.suggestion ?? null;
  let items: Item[] = start === undefined ? [] : listOf(start.items, start.rewinds);
  /** The rewinds standing, oldest first, each its fold. */
  let folds: Fold[] = everyFold(items).sort(bySequence);
  const parked = new Map<string, ParkedPrompt>(start?.parkedPrompts.map((prompt) => [prompt.promptId, prompt]));
  /** Items to update later, by the id their events carry. */
  const messages = new Map<string, ItemOf<"user-message">>();
  const toolCalls = new Map<string, ItemOf<"tool-call">>();
  const checks = new Map<string, ItemOf<"check">>();
  const ledgers = new Map<string, ItemOf<"tasks">>();
  /** Prompt items not yet answered, by prompt id. */
  const prompts = new Map<string, ItemOf<"prompt">>();
  /** Where each assistant item not yet settled was opened: its first delta's sequence, by `<fragment kind> <item id>`. */
  const opened = new Map<string, { sequence: number; runId: string; itemId: string; kind: "assistant-text" | "assistant-thinking"; text: string }>();
  // The items of the fold it goes on from that later events update, by the ids those carry, a rewind's hidden ones too.
  for (const item of everyItem(items)) {
    if (item.kind === "user-message") {
      const message = item as unknown as ItemOf<"user-message">;
      messages.set(message.messageId, message);
    } else if (item.kind === "tool-call") {
      const call = item as unknown as ItemOf<"tool-call">;
      toolCalls.set(call.toolCallId, call);
    } else if (item.kind === "check") {
      const check = item as unknown as ItemOf<"check">;
      checks.set(check.terminalId, check);
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
  /** `item` put among the items in sequence order: an assistant item settles after events that came after its first delta. */
  const place = <I extends Item>(item: I): I => {
    const after = items.findIndex((held) => held.sequence > item.sequence);
    if (after === -1) items.push(item);
    else items.splice(after, 0, item);
    return item;
  };

  for (const event of events) {
    const { sequence } = event;
    switch (event.type) {
      case "run.started": {
        suggestion = null;
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
        // A run started on the session: no rewind standing can be undone any more (ADR 0022), and each stays where it cut.
        for (const fold of folds) fold.undoable = false;
        break;
      }
      case "run.suggested": {
        const offer = RunSuggestion.parse(event.payload);
        const latest = [...runs.values()].at(-1);
        if (latest?.runId === offer.runId && latest.reason === "completed") suggestion = offer;
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
      case "run.update-interrupted": {
        const payload = event.payload as RunUpdateInterruptedPayload;
        push<ItemOf<"update-interrupted">>({ ...payload, kind: "update-interrupted", sequence });
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
          sender: parseActor(event.actor),
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
        if (item !== undefined) items = without(items, item);
        messages.delete(messageId);
        break;
      }
      case "assistant.delta": {
        // Only where the item was opened: the settled event carries the whole text.
        const payload = event.payload as AssistantDeltaPayload;
        for (const fragment of payload.fragments) {
          const key = `${fragment.kind} ${payload.itemId}`;
          const held = opened.get(key);
          if (held === undefined) opened.set(key, { sequence, runId: payload.runId, itemId: payload.itemId, kind: fragment.kind === "text" ? "assistant-text" : "assistant-thinking", text: fragment.text });
          else if (includeOpenItems) held.text += fragment.text;
        }
        break;
      }
      case "assistant.text":
      case "assistant.thinking": {
        const payload = event.payload as AssistantTextPayload;
        const key = `${event.type === "assistant.text" ? "text" : "thinking"} ${payload.itemId}`;
        const at = opened.get(key)?.sequence ?? sequence;
        opened.delete(key);
        place({
          kind: event.type === "assistant.text" ? "assistant-text" : "assistant-thinking",
          sequence: at,
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
      case "checks.started": {
        const payload = event.payload as ChecksStartedPayload;
        checks.set(payload.terminalId, push<ItemOf<"check">>({ kind: "check", sequence, ...payload, state: "running", result: null }));
        break;
      }
      case "checks.finished": {
        const { terminalId, output, truncated, exitCode, signal, timedOut, failure } = event.payload as ChecksFinishedPayload;
        const check = checks.get(terminalId);
        if (check !== undefined) Object.assign(check, { state: "finished", result: { output, truncated, exitCode, signal, timedOut, failure } });
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
        suggestion = null;
        // The rewound message and every item after it go into the rewind's fold, a fold among them nested; they stay in the log.
        const { toMessageId } = event.payload as SessionRewoundPayload;
        const target = messages.get(toMessageId);
        // Only a message the items show is rewound to (`sessions.rewind` takes no other); one a rewind hid hides nothing more.
        if (target === undefined || !items.includes(target)) break;
        const fold: Fold = { kind: "rewound", sequence, toMessageId, text: target.text, undoable: true, hidden: items.filter((item) => item.sequence >= target.sequence) };
        items = [...items.filter((item) => item.sequence < target.sequence), fold];
        folds.push(fold);
        break;
      }
      case "session.rewind-undone": {
        // What the rewind hid is shown again where it stood, before anything that came after the rewind.
        const { rewindSequence } = event.payload as SessionRewindUndonePayload;
        const undone = folds.find((fold) => fold.sequence === rewindSequence);
        if (undone === undefined) break;
        folds = folds.filter((fold) => fold !== undone);
        items = unfold(items, undone);
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
      case "session.forked": {
        const { fromSessionId, atMessageId, history } = event.payload as SessionForkedPayload;
        push<ItemOf<"forked">>({ kind: "forked", sequence, fromSessionId, atMessageId, ...(history !== undefined && { history }) });
        break;
      }
      case "session.history-imported": {
        // An imported session's history that could not be read is one line where it would have been (#579); an appended one is its events.
        const { outcome, message } = event.payload as SessionHistoryImportedPayload;
        if (outcome === "unreadable") push({ kind: "history-unreadable", sequence, message: message ?? "No reason was recorded." });
        break;
      }
      default:
        // An event of a type this environment does not know is kept, opaque (ADR 0001); a known one with no item is not an item.
        if (!knownType(event.type)) push({ kind: "opaque", sequence, type: event.type, payload: event.payload });
    }
  }
  // Copy-at-fork freezes even the partial assistant text visible during a live run. Ordinary snapshots remain settled
  // only; this option reads all deltas, and never changes what the source will later settle.
  if (includeOpenItems) for (const item of opened.values()) place({ ...item, aborted: false });
  const parts = partsOf(items);
  return { suggestion, runs: [...runs.values()], items: parts.items, parkedPrompts: [...parked.values()], rewinds: parts.rewinds };
};
