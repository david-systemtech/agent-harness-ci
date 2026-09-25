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
 *   by `message.delivered` and `message.requeued`; `queued` lists those
 *   still waiting to be read (ADR 0022);
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
 * - **`session.rewound`** hides the message rewound to and every entry
 *   after it (they stay in the log; ADR 0022), and `rewound` says so until
 *   the next run starts, while `sessions.undoRewind` is offered;
 *   **`session.rewind-undone`** (#218) shows what the rewind it names hid
 *   again, in sequence order before anything that came after the rewind,
 *   and `rewound` falls back to the rewind before it that still stands,
 *   which a run starting ends as it ends the latest. The reducer keeps what
 *   a rewind hid only for a rewind it heard: the snapshot leaves out what a
 *   rewind hid, so an undo of one that stood when the snapshot was taken has
 *   nothing to show again here, and the client subscribes again for a fresh
 *   snapshot to see it (session-state spec). For the same reason a snapshot
 *   taken after a rewind gives no `rewound`;
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

export type TranscriptEntry = UserMessageEntry | AssistantEntry | ToolCallEntry | CommandEntry | TasksEntry | PromptEntry | SubagentEntry | OpaqueEntry;

/** The rewind a session is at, until a run starts on it or it is undone (ADR 0022: `sessions.undoRewind` is offered until then). */
export interface RewoundAt {
  readonly toMessageId: string;
  /** The sequence of the `session.rewound`. */
  readonly sequence: number;
}

/** What one session's stream reduces to. */
export interface SessionTranscript {
  /** Every run, oldest first. */
  readonly runs: readonly RunSummary[];
  /** The transcript, in the order its entries were opened; what a rewind hid is left out. */
  readonly items: readonly TranscriptEntry[];
  /** The prompts parked on the session, unanswered, oldest first. */
  readonly parkedPrompts: readonly ParkedPrompt[];
  /** The messages sent during a run and not yet read, in order (ADR 0022). */
  readonly queued: readonly UserMessageEntry[];
  readonly rewound: RewoundAt | null;
}

/** An entry as the fold holds it: of a known kind, before subagents are gathered, or opaque. */
type Held = Mutable<UserMessageEntry> | Mutable<AssistantEntry> | Mutable<ToolCallEntry> | Mutable<CommandEntry> | Mutable<TasksEntry> | Mutable<PromptEntry> | OpaqueEntry;

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
  /** The rewinds heard that still stand, oldest first, each with what it hid: undoable until a run starts, which ends them all. */
  let rewinds: { readonly at: RewoundAt; readonly hidden: readonly Held[] }[] = [];
  /** The latest rewind standing: the one `sessions.undoRewind` would undo. */
  const rewound = (): RewoundAt | null => rewinds.at(-1)?.at ?? null;

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
        // A run started on a rewound session: no rewind before it can be undone any more.
        rewinds = [];
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
        if (target === undefined || !items.includes(target)) return;
        rewinds.push({ at: { toMessageId, sequence }, hidden: items.filter((item) => item.sequence >= target.sequence) });
        items = items.filter((item) => item.sequence < target.sequence);
        return;
      }
      case "session.rewind-undone": {
        const { rewindSequence } = event.payload as SessionRewindUndonePayload;
        const undone = rewinds.find((rewind) => rewind.at.sequence === rewindSequence);
        // One it did not hear (it stood when the snapshot was taken) has nothing to show again: a fresh snapshot does.
        if (undone === undefined) return;
        rewinds = rewinds.filter((rewind) => rewind !== undone);
        items = [...items, ...undone.hidden].sort((a, b) => a.sequence - b.sequence);
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

  return { runs: [...runs.values()], items: gatherSubagents(items), parkedPrompts: [...parked.values()], queued: queuedOf(items), rewound: rewound() };
};

/** The messages still waiting to be read, in order. */
const queuedOf = (items: readonly Held[]): UserMessageEntry[] =>
  items.filter((item): item is Mutable<UserMessageEntry> => item.kind === "user-message" && item.delivery === "queued");

/** The entries with each subagent's calls gathered into one row at its first call, linked to the delegated work that started it. */
const gatherSubagents = (items: readonly Held[]): TranscriptEntry[] => {
  const ledgers = new Map<string, readonly DelegatedWorkRow[]>();
  for (const item of items) if (item.kind === "tasks") ledgers.set(item.runId, item.tasks);
  /** By `<run> <agent id>`: a subagent is its run's, and the contracts do not promise an agent id unique across runs. */
  const rows = new Map<string, { entry: Mutable<SubagentEntry>; calls: ToolCallEntry[] }>();
  const entries: TranscriptEntry[] = [];
  for (const item of items) {
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
