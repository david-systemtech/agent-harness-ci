import { SESSION_STREAM_KIND, type SessionInstructionsSetPayload } from "@agent-harness/contracts";
import type { EventEnvelope, EventInput, EventLog, ProjectionDb } from "../event-log/event-log.js";
import type { MethodHandlers } from "../serve/methods.js";
import { sessionNotFound } from "../sessions/decider.js";
import { readSessionState } from "../sessions/session-reads.js";
import type { Reader } from "../sessions/session-tables.js";
import { sessionStream } from "../sessions/streams.js";
import type { LayerSeam } from "./composer.js";

/**
 * A session's own instructions (skills spec, "Session instructions"; ADR
 * 0009; #506): one text per session, so a one-off constraint does not become
 * a habit. `sessions.setInstructions` (`runs:drive`) records it as
 * `session.instructions-set` on the session's stream, empty text clearing
 * it; the read model below keeps each session's latest in the transaction of
 * the event, rebuilt from the log, its row gone with the session's purge.
 * It fills the composer's session layer under `# Instructions for this
 * session`, read as each run launches, so a live run keeps what it began
 * with and the text, which a Claude process fixes at spawn, reaches the next
 * run on a fresh process. The per-session snapshot carries it
 * (`sessions/methods.ts`) and a fork copies it (`sessions/fork-rewind.ts`).
 * Transcript compaction keeps `session.instructions-set`, as every
 * `session.*` event (`sessions/compaction.ts`).
 */

export const SESSION_INSTRUCTIONS_TABLES = {
  session_instructions: `CREATE TABLE session_instructions (
    session_id TEXT PRIMARY KEY,
    text TEXT NOT NULL
  ) STRICT`,
} as const;

/** The session's instructions heading in the composed text, over the session's text. */
const HEADING = "# Instructions for this session";

/** The session layer's part title, as `instructions.preview` shows it. */
const TITLE = "Instructions for this session";

/** Keeps each session's latest instructions: a row while it has some, none once they are cleared or the session is purged. */
export const projectSessionInstructions = (event: EventEnvelope, db: ProjectionDb): void => {
  if (event.streamKind !== SESSION_STREAM_KIND) return;
  if (event.type === "session.instructions-set") {
    const { text } = event.payload as SessionInstructionsSetPayload;
    if (text === "") db.run("DELETE FROM session_instructions WHERE session_id = ?", event.streamId);
    else db.run("INSERT INTO session_instructions (session_id, text) VALUES (?, ?) ON CONFLICT (session_id) DO UPDATE SET text = excluded.text", event.streamId, text);
  } else if (event.type === "session.purged") {
    db.run("DELETE FROM session_instructions WHERE session_id = ?", event.streamId);
  }
};

/** The session's own instructions: empty when it has none. */
export const readSessionInstructions = (reader: Reader, sessionId: string): string =>
  reader.all<{ text: string }>("SELECT text FROM session_instructions WHERE session_id = ?", sessionId)[0]?.text ?? "";

/**
 * What a fork is made with beside its creation (`sessions.fork`, in the
 * fork's append): its source's instructions, when it has some.
 */
export const forkedInstructions = (reader: Reader, sourceId: string): EventInput[] => {
  const text = readSessionInstructions(reader, sourceId);
  return text === "" ? [] : [{ type: "session.instructions-set", payload: { text } satisfies SessionInstructionsSetPayload }];
};

/**
 * The composer's session-layer seam: the run's session's instructions as one
 * part, named by the session, under their heading; none for a session with
 * none, blank ones included, and for a run with no session (a preview of a
 * new session's first run).
 */
export const sessionInstructionsLayer =
  (reader: Reader): LayerSeam =>
  ({ sessionId }) => {
    if (sessionId === null) return [];
    const text = readSessionInstructions(reader, sessionId);
    return text.trim() === "" ? [] : [{ id: sessionId, version: null, title: TITLE, text: `${HEADING}\n\n${text}` }];
  };

/**
 * `sessions.setInstructions`: a session not on the environment, or deleted,
 * is `not_found`; the text it has already appends nothing.
 */
export const sessionInstructionsMethods = (log: EventLog): MethodHandlers => {
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  return {
    "sessions.setInstructions": ({ sessionId, text }) => {
      const id = sessionId.toLowerCase();
      const aggregate = sessionStream(id);
      const state = readSessionState(reader, id);
      if (state === null || state.deleted) return { aggregate, rejected: sessionNotFound(id) };
      const payload: SessionInstructionsSetPayload = { text };
      const events = readSessionInstructions(reader, id) === text ? [] : [{ type: "session.instructions-set", payload }];
      return { aggregate, result: { sessionId: id, ...payload }, events };
    },
  };
};
