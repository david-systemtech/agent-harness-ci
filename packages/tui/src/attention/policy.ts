import type { RunState } from "@agent-harness/client-runtime";
import { PRODUCT_NAME, type PromptKind } from "@agent-harness/contracts";
import { formatDuration, formatUsd } from "../transcript/format.js";
import type { AttentionKind, AttentionNotice, TerminalActivity } from "./chrome.js";

/**
 * What the window chrome should say, worked out from what the sessions are
 * doing (docs/specs/tui.md, "Attention"; carried from Artemis's
 * `apps/tui/src/attention.ts` at 443cf2e): the one word a title shows for
 * every session across the environments, the two sentences a notification
 * carries, and the line that greets somebody who has been away from the
 * keyboard. Pure: none of it touches the clock, the runtime or a stream.
 *
 * Artemis reduced its pool of conversations; the harness reduces every
 * session of every enabled environment, as `projections.runs` has them, so
 * the title says what the harness is doing, not what the session on screen
 * is doing. A prompt of each kind says what it waits for, and the away
 * summary says a session "is waiting on you" whatever its prompt's kind (a
 * chosen default: Artemis had only permission requests to name).
 */

/** What the title needs to know about one session: its run state, and the prompts it is parked on. */
export interface SessionActivity {
  readonly status: RunState;
  readonly pendingPrompts: number;
}

export interface TitleState {
  readonly state: TerminalActivity;
  /** How many sessions wait on a person; zero unless `needs-you`. */
  readonly needing: number;
}

/** The run states a title calls work in flight: from the key that started it until its run ends. */
const WORKING: ReadonlySet<RunState> = new Set<RunState>(["starting", "running", "parked"]);

/**
 * Every session, in one word, in the order a person cares: one waiting on
 * them beats work in flight beats nothing to do. A session parked on a
 * prompt is counted as waiting, never also as working.
 */
export const titleStateOf = (sessions: readonly SessionActivity[]): TitleState => {
  let needing = 0;
  let working = false;
  for (const session of sessions) {
    if (session.pendingPrompts > 0) needing += 1;
    else if (WORKING.has(session.status)) working = true;
  }
  if (needing > 0) return { state: "needs-you", needing };
  return { state: working ? "working" : "ready", needing: 0 };
};

/** The session a notification is about, in the parts it is built from. */
export interface AttentionSubject {
  /** The session's title, when it has one. */
  readonly session?: string;
  /** For `needs-you`: what kind of prompt waits, and the tool a permission or denylist prompt names. */
  readonly prompt?: PromptKind;
  readonly tool?: string;
  /** For `finished`: what the agent said. Only its first line is used. */
  readonly reply?: string;
}

/** A name, or nothing if it is blank. */
const oneWord = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? undefined : trimmed;
};

/** The first line with anything on it: a reply often opens with a blank line. */
const firstLine = (text: string | undefined): string | undefined => {
  if (text === undefined) return undefined;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
};

const waitingFor = (subject: AttentionSubject): string => {
  if (subject.prompt === "question") return "A question is waiting for an answer";
  if (subject.prompt === "plan") return "A plan is waiting for approval";
  const tool = oneWord(subject.tool);
  return tool === undefined ? "Waiting for permission" : `${tool} is waiting for permission`;
};

/**
 * The two sentences of a notification: the title names the session (which
 * one wants you), the body says what happened; both fall back to words
 * rather than to nothing, since something rang.
 */
export const noticeFor = (kind: AttentionKind, subject: AttentionSubject = {}): AttentionNotice => ({
  kind,
  title: oneWord(subject.session) ?? PRODUCT_NAME,
  body: kind === "needs-you" ? waitingFor(subject) : (firstLine(subject.reply) ?? "The turn has finished"),
});

/** A turn that ended, in the parts worth reporting afterwards. */
export interface RunEnded {
  /** This terminal's clock when it heard the run end, in milliseconds. */
  readonly at: number;
  readonly durationMs?: number | undefined;
  readonly costUsd?: number | undefined;
  /** It ended in an error rather than in an answer. */
  readonly failed?: boolean | undefined;
}

/** One session, as the away summary reads it. */
export interface RecapSubject {
  readonly title?: string | undefined;
  readonly status: RunState;
  readonly pendingPrompts: number;
  /** Its last finished turn, whenever that was. */
  readonly lastRun?: RunEnded | undefined;
  /** This terminal's clock when it heard a prompt park on it; stale once answered. */
  readonly askedAt?: number | undefined;
}

/** How many things the line names before it counts the rest. */
export const RECAP_CLAUSES = 2;

/** How long a keyboard must have been still for the next key to be a return. */
export const AWAY_MS = 3 * 60_000;

/** How long the away summary stays on the line. */
export const RECAP_FLASH_MS = 8_000;

const UNNAMED = "a session";

/** One session's news since `since`, or nothing: a waiting prompt outranks a finished turn. */
const recapClause = (subject: RecapSubject, since: number): string | undefined => {
  const name = oneWord(subject.title) ?? UNNAMED;
  if (subject.pendingPrompts > 0) return subject.askedAt !== undefined && subject.askedAt > since ? `${name} is waiting on you` : undefined;
  const run = subject.lastRun;
  // Still working: what it finished before this turn is not the news.
  if (run === undefined || run.at <= since || WORKING.has(subject.status)) return undefined;
  if (run.failed === true) return `${name} stopped with an error`;
  const spent = [run.durationMs === undefined ? undefined : formatDuration(run.durationMs), run.costUsd === undefined ? undefined : formatUsd(run.costUsd)].filter(
    (part): part is string => part !== undefined,
  );
  return spent.length === 0 ? `${name} finished` : `${name} finished (${spent.join(", ")})`;
};

/**
 * What changed while the keyboard was untouched (`since` is the last
 * keypress): names first, two clauses then a count, in the order given (the
 * rail's), and nothing at all when nothing changed.
 */
export const awayRecap = (subjects: readonly RecapSubject[], since: number): string | undefined => {
  const clauses = subjects.map((subject) => recapClause(subject, since)).filter((clause): clause is string => clause !== undefined);
  if (clauses.length === 0) return undefined;
  const named = clauses.slice(0, RECAP_CLAUSES);
  const rest = clauses.length - named.length;
  return `while you were away: ${named.join(" · ")}${rest > 0 ? ` · +${rest} more` : ""}`;
};
