import { checkPassed, type DelegatedWorkRow, type RunSummary } from "@agent-harness/contracts";
import type {
  AssistantEntry,
  CommandEntry,
  CheckEntry,
  ForkedEntry,
  HistoryUnreadableEntry,
  OpaqueEntry,
  PromptEntry,
  RewoundEntry,
  SessionProjection,
  SubagentEntry,
  ToolCallEntry,
  TranscriptEntry,
  UpdateInterruptedEntry,
  UserMessageEntry,
} from "../projections/session.js";
import { isLiveTask } from "./tasks.js";

/**
 * The transcript's rows (docs/specs/tui.md, "The transcript: a projection of
 * one session"; docs/specs/gui.md, "A session pane"): `projections.session`'s
 * entries in the order they were opened, folded, and nothing rebuilt
 * client-side. Both renderers draw these rows, so a session folds the same
 * way in the terminal and in the window (ADR 0004): a row is what the
 * terminal's cursor lands on and what its pager, `/export` and `/copy` read,
 * and what the window's transcript draws; how it is drawn is each renderer's.
 *
 * - **A run's tool calls are one row**, at the place its first call was made:
 *   its finished calls fold into one count and
 *   what is running or went wrong stands under it in full. A subagent's calls
 *   are the runtime's `subagent` entry, a row of their own.
 * - **A queued message is not a row**: it is on the queued line (the
 *   terminal's) or its queued row (the window's) until it is steered or read
 *   (ADR 0022). Steered, it is a row where it was sent, in
 *   the turn it was folded into; read as the prompt of a later run (a
 *   read-now, or the run of the queue after a turn), it opens that run: its
 *   row is drawn before the run's first row, in the order the queue was sent,
 *   and before any row of a run that started after it, so a run of the queue
 *   that drew nothing of its own still stands in its place.
 * - **Prompts, questions and plans** stand at the sequence of their
 *   `prompt.opened` (permissions spec), answered or parked; a plan draws its
 *   text in place.
 * - **Delegated work** (`tasks`) is not a row: the live run's live tasks
 *   (`liveTasks`) are the strip under the transcript.
 * - **Under each finished turn**, a `turn` row: how it ended, how long it
 *   took, its tokens and dollars, and the plan windows it moved when known.
 * - **An event this version cannot show** is one dim row naming its type
 *   (ADR 0001): an older client survives a newer environment.
 * - **What a rewind cut** (the runtime's `rewound` fold, #230) is one row
 *   where the branch was cut, never among the rows that came after the
 *   rewind (#232): the rows it holds are made as these are, and drawn under
 *   it only when it is unfolded; a fold an earlier rewind made among them is
 *   a fold again inside it.
 * - **A fork opens on where it came from** (the runtime's `forked` entry,
 *   #390): one row naming its source and the message it was taken before,
 *   which opens the source; `forkedFrom` finds the source's title and the
 *   message's text in the source's own projection, so both renderers name
 *   them alike.
 *
 * Pure: the projection goes in, plain data comes out.
 */

export type TranscriptRow =
  | { readonly kind: "user"; readonly id: string; readonly runId: string; readonly entry: UserMessageEntry }
  | { readonly kind: "update-interrupted"; readonly id: string; readonly runId: null; readonly entry: UpdateInterruptedEntry }
  | { readonly kind: "assistant"; readonly id: string; readonly runId: string; readonly entry: AssistantEntry }
  | { readonly kind: "calls"; readonly id: string; readonly runId: string; readonly calls: readonly ToolCallEntry[] }
  | { readonly kind: "command"; readonly id: string; readonly runId: string; readonly entry: CommandEntry }
  | { readonly kind: "check"; readonly id: string; readonly runId: null; readonly entry: CheckEntry }
  | { readonly kind: "prompt"; readonly id: string; readonly runId: string; readonly entry: PromptEntry }
  | { readonly kind: "subagent"; readonly id: string; readonly runId: string; readonly entry: SubagentEntry }
  | { readonly kind: "turn"; readonly id: string; readonly runId: string; readonly run: RunSummary }
  | { readonly kind: "opaque"; readonly id: string; readonly runId: null; readonly entry: OpaqueEntry }
  /** A fork's first row: the session it was forked from and the message it was taken before, which opening the row opens. */
  | { readonly kind: "forked"; readonly id: string; readonly runId: null; readonly entry: ForkedEntry }
  /** An imported session's line saying its history could not be read from the account's directory, and why (#579). */
  | { readonly kind: "history-unreadable"; readonly id: string; readonly runId: null; readonly entry: HistoryUnreadableEntry }
  /** The branch a rewind cut, folded where it was cut: the rows it holds, drawn under it when unfolded. */
  | { readonly kind: "rewound"; readonly id: string; readonly runId: null; readonly entry: RewoundEntry; readonly rows: readonly TranscriptRow[] };

/** The row a run's calls fold into: named for the run, so it keeps its id as the run makes more calls. */
export const callsRowId = (runId: string): string => `calls:${runId}`;

