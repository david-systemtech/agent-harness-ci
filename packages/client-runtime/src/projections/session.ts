import {
  SESSION_STREAM_KIND,
  eventTypeEntry,
  type AssistantDeltaPayload,
  type AssistantTextPayload,
  type CommandRanPayload,
  type DelegatedWorkRow,
  type EventEnvelope,
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
  type SessionRewindUndonePayload,
  type SessionRewoundPayload,
  type SessionSummary,
  type TasksChangedPayload,
  type ToolDecisionPayload,
  type ToolEndedPayload,
  type ToolStartedPayload,
  type ToolUpdatedPayload,
  type TranscriptItem,
  type UsageReportedPayload,
} from "@agent-harness/contracts";
import { derived, notifyAll, type Observable } from "../observable.js";
import { overlaid, type OutboxView, type OverlayRecord, type WaitingDrafts } from "../outbox/overlay.js";
import type { SessionData, SessionSnapshotParts } from "../streams/kinds.js";
import type { Freshness, StreamState } from "../streams/stream.js";
import type { SessionLease } from "../streams/streams.js";

/**
 * `projections.session(environmentId, sessionId)` (docs/specs/client-runtime.md,
 * "Projections"): one session's stream reduced into what a transcript and a
 * run status render. The reducer (`reduceSession`) is a pure function of the
 * stream's snapshot (`SessionSnapshot`'s runs, settled items and parked
 * prompts, the claude-adapter spec's) and the events after it, in the
 * session-state, adapter and permissions vocabularies:
 *
 * - **runs** as the snapshot's `RunSummary`, `run.started` adding one,
 *   `usage.reported` and `run.ended` completing it;
 * - **messages** (`message.sent`) with their delivery, a queued one moved
 *   by `message.delivered`, `message.requeued` (the environment holds it
 *   now) and a `run.started` naming it among the queue it reads (read as
 *   that run's prompt); one withdrawn (`message.withdrawn`, #228) leaves the
 *   transcript as the environment's snapshot drops it, its text being the
 *   draft now. `queued` lists those still waiting to be read, in the order
 *   they were sent, whoever holds them (ADR 0022; #230);
 * - **assistant text and thinking**: the snapshot holds settled items only,
 *   so the deltas after it are applied here. A delta's fragments open (or
 *   extend) an entry per item id and fragment kind, `streaming` until its
 *   `assistant.text` or `assistant.thinking` settles it with the whole text
 *   (`aborted` when an interrupt cut it) or its run ends; an entry sits at
 *   the sequence of the event that opened it, its first delta;
 * - **tool calls** with `tool.updated` (the latest replaces the one before),
 *   `tool.ended` and the call's `tool.decision` (#131) folded in, a decision
 *   heard before its call's start held for it;
 * - **prompts, questions and plans** (`prompt.opened` by its kind:
 *   `permission` and `denylist` are `prompt`, `question` is `question`,
 *   `plan` is `plan`) at the sequence where they were asked, `parked` until
 *   their `prompt.answered` makes them `answered` with the answer; the
 *   parked ones are also `parkedPrompts`, oldest first;
 * - **subagent rows**: a subagent's tool calls (`tool.started` naming an
 *   `agentId`) gathered into one row at its first call, a row per run and
 *   agent id (the contracts do not promise an agent id unique across runs),
 *   with the delegated work that started it (the run's `tasks.changed` row
 *   whose `toolCallId` is the call the subagent's calls are nested under);
 * - the run's delegated-work ledger (`tasks`) and slash commands (`command`)
 *   as the snapshot has them;
 * - **`session.rewound`** cuts the message rewound to and every entry after
 *   it out of the transcript (they stay in the log; ADR 0022) into one
 *   `rewound` fold at the rewind point (#230): the cut branch, never mixed
 *   into the branch that continues after it, `undoable` until a run starts
 *   on the session (while `sessions.undoRewind` is offered), and kept where
 *   it was cut afterwards. A later rewind to a message before the fold cuts
 *   the fold with the rest, so rewinds stacked without a run between them
 *   nest, the latest outermost. `rewound` names the latest rewind standing,
 *   its message's text and whether it can still be undone.
 *   **`session.rewind-undone`** (#218) takes the fold of the rewind it names
 *   away and puts what it held back in place, in sequence order before
 *   anything that came after the rewind, and `rewound` falls back to the
 *   rewind before it that still stands (undoable only if no run has started
 *   since it, as the environment's `run_started` refusal says). The reducer
 *   keeps what a rewind hid only for a rewind it heard: the snapshot leaves
 *   out what a rewind hid, so an undo of one that stood when the snapshot
 *   was taken has nothing to show again here; the session's stream kind
 *   sees the same undo and resubscribes for a fresh snapshot, folded past
 *   it, which does (`undoesUnheardRewind`, `streams/kinds.ts`). For the same
 *   reason a snapshot taken after a rewind gives no fold and no `rewound`;
 * - an event of a type the contracts do not know, and one of a known type
 *   whose payload cannot be folded, is kept as an `opaque` entry naming its
 *   type, and the fold goes on (ADR 0001): an older client survives a newer
 *   environment. A snapshot item of a kind this client does not know is
 *   opaque the same way, naming its kind. A known type with nothing to show
 *   (the organisation events, `run.policy.resolved`, `plan.limit`, ...)
 *   makes no entry.
 *
 * The view (`projectSession`) puts the reduction beside the stream's
 * freshness, its summary with the outbox's overlay and a waiting draft laid
 * over it as the session list does (the outbox's debt from #128), and the
 * draft.
 */

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type SnapshotItem<K extends string> = Extract<TranscriptItem, { kind: K }>;

