import { PRODUCT_NAME, type PromptKind } from "@agent-harness/contracts";
import type { RunState, RunsView } from "../projections/runs.js";

/**
 * What a client says to somebody who is not looking at it, as both renderers
 * say it (docs/specs/tui.md, "Attention"; docs/specs/gui.md, "Parked asks,
 * attention and notices"): the one word a window's title shows for every
 * session across the environments, and the two sentences a notification
 * carries. Pure: none of it touches the clock, the runtime or a stream. When
 * a client rings, and how its title and notifications are drawn, stay each
 * renderer's: the terminal UI's bell and OSC title, the desktop's shell.
 *
 * Every session of every enabled environment is reduced, as
 * `projections.runs` has them, so the title says what the harness is doing,
 * not what the session on screen is doing. A prompt of each kind says what
 * it waits for.
 */

/** What a client says about the harness: someone is needed, work is in flight, or nothing is. */
export type HarnessActivity = "ready" | "working" | "needs-you";

/** What the title needs to know about one session: its run state, and the prompts it is parked on. */
export interface SessionActivity {
  readonly status: RunState;
  readonly pendingPrompts: number;
}

export interface TitleState {
  readonly state: HarnessActivity;
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

/** Every session `projections.runs` holds, in one word: a session parked on a prompt is one waiting on a person. */
export const harnessActivity = (runs: RunsView): TitleState =>
  titleStateOf([...runs.sessions.values()].flatMap((sessions) => [...sessions.values()].map((run) => ({ status: run.state, pendingPrompts: run.state === "parked" ? 1 : 0 }))));

/** Why a notification rings: a prompt waits on a person, or a turn has finished. */
export type AttentionKind = "needs-you" | "finished";

/** What a notification says: why it rang, the session it is about, and one sentence. */
export interface AttentionNotification {
  readonly kind: AttentionKind;
  readonly title: string;
  readonly body: string;
}

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
export const notificationFor = (kind: AttentionKind, subject: AttentionSubject = {}): AttentionNotification => ({
  kind,
  title: oneWord(subject.session) ?? PRODUCT_NAME,
  body: kind === "needs-you" ? waitingFor(subject) : (firstLine(subject.reply) ?? "The turn has finished"),
});