/** The status both Clients draw beside a Workspace check's command. */
export const checkStatus = (check: CheckEntry): string => {
  if (check.state === "running") return "running";
  const result = check.result;
  if (result.timedOut) return "timed out";
  if (result.failure !== null) return result.failure === "launch_failed" ? "launch failed" : result.failure;
  if (result.signal !== null) return `signal ${result.signal}`;
  return checkPassed(result) ? "passed" : result.exitCode === null ? "failed" : `exit ${result.exitCode}`;
};

/** The row a rewind's fold is: named for its `session.rewound`. */
export const rewoundRowId = (sequence: number): string => `rewound:${sequence}`;

/**
 * Whether `row` is the fold whose rewind can be undone: the latest rewind
 * standing (`projections.runs.session`'s `rewound`, by its sequence), while
 * no run has started since. Whatever offers the undo on a fold asks this one
 * question.
 */
export const undoableFold = (row: TranscriptRow | undefined, latest: { readonly sequence: number } | null | undefined): boolean =>
  row?.kind === "rewound" && latest != null && latest.sequence === row.entry.sequence && row.entry.undoable;

/**
 * How many user messages `rows` hold, what a rewind's fold among them cut
 * counted too: the "N prompts cut" a fold says, which both renderers count
 * alike.
 */
export const promptsIn = (rows: readonly TranscriptRow[]): number =>
  rows.reduce((count, row) => count + (row.kind === "user" ? 1 : row.kind === "rewound" ? promptsIn(row.rows) : 0), 0);

/** The rows of a session's projection, in the order they are drawn. */
export const transcriptRows = (view: Pick<SessionProjection, "items" | "runs">): readonly TranscriptRow[] => {
  const drawn: TranscriptRow[] = [];
  const groups = new Map<string, ToolCallEntry[]>();
  // The queued messages each run read as its prompt, by message: their rows wait for the run's first row, and open it.
  const readBy = new Map<string, string>();
  for (const run of view.runs) for (const messageId of run.queuedMessageIds) readBy.set(messageId, run.runId);
  const opening = new Map<string, TranscriptRow[]>();
  // Where each run started among the session's runs: what a run read is released before any later run's rows, in that order.
  const started = new Map(view.runs.map((run, index) => [run.runId, index]));
  const startOf = (runId: string) => started.get(runId) ?? Number.POSITIVE_INFINITY;
  /** Draws what the runs up to `runId` read and have not drawn yet: `runId`'s own, and every run's that started before it. */
  const open = (runId: string) => {
    const due = [...opening.keys()].filter((waiting) => waiting === runId || startOf(waiting) < startOf(runId)).sort((a, b) => startOf(a) - startOf(b));
    for (const waiting of due) {
      drawn.push(...(opening.get(waiting) ?? []));
      opening.delete(waiting);
    }
  };
  /** Draws a row, after what its run, or a run that started before it, read as its prompt and has not drawn yet. */
  const push = (row: TranscriptRow) => {
    if (row.runId !== null && opening.size > 0) open(row.runId);
    drawn.push(row);
  };
  for (const entry of view.items) {
    switch (entry.kind) {
      case "user-message": {
        // A queued message is on the queued line until a run reads it or the provider steers it.
        if (entry.delivery === "queued") break;
        const row: TranscriptRow = { kind: "user", id: `message:${entry.messageId}`, runId: entry.runId, entry };
        if (readBy.get(entry.messageId) === entry.runId) opening.set(entry.runId, [...(opening.get(entry.runId) ?? []), row]);
        else push(row);
        break;
      }
      case "assistant-text":
      case "assistant-thinking":
        if (entry.text.length > 0 || entry.streaming) {
          push({ kind: "assistant", id: `${entry.kind === "assistant-text" ? "text" : "thinking"}:${entry.itemId}`, runId: entry.runId, entry });
        }
        break;
      case "tool-call": {
        const held = groups.get(entry.runId);
        if (held) held.push(entry);
        else {
          const calls = [entry];
          groups.set(entry.runId, calls);
          push({ kind: "calls", id: callsRowId(entry.runId), runId: entry.runId, calls });
        }
        break;
      }
      case "command":
        push({ kind: "command", id: `command:${entry.sequence}`, runId: entry.runId, entry });
        break;
      case "check":
        push({ kind: "check", id: `check:${entry.terminalId}`, runId: null, entry });
        break;
      case "prompt":
      case "question":
      case "plan":
        push({ kind: "prompt", id: `prompt:${entry.promptId}`, runId: entry.runId, entry });
        break;
      case "subagent":
        push({ kind: "subagent", id: `subagent:${entry.runId}:${entry.agentId}`, runId: entry.runId, entry });
        break;
      case "tasks":
        // Delegated work is the strip's, not a row.
        break;
      case "opaque":
        push({ kind: "opaque", id: `opaque:${entry.sequence}`, runId: null, entry });
        break;
      case "forked":
        push({ kind: "forked", id: `forked:${entry.sequence}`, runId: null, entry });
        break;
      case "update-interrupted":
        push({ kind: "update-interrupted", id: `update-interrupted:${entry.sequence}`, runId: null, entry });
        break;
      case "history-unreadable":
        push({ kind: "history-unreadable", id: `history-unreadable:${entry.sequence}`, runId: null, entry });
        break;
      case "rewound":
        // The cut branch's rows are its own: what its runs read opens them inside the fold, and its turns close them there.
        push({ kind: "rewound", id: rewoundRowId(entry.sequence), runId: null, entry, rows: transcriptRows({ items: entry.items, runs: view.runs }) });
        break;
      default: {
        // Every entry kind is drawn or dropped on purpose: a kind the runtime adds is a compile error here until it is.
        const unhandled: never = entry;
        void unhandled;
      }
    }
  }
  // A run that has drawn nothing yet still opens with what it read, in the order the runs started.
  for (const runId of [...opening.keys()].sort((a, b) => startOf(a) - startOf(b))) open(runId);
  return withTurns(drawn, view.runs);
};