export type UserMessageEntry = SnapshotItem<"user-message">;

/** The assistant's text or thinking for one item: `streaming` while its deltas are still coming. */
export interface AssistantEntry {
  readonly kind: "assistant-text" | "assistant-thinking";
  readonly sequence: number;
  readonly runId: string;
  readonly itemId: string;
  readonly text: string;
  readonly aborted: boolean;
  readonly streaming: boolean;
}

/** A tool call with its updates, its end and its decision folded in. */
export interface ToolCallEntry extends SnapshotItem<"tool-call"> {
  /** How the call was decided, allowed or denied and by what (#131); null until its `tool.decision`, and for a call the snapshot folded (it does not carry one). */
  readonly decision: ToolDecisionPayload | null;
}

export type CommandEntry = SnapshotItem<"command">;
export type TasksEntry = SnapshotItem<"tasks">;

/** Where a prompt is: waiting for a person, or answered. */
export type PromptState = "parked" | "answered";

/** A prompt where it was asked: a permission (or denylist) prompt, a question, or a plan to approve. */
export interface PromptEntry {
  readonly kind: "prompt" | "question" | "plan";
  /** The sequence of its `prompt.opened`: where it was asked. */
  readonly sequence: number;
  readonly runId: string;
  readonly promptId: string;
  readonly state: PromptState;
  readonly prompt: PromptOpenedPayload;
  readonly answer: PromptAnsweredPayload | null;
}

/** One subagent of a run: its tool calls, gathered at its first, and the delegated work that started it. */
export interface SubagentEntry {
  readonly kind: "subagent";
  /** The sequence of its first call. */
  readonly sequence: number;
  readonly runId: string;
  readonly agentId: string;
  /** The tool call its calls are nested under: the call that started it. */
  readonly parentToolCallId: string | null;
  readonly calls: readonly ToolCallEntry[];
  /** The run's delegated-work row for it (its `subagentType`, description and status), when the ledger names the call that started it. */
  readonly task: DelegatedWorkRow | null;
  /** Its delegated work is live, or, with none known, one of its calls is still running. */
  readonly running: boolean;
}

/** An event this client cannot show, or a snapshot item of a kind it does not know: kept, naming its type (ADR 0001). */
export interface OpaqueEntry {
  readonly kind: "opaque";
  readonly sequence: number;
  /** The event's type; for a snapshot item of an unknown kind, that kind. */
  readonly type: string;
  /** The event's payload; for a snapshot item of an unknown kind, the item. */
  readonly payload: unknown;
}

