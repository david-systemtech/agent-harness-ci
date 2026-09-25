import type { SessionTitleGeneratedPayload } from "@agent-harness/contracts";
import type { EventInput, EventLog } from "../event-log/event-log.js";
import { appendDecided } from "./companions.js";
import { present, unchanged, type Decision, type SessionState } from "./decider.js";
import { readSessionState } from "./session-reads.js";
import { sessionStream } from "./streams.js";

/**
 * The title fallback (session-state spec, "Title fallback"): the generated
 * title a session shows while the user has set none. It is set once from
 * the first user message (`session.title-generated`, source `prompt`), in
 * the transaction of that message's `message.sent` and naming it as its
 * causation (`activity-companions.ts` appends it); a fork not given a title
 * is created with its source's title instead, under the same source
 * (`fork-rewind.ts`), so its first message sets none. A title the provider
 * generates replaces it (source `provider`) unless the user has set a title,
 * which always wins. Which title a session shows is the session list's
 * projection (`titleOf`): the user's, else the generated one, else "New
 * session", so a rename to null reverts to the generated title.
 *
 * The prompt's title is generated under a user title too: it is the
 * fallback a later rename to null reverts to, and the session shows the
 * user's title all the while. The mirror of a user title to the provider is
 * the adapter host's (`adapter/host.ts`), after commit.
 */

/** The most characters a generated title has. */
export const GENERATED_TITLE_LENGTH = 80;

/**
 * The title a text generates: its first line with anything but white space
 * on it, every run of white space collapsed to one space and the ends
 * trimmed, cut to `GENERATED_TITLE_LENGTH` characters (whole code points, so
 * no character is split) with no white space left at the cut. Null for a
 * text with no such line.
 */
export const generatedTitle = (text: string): string | null => {
  const line = text.split(/\r\n|\r|\n/).find((candidate) => candidate.trim() !== "");
  if (line === undefined) return null;
  const collapsed = line.replace(/\s+/g, " ").trim();
  return Array.from(collapsed).slice(0, GENERATED_TITLE_LENGTH).join("").trimEnd();
};

const titleGenerated = (payload: SessionTitleGeneratedPayload): EventInput => ({ type: "session.title-generated", payload });

/**
 * The title a user message generates: one `session.title-generated`, source
 * `prompt`, while the session has no generated title and the message has a
 * non-empty line; nothing otherwise, so it is set once. A session deleted or
 * not there generates nothing.
 */
export const decidePromptTitle = (state: SessionState | null, text: string): EventInput[] => {
  if (state === null || state.deleted || state.generatedTitle !== null) return [];
  const title = generatedTitle(text);
  return title === null ? [] : [titleGenerated({ title, source: "prompt" })];
};

/** A title a session's provider reported for it. */
export interface ProviderTitle {
  readonly sessionId: string;
  readonly title: string;
}

/**
 * Records a provider's title as the generated title (source `provider`),
 * normalised as a message's is. Unchanged while the user has set a title,
 * when it is the generated title already, or when nothing of it is left
 * once normalised. A session deleted or not there is not found.
 */
export const decideProviderTitle = (state: SessionState | null, command: ProviderTitle): Decision => {
  const session = present(state, command.sessionId);
  if ("rejected" in session) return session;
  const title = generatedTitle(command.title);
  if (session.userTitle !== null || title === null || title === session.generatedTitle) return unchanged;
  return { events: [titleGenerated({ title, source: "provider" })] };
};

/** Who records a provider's title: the adapter, for the run whose end set the read off. */
export interface ProviderTitleAttribution {
  readonly actor: string;
  /** The run's `run.ended`, whose commit set the read off. */
  readonly causationId?: string;
  /** The run's id. */
  readonly correlationId?: string;
}

/**
 * Records a provider's title in a transaction of its own, deciding on the
 * session as it is then (the user may have titled it, or deleted it, since
 * the run ended): appends what `decideProviderTitle` decides, and nothing
 * for a refusal.
 */
export const recordProviderTitle = (log: EventLog, command: ProviderTitle, attribution: ProviderTitleAttribution): void => {
  log.atomically((tx) => {
    const state = readSessionState({ all: (sql, ...params) => log.read(sql, ...params) }, command.sessionId);
    const decision = decideProviderTitle(state, command);
    if (decision.rejected !== undefined) return;
    appendDecided(log, sessionStream(command.sessionId), decision, { tx, ...attribution });
  });
};