/** The rows with a `turn` row after the last row of each finished run; a run with no row of its own has none. */
const withTurns = (rows: readonly TranscriptRow[], runs: readonly RunSummary[]): readonly TranscriptRow[] => {
  const ended = new Map(runs.filter((run) => run.state === "ended").map((run) => [run.runId, run]));
  if (ended.size === 0) return rows;
  const last = new Map<string, number>();
  rows.forEach((row, index) => {
    if (row.runId !== null && ended.has(row.runId)) last.set(row.runId, index);
  });
  const out: TranscriptRow[] = [];
  rows.forEach((row, index) => {
    out.push(row);
    for (const [runId, at] of last) {
      const run = ended.get(runId);
      if (at === index && run) out.push({ kind: "turn", id: `turn:${runId}`, runId, run });
    }
  });
  return out;
};

/** What a fork's row names of its source: the source's title, and the text of the message the fork was taken before; each null while not known. */
export interface ForkedFrom {
  readonly title: string | null;
  readonly anchor: string | null;
}

/**
 * What a fork's `forked` entry names, read from its source's projection
 * (`projections.session` for `entry.fromSessionId`): the source's title
 * while the runtime holds its summary, and the text of the message the fork
 * was taken before, wherever the source shows it (a later rewind of the
 * source may have cut it into a fold). Neither for a source not held (or
 * gone), nor the text for a message the source does not hold: a fork of a
 * fork no run had continued is anchored at its source's own anchor, a
 * message of the source's source.
 */
export const forkedFrom = (
  entry: ForkedEntry,
  source: { readonly summary: { readonly title: string } | null; readonly items: readonly TranscriptEntry[] } | undefined,
): ForkedFrom => {
  const messageId = entry.atMessageId?.toLowerCase();
  const find = (items: readonly TranscriptEntry[]): string | null => {
    for (const item of items) {
      if (item.kind === "user-message" && item.messageId.toLowerCase() === messageId) return item.text;
      if (item.kind === "rewound") {
        const found = find(item.items);
        if (found !== null) return found;
      }
    }
    return null;
  };
  return { title: source?.summary?.title ?? null, anchor: messageId === undefined || source === undefined ? null : find(source.items) };
};

/** Whether a call is folded into its run's count: it finished, and nothing about it went wrong. */
export const folded = (call: ToolCallEntry): boolean => (call.status === "ok" || call.status === "cancelled") && call.decision?.decision !== "denied";

/** The run live on the session, when there is one: its last run still running. */
export const liveRun = (view: Pick<SessionProjection, "runs">): RunSummary | undefined => view.runs.findLast((run) => run.state === "running");

/** The assistant's last reply: the last settled text of the last run that said anything. */
export const lastReply = (view: Pick<SessionProjection, "items">): AssistantEntry | undefined =>
  view.items.findLast((entry): entry is AssistantEntry => entry.kind === "assistant-text" && entry.text.length > 0);

/** The delegated work still going in the run live now (`runId`): the strip under the transcript. None with no run live. */
export const liveTasks = (view: Pick<SessionProjection, "items">, runId: string | undefined): readonly DelegatedWorkRow[] => {
  if (runId === undefined) return [];
  const ledger = view.items.findLast((entry) => entry.kind === "tasks" && entry.runId === runId);
  return ledger?.kind === "tasks" ? ledger.tasks.filter(isLiveTask) : [];
};

/** The import actor appended historical human messages; other system actors authored their messages. */
export const environmentMessage = (entry: UserMessageEntry): boolean => entry.sender?.kind === "system" && entry.sender.id !== "carry-over";

/** The update cut's line, shared by both renderers and transcript exports. */
export const updateInterruptedText = (entry: UpdateInterruptedEntry): string => {
  const prefix = `Updated to ${entry.toVersion} while this ran; `;
  switch (entry.outcome) {
    case "continued": return `${prefix}continued`;
    case "waiting-on-prompt": return `${prefix}waits for your answer to the parked prompt`;
    case "next-message": {
      const reasons = {
        "no-resume": "the provider cannot resume this run",
        account: "the account changed or is signed out",
        mode: "the mode changed",
        workspace: "the workspace is gone",
        deleted: "the session was deleted",
        completions: "the caller must retry the completions request",
      } as const;
      return `${prefix}waits for your next message: ${reasons[entry.reason]}`;
    }
  }
};