/**
 * The branch a rewind cut (ADR 0022; #230): the message rewound to and every
 * entry after it, folded at the rewind point, so a renderer draws it closed
 * under the message's text and never among the entries that came after the
 * rewind. `sessions.undoRewind` takes it away and puts what it holds back in
 * place; after a run starts it stays, no longer undoable.
 */
export interface RewoundEntry {
  readonly kind: "rewound";
  /** The sequence of its `session.rewound`: the fold sits where the branch was cut. */
  readonly sequence: number;
  /** The user message rewound to: the first entry of the fold. */
  readonly toMessageId: string;
  /** That message's text, which the rewind put in the draft. */
  readonly text: string;
  /** No run has started on the session since the rewind: `sessions.undoRewind` can still bring the branch back. */
  readonly undoable: boolean;
  /** What the rewind cut, in the order the entries were opened; a fold an earlier rewind made among them is nested. */
  readonly items: readonly TranscriptEntry[];
}

export type TranscriptEntry = UserMessageEntry | AssistantEntry | ToolCallEntry | CommandEntry | TasksEntry | PromptEntry | SubagentEntry | RewoundEntry | OpaqueEntry;

/** The latest rewind standing on a session, not undone (ADR 0022): what the rewound strip says, and what `sessions.undoRewind` would take back. */
export interface RewoundAt {
  /** The user message rewound to. */
  readonly toMessageId: string;
  /** The sequence of the `session.rewound`. */
  readonly sequence: number;
  /** The message's text. */
  readonly text: string;
  /** No run has started since: the undo is offered. False once one has, when the environment refuses it (`run_started`). */
  readonly undoable: boolean;
}

/** What one session's stream reduces to. */
export interface SessionTranscript {
  /** Every run, oldest first. */
  readonly runs: readonly RunSummary[];
  /** The transcript, in the order its entries were opened; what a rewind cut is one `rewound` fold at the rewind point. */
  readonly items: readonly TranscriptEntry[];
  /** The prompts parked on the session, unanswered, oldest first. */
  readonly parkedPrompts: readonly ParkedPrompt[];
  /** The messages sent during a run and not yet read, withdrawn or carried by a run's start, in the order they were sent (ADR 0022). */
  readonly queued: readonly UserMessageEntry[];
  /** The latest rewind standing, undoable or not; null when none stands or none was heard. */
  readonly rewound: RewoundAt | null;
}

/** A rewind's fold as the reduction holds it: what it cut, as held, until an undo puts it back. */
interface HeldFold {
  readonly kind: "rewound";
  readonly sequence: number;
  readonly toMessageId: string;
  readonly text: string;
  undoable: boolean;
  hidden: Held[];
}

/** An entry as the fold holds it: of a known kind, before subagents are gathered, a rewind's fold, or opaque. */
type Held =
  | Mutable<UserMessageEntry>
  | Mutable<AssistantEntry>
  | Mutable<ToolCallEntry>
  | Mutable<CommandEntry>
  | Mutable<TasksEntry>
  | Mutable<PromptEntry>
  | HeldFold
  | OpaqueEntry;

const bySequence = (a: Held, b: Held): number => a.sequence - b.sequence;

/** `list` without `item`, wherever it is held: at the top, or inside a rewind's fold. */
const without = (list: Held[], item: Held): Held[] => {
  if (list.includes(item)) return list.filter((held) => held !== item);
  for (const held of list) if (held.kind === "rewound") held.hidden = without(held.hidden, item);
  return list;
};

/** `list` with `fold` taken away and what it cut put back in place, wherever the fold is held. */
const unfold = (list: Held[], fold: HeldFold): Held[] => {
  if (list.includes(fold)) return [...list.filter((held) => held !== fold), ...fold.hidden].sort(bySequence);
  for (const held of list) if (held.kind === "rewound") held.hidden = unfold(held.hidden, fold);
  return list;
};

const PROMPT_ENTRY_KINDS: Readonly<Record<PromptOpenedPayload["kind"], PromptEntry["kind"]>> = {
  permission: "prompt",
  denylist: "prompt",
  question: "question",
  plan: "plan",
};

const LIVE_TASK_STATES: ReadonlySet<string> = new Set(["pending", "running", "paused"]);

/** Whether `type` is one the session stream's table knows: organisation, prompt, permission or transcript. */
const knownType = (type: string): boolean => eventTypeEntry(SESSION_STREAM_KIND, type) !== undefined;

/** A snapshot item as the fold holds it: a copy, since the snapshot is the stream's and never changes here. */
const fromSnapshot = (item: TranscriptItem): Held => {
  switch (item.kind) {
    case "user-message":
    case "command":
    case "tasks":
      return { ...(item as SnapshotItem<"user-message" | "command" | "tasks">) } as Held;
    case "assistant-text":
    case "assistant-thinking": {
      const settled = item as SnapshotItem<"assistant-text" | "assistant-thinking">;
      return { kind: settled.kind, sequence: settled.sequence, runId: settled.runId, itemId: settled.itemId, text: settled.text, aborted: settled.aborted, streaming: false };
    }
    case "tool-call":
      return { ...(item as SnapshotItem<"tool-call">), decision: null };
    case "prompt": {
      // Its kind is one this client knows: the stream parsed the snapshot against `SessionSnapshot` (streams/kinds.ts), whose `prompt`
      // item holds its `prompt` to `PromptOpenedPayload`. An event's payload is not parsed, so `prompt.opened` below checks its kind.
      const prompt = item as SnapshotItem<"prompt">;
      return {
        kind: PROMPT_ENTRY_KINDS[prompt.prompt.kind],
        sequence: prompt.sequence,
        runId: prompt.runId,
        promptId: prompt.promptId,
        state: prompt.answer === null ? "parked" : "answered",
        prompt: prompt.prompt,
        answer: prompt.answer,
      };
    }
    default: {
      // The environment folds an event of a type it does not know into kind `opaque`, naming the type; any other kind is one this client does not know.
      const unknown = item as { kind: string; sequence: number; type?: unknown; payload?: unknown };
      if (unknown.kind === "opaque" && typeof unknown.type === "string") return { kind: "opaque", sequence: unknown.sequence, type: unknown.type, payload: unknown.payload ?? null };
      return { kind: "opaque", sequence: unknown.sequence, type: unknown.kind, payload: item };
    }
  }
};

/**
 * One session's snapshot and the events after it, oldest first, reduced
 * into its runs, transcript, parked prompts, queue and rewind. Pure: the
 * same input gives an equal output, and the snapshot is never changed.
 */
export const reduceSession = (snapshot: SessionSnapshotParts, events: readonly EventEnvelope[]): SessionTranscript => {
  const runs = new Map<string, Mutable<RunSummary>>(snapshot.runs.map((run) => [run.runId, { ...run }]));
  let items: Held[] = snapshot.items.map(fromSnapshot);
  const parked = new Map<string, ParkedPrompt>(snapshot.parkedPrompts.map((prompt) => [prompt.promptId, prompt]));
  /** The rewinds heard that still stand (not undone), oldest first, each its fold: undoable until a run starts. */
  let rewinds: HeldFold[] = [];
  /** The latest rewind standing: the one `sessions.undoRewind` would undo. */
  const rewound = (): RewoundAt | null => {
    const latest = rewinds.at(-1);
    return latest === undefined ? null : { toMessageId: latest.toMessageId, sequence: latest.sequence, text: latest.text, undoable: latest.undoable };
  };

  // The entries later events update, by the ids those carry.
  const messages = new Map<string, Mutable<UserMessageEntry>>();
  const toolCalls = new Map<string, Mutable<ToolCallEntry>>();
  const ledgers = new Map<string, Mutable<TasksEntry>>();
  const prompts = new Map<string, Mutable<PromptEntry>>();
  /** Assistant entries by `<fragment kind> <item id>`. */
  const assistant = new Map<string, Mutable<AssistantEntry>>();
  /** Decisions heard before their call started. */
  const decisions = new Map<string, ToolDecisionPayload>();
  for (const item of items) {
    if (item.kind === "user-message") messages.set(item.messageId, item);
    else if (item.kind === "tool-call") toolCalls.set(item.toolCallId, item);
    else if (item.kind === "tasks") ledgers.set(item.runId, item);
    else if (item.kind === "prompt" || item.kind === "question" || item.kind === "plan") prompts.set(item.promptId, item);
    else if (item.kind === "assistant-text" || item.kind === "assistant-thinking") assistant.set(`${item.kind === "assistant-text" ? "text" : "thinking"} ${item.itemId}`, item);
  }

  const push = <I extends Held>(item: I): I => {
    items.push(item);
    return item;
  };

  const fold = (event: EventEnvelope): void => {
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
          queuedMessageIds: [...payload.queuedMessageIds],
          startedAt: event.occurredAt,
          endedAt: null,
          reason: null,
          cause: null,
          error: null,
          usage: null,
          durationMs: null,
        });
        // The queue it reads leaves the queue here: read as this run's prompt (its message.delivered says so again).
        for (const messageId of payload.queuedMessageIds) {
          const message = messages.get(messageId);
          if (message?.delivery === "queued") Object.assign(message, { delivery: "prompt", heldBy: null, runId: payload.runId });
        }
        // A run started on a rewound session: no rewind before it can be undone any more, and each stays where it cut.
        for (const fold of rewinds) fold.undoable = false;
        return;
      }
      case "run.ended": {
        const payload = event.payload as RunEndedPayload;
        const run = runs.get(payload.runId);
        if (run !== undefined) {
          Object.assign(run, {
            state: "ended",
            endedAt: event.occurredAt,
            reason: payload.reason,
            cause: payload.cause,
            error: payload.error,
            usage: payload.usage ?? run.usage,
            durationMs: payload.durationMs,
          });
        }
        // What the run left open streams no more: its partial text stays, as ADR 0022 keeps it.
        for (const entry of assistant.values()) if (entry.runId === payload.runId) entry.streaming = false;
        return;
      }
      case "usage.reported": {
        const payload = event.payload as UsageReportedPayload;
        const run = runs.get(payload.runId);
        if (run !== undefined) run.usage = payload.models;
        return;
      }
      case "message.sent": {
        const payload = event.payload as MessageSentPayload;
        messages.set(
          payload.messageId,
          push<Mutable<UserMessageEntry>>({
            kind: "user-message",
            sequence,
            runId: payload.runId,
            messageId: payload.messageId,
            text: payload.text,
            attachments: payload.attachments,
            delivery: payload.delivery,
            heldBy: payload.heldBy,
            sentAt: event.occurredAt,
          }),
        );
        return;
      }
      case "message.delivered": {
        const payload = event.payload as MessageDeliveredPayload;
        const message = messages.get(payload.messageId);
        if (message !== undefined) Object.assign(message, { delivery: payload.delivery, heldBy: null, runId: payload.runId });
        return;
      }
      case "message.requeued": {
        const message = messages.get((event.payload as MessageRequeuedPayload).messageId);
        if (message !== undefined) Object.assign(message, { delivery: "queued", heldBy: "environment" });
        return;
      }
      case "message.withdrawn": {
        // Taken back before any run read it (#228): its text is the draft now, so it leaves the queue and the transcript, as
        // the environment's snapshot drops it; the log keeps it.
        const { messageId } = event.payload as MessageWithdrawnPayload;
        const message = messages.get(messageId);
        messages.delete(messageId);
        if (message !== undefined) items = without(items, message);
        return;
      }
      case "assistant.delta": {
        const payload = event.payload as AssistantDeltaPayload;
        if (!Array.isArray(payload.fragments)) throw new TypeError("assistant.delta carries no fragments.");
        for (const fragment of payload.fragments) {
          const key = `${fragment.kind} ${payload.itemId}`;
          const open = assistant.get(key);
          if (open === undefined) {
            const kind = fragment.kind === "thinking" ? "assistant-thinking" : "assistant-text";
            assistant.set(key, push({ kind, sequence, runId: payload.runId, itemId: payload.itemId, text: fragment.text, aborted: false, streaming: true }));
          } else if (open.streaming) {
            // A delta after the item settled (a late batch) adds nothing: the settled text is whole.
            open.text += fragment.text;
          }
        }
        return;
      }
      case "assistant.text":
      case "assistant.thinking": {
        const payload = event.payload as AssistantTextPayload;
        const thinking = event.type === "assistant.thinking";
        const key = `${thinking ? "thinking" : "text"} ${payload.itemId}`;
        const open = assistant.get(key);
        if (open !== undefined) Object.assign(open, { text: payload.text, aborted: payload.aborted, streaming: false });
        else {
          const kind = thinking ? "assistant-thinking" : "assistant-text";
          assistant.set(key, push({ kind, sequence, runId: payload.runId, itemId: payload.itemId, text: payload.text, aborted: payload.aborted, streaming: false }));
        }
        return;
      }
      case "tool.started": {
        const payload = event.payload as ToolStartedPayload;
        toolCalls.set(
          payload.toolCallId,
          push<Mutable<ToolCallEntry>>({
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
            decision: decisions.get(payload.toolCallId) ?? null,
          }),
        );
        decisions.delete(payload.toolCallId);
        return;
      }
      case "tool.updated": {
        const payload = event.payload as ToolUpdatedPayload;
        const call = toolCalls.get(payload.toolCallId);
        if (call !== undefined) call.update = payload.update;
        return;
      }
      case "tool.ended": {
        const payload = event.payload as ToolEndedPayload;
        const call = toolCalls.get(payload.toolCallId);
        if (call !== undefined) Object.assign(call, { status: payload.status, output: payload.output, durationMs: payload.durationMs });
        return;
      }
      case "tool.decision": {
        const payload = event.payload as ToolDecisionPayload;
        // A decision through a prompt that named no call is the prompt's answer's to show.
        if (payload.toolCallId === null) return;
        const call = toolCalls.get(payload.toolCallId);
        if (call !== undefined) call.decision = payload;
        else decisions.set(payload.toolCallId, payload);
        return;
      }
      case "command.ran": {
        const payload = event.payload as CommandRanPayload;
        push<Mutable<CommandEntry>>({ kind: "command", sequence, runId: payload.runId, name: payload.name, args: payload.args, output: payload.output });
        return;
      }
      case "tasks.changed": {
        const payload = event.payload as TasksChangedPayload;
        if (!Array.isArray(payload.tasks)) throw new TypeError("tasks.changed carries no tasks.");
        const held = ledgers.get(payload.runId);
        if (held !== undefined) held.tasks = payload.tasks;
        else ledgers.set(payload.runId, push<Mutable<TasksEntry>>({ kind: "tasks", sequence, runId: payload.runId, tasks: payload.tasks }));
        return;
      }
      case "session.rewound": {
        const { toMessageId } = event.payload as SessionRewoundPayload;
        const target = messages.get(toMessageId);
        // Only a message the transcript shows is rewound to; one it does not hold, or one an earlier rewind cut, hides nothing.
        if (target === undefined || !items.includes(target)) return;
        const fold: HeldFold = {
          kind: "rewound",
          sequence,
          toMessageId,
          text: target.text,
          undoable: true,
          hidden: items.filter((item) => item.sequence >= target.sequence),
        };
        items = [...items.filter((item) => item.sequence < target.sequence), fold];
        rewinds.push(fold);
        return;
      }
      case "session.rewind-undone": {
        const { rewindSequence } = event.payload as SessionRewindUndonePayload;
        const undone = rewinds.find((fold) => fold.sequence === rewindSequence);
        // One it did not hear (it stood when the snapshot was taken) has nothing to show again: the stream resubscribes for a fresh snapshot, which does.
        if (undone === undefined) return;
        rewinds = rewinds.filter((fold) => fold !== undone);
        items = unfold(items, undone);
        return;
      }
      case "prompt.opened": {
        const prompt = event.payload as PromptOpenedPayload;
        const kind = PROMPT_ENTRY_KINDS[prompt.kind];
        if (kind === undefined) throw new TypeError(`A prompt of kind ${String(prompt.kind)} is not one this client knows.`);
        parked.set(prompt.promptId, { promptId: prompt.promptId, sequence, openedAt: event.occurredAt, prompt });
        prompts.set(prompt.promptId, push<Mutable<PromptEntry>>({ kind, sequence, runId: prompt.runId, promptId: prompt.promptId, state: "parked", prompt, answer: null }));
        return;
      }
      case "prompt.answered": {
        const answer = event.payload as PromptAnsweredPayload;
        parked.delete(answer.promptId);
        const prompt = prompts.get(answer.promptId);
        if (prompt !== undefined) Object.assign(prompt, { state: "answered", answer });
        return;
      }
      default:
        if (!knownType(event.type)) push({ kind: "opaque", sequence, type: event.type, payload: event.payload });
    }
  };

  for (const event of events) {
    try {
      fold(event);
    } catch {
      // A known type whose payload cannot be folded (a newer environment's shape) is kept opaque like an unknown one, and the fold goes on.
      push({ kind: "opaque", sequence: event.sequence, type: event.type, payload: event.payload });
    }
  }

  return { runs: [...runs.values()], items: gatherSubagents(items, ledgersOf(items)), parkedPrompts: [...parked.values()], queued: queuedOf(messages), rewound: rewound() };
};

/**
 * The messages still waiting to be read, in the order they were sent: the
 * queue is the session's, not the transcript's, so one a rewind cut is
 * still in it (the environment's queue does not move with a rewind).
 */
const queuedOf = (messages: ReadonlyMap<string, Mutable<UserMessageEntry>>): UserMessageEntry[] =>
  [...messages.values()].filter((message) => message.delivery === "queued").sort((a, b) => a.sequence - b.sequence);

/** Each run's delegated-work ledger, wherever its entry is held: a subagent's row finds its run's inside a fold or out of it. */
const ledgersOf = (items: readonly Held[], into = new Map<string, readonly DelegatedWorkRow[]>()): Map<string, readonly DelegatedWorkRow[]> => {
  for (const item of items) {
    if (item.kind === "tasks") into.set(item.runId, item.tasks);
    else if (item.kind === "rewound") ledgersOf(item.hidden, into);
  }
  return into;
};

/** The entries with each subagent's calls gathered into one row at its first call, linked to the delegated work that started it; a fold's own entries gathered the same way. */
const gatherSubagents = (items: readonly Held[], ledgers: ReadonlyMap<string, readonly DelegatedWorkRow[]>): TranscriptEntry[] => {
  /** By `<run> <agent id>`: a subagent is its run's, and the contracts do not promise an agent id unique across runs. */
  const rows = new Map<string, { entry: Mutable<SubagentEntry>; calls: ToolCallEntry[] }>();
  const entries: TranscriptEntry[] = [];
  for (const item of items) {
    if (item.kind === "rewound") {
      const { hidden, ...fold } = item;
      entries.push({ ...fold, items: gatherSubagents(hidden, ledgers) });
      continue;
    }
    if (item.kind !== "tool-call" || item.agentId === null) {
      entries.push(item);
      continue;
    }
    const key = `${item.runId} ${item.agentId}`;
    let row = rows.get(key);
    if (row === undefined) {
      const calls: ToolCallEntry[] = [];
      row = {
        calls,
        entry: { kind: "subagent", sequence: item.sequence, runId: item.runId, agentId: item.agentId, parentToolCallId: item.parentToolCallId, calls, task: null, running: false },
      };
      rows.set(key, row);
      entries.push(row.entry);
    }
    row.calls.push(item);
  }
  for (const { entry, calls } of rows.values()) {
    const task = entry.parentToolCallId === null ? undefined : ledgers.get(entry.runId)?.find((row) => row.toolCallId === entry.parentToolCallId);
    entry.task = task ?? null;
    entry.running = task !== undefined ? LIVE_TASK_STATES.has(task.status) : calls.some((call) => call.status === "running");
  }
  return entries;
};

/** One session as `projections.session` shows it. */
export interface SessionProjection extends SessionTranscript {
  readonly environmentId: string;
  readonly sessionId: string;
  readonly freshness: Freshness;
  /** Why its subscription failed on a healthy socket, until it synchronizes again. */
  readonly fault: string | null;
  /** The session is gone: deleted or purged on its environment. */
  readonly deleted: boolean;
  /** Its summary as its own stream has it, with the outbox's overlay and a waiting draft laid over it; null while nothing is held, and once it is gone. */
  readonly summary: SessionSummary | null;
  /** The composer's draft, a session field (ticket 18): the summary's. */
  readonly draft: string | null;
}

export interface SessionProjectionInput {
  readonly environmentId: string;
  readonly sessionId: string;
  /** The session's stream; null when the runtime holds nothing of it. */
  readonly state: StreamState<SessionData> | null;
  /** The environment's overlays still shown, in dispatch order. */
  readonly overlays: readonly OverlayRecord[];
  /** A draft typed and not yet dispatched (`drafts.set`'s second); undefined when none waits. */
  readonly waitingDraft: string | null | undefined;
}

const NO_TRANSCRIPT: SessionTranscript = { runs: [], items: [], parkedPrompts: [], queued: [], rewound: null };

/** The view of one session: its stream's reduction beside its freshness, its overlaid summary and its draft. `transcript` reuses a reduction of the same data. */
export const projectSession = (input: SessionProjectionInput, transcript?: SessionTranscript): SessionProjection => {
  const { state, environmentId, sessionId } = input;
  const data = state?.data ?? null;
  const confirmed = data?.summary ?? null;
  let summary = confirmed;
  if (confirmed !== null && (input.overlays.length > 0 || input.waitingDraft !== undefined)) {
    const drafts = input.waitingDraft === undefined ? undefined : new Map([[confirmed.id, input.waitingDraft]]);
    summary = overlaid({ sessions: new Map([[confirmed.id, confirmed]]), groups: new Map() }, input.overlays, drafts).sessions.get(confirmed.id) ?? null;
  }
  return {
    environmentId,
    sessionId,
    freshness: state?.freshness ?? "empty",
    fault: state?.fault ?? null,
    deleted: data !== null && data.summary === null,
    summary,
    draft: summary?.draft ?? null,
    ...(transcript ?? (data === null ? NO_TRANSCRIPT : reduceSession(data.snapshot, data.events))),
  };
};

export interface SessionProjectionHost {
  /** Holds the session for as long as the projection is followed. */
  readonly lease: (environmentId: string, sessionId: string) => SessionLease;
  /** The session's stream while the runtime holds it; null otherwise. Holds nothing. */
  readonly peek: (environmentId: string, sessionId: string) => StreamState<SessionData> | null;
  readonly outbox: Observable<OutboxView>;
  readonly drafts: Observable<WaitingDrafts>;
}

/**
 * The observable `projections.session(environmentId, sessionId)` answers:
 * following it holds the session as a handle does (its subscription, from
 * its cached snapshot when there is one), and letting the last follower go
 * releases it, so its subscription lingers the five minutes a handle's
 * does. Reading it never subscribes anything: while nobody follows it, it
 * shows what the runtime holds of the session (a handle's, or the five
 * minutes after), else nothing (`empty`). The reduction is kept per stream
 * state, so an overlay or a draft changing does not reduce the stream again.
 */
export const sessionProjection = (host: SessionProjectionHost, environmentId: string, sessionId: string): Observable<SessionProjection> => {
  let lease: SessionLease | null = null;
  const listeners = new Set<(value: StreamState<SessionData> | null) => void>();
  let stop: (() => void) | null = null;
  const stream: Observable<StreamState<SessionData> | null> = {
    read: () => (lease !== null ? lease.state.read() : host.peek(environmentId, sessionId)),
    subscribe(listener) {
      listeners.add(listener);
      if (lease === null) {
        lease = host.lease(environmentId, sessionId);
        stop = lease.state.subscribe((value) => notifyAll(listeners, value));
      }
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0 || lease === null) return;
        stop?.();
        stop = null;
        lease.release();
        lease = null;
      };
    },
  };
  let reduced: { readonly data: SessionData; readonly transcript: SessionTranscript } | undefined;
  return derived([stream, host.outbox, host.drafts] as const, (state, outbox, drafts) => {
    const data = state?.data ?? null;
    if (data !== null && reduced?.data !== data) reduced = { data, transcript: reduceSession(data.snapshot, data.events) };
    return projectSession(
      { environmentId, sessionId, state, overlays: outbox.get(environmentId)?.overlays ?? [], waitingDraft: drafts.get(environmentId)?.get(sessionId) },
      data === null ? undefined : reduced?.transcript,
    );
  });
};
