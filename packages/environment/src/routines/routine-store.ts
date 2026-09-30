import {
  ROUTINE_STREAM_KIND,
  type Ceiling,
  type FiringEntry,
  type FiringOutcome,
  type LiveFiring,
  type RoutineCreatedPayload,
  type RoutineDefinition,
  type RoutineDisabledPayload,
  type RoutineEditedPayload,
  type RoutineEnabledPayload,
  type RoutineEntry,
  type RoutineFiringEndedPayload,
  type RoutineFiringStartedPayload,
  type RoutineLastOutcome,
  type RoutineMoveLink,
  type RoutineSkippedPayload,
  type RoutineState,
  type SkipEntry,
  type SkipReason,
} from "@agent-harness/contracts";
import { parseActor, type EventEnvelope, type ProjectionDb, type Projector } from "../event-log/event-log.js";
import type { Reader } from "../sessions/session-tables.js";

/**
 * The routine store (routines spec, "The routine" and "Events and notices";
 * ADR 0008): a projector over the `routine` streams, one per routine, kept
 * in the transaction that appends each event and rebuilt from the log. One
 * row per routine ever made: its definition as saved, what it was saved
 * under and by whom, its move links, and, for a deleted one, when, so a
 * deleted routine's id is never taken again. The partial unique index holds
 * one live routine per name ignoring case, which the routine commands check
 * before they append. The streams are not compacted (milestone 1): only a
 * session's transcript is.
 *
 * The firing engine's records (#523) are kept beside it: each firing and
 * skip as the history answers it, in `routine_entries`, a firing's run id
 * beside it so its end finds it, and on the routine's row its live firing,
 * its last outcome (the latest entry to end) and its failure streak:
 * consecutive failed firings and failing skips, reset by `succeeded`,
 * `silent` and `no-change`, and left as it was by `cancelled`, `missed` and
 * `overlap`. The baseline and `handledThrough` are the tickets' that keep
 * them (#526, #527), and a firing's deliveries #525's; until then they are
 * null and none.
 */

export const ROUTINES_PROJECTOR = "routines";

export const ROUTINES_TABLES = {
  routines: `CREATE TABLE routines (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    name_key TEXT NOT NULL,
    definition TEXT NOT NULL,
    saved_under_ceiling TEXT NOT NULL,
    saved_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    edited_at TEXT,
    moved_from TEXT,
    moved_to TEXT,
    deleted_at TEXT,
    live_firing TEXT,
    last_outcome TEXT,
    failure_streak INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  CREATE UNIQUE INDEX routines_live_name ON routines (name_key) WHERE deleted_at IS NULL`,
  routine_entries: `CREATE TABLE routine_entries (
    id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    run_id TEXT,
    entry TEXT NOT NULL
  ) STRICT;
  CREATE INDEX routine_entries_by_routine ON routine_entries (routine_id, position);
  CREATE INDEX routine_entries_by_run ON routine_entries (run_id) WHERE run_id IS NOT NULL`,
} as const;

/** A routine's name as the one-name-per-environment rule compares it: trimmed, case folded. */
export const routineNameKey = (name: string): string => name.trim().toLowerCase();

const json = (value: unknown): string => JSON.stringify(value);
const jsonOrNull = (value: unknown): string | null => (value === null ? null : JSON.stringify(value));
const parsed = <T>(text: string | null): T | null => (text === null ? null : (JSON.parse(text) as T));

/** The client session behind a command's event: its actor's id. */
const savedBy = (event: EventEnvelope): string => parseActor(event.actor).id;

const definitionOf = (db: ProjectionDb, routineId: string): RoutineDefinition | null => {
  const row = db.get<{ definition: string }>("SELECT definition FROM routines WHERE id = ?", routineId);
  return row === undefined ? null : (JSON.parse(row.definition) as RoutineDefinition);
};

/** Writes the routine's definition, and the name key beside it, and records who saved it under what ceiling, when it was saved. */
const save = (db: ProjectionDb, event: EventEnvelope, definition: RoutineDefinition, ceiling: Ceiling | null): void => {
  db.run("UPDATE routines SET definition = ?, name_key = ? WHERE id = ?", json(definition), routineNameKey(definition.name), event.streamId);
  if (ceiling !== null) db.run("UPDATE routines SET saved_under_ceiling = ?, saved_by = ? WHERE id = ?", ceiling, savedBy(event), event.streamId);
};

const created = (db: ProjectionDb, event: EventEnvelope, payload: RoutineCreatedPayload): void => {
  db.run(
    `INSERT INTO routines (id, position, name_key, definition, saved_under_ceiling, saved_by, created_at, moved_from)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    event.streamId,
    event.sequence,
    routineNameKey(payload.definition.name),
    json(payload.definition),
    payload.savedUnderCeiling,
    savedBy(event),
    event.occurredAt,
    jsonOrNull(payload.movedFrom),
  );
};

/** Some fields changed, the rest as they were: the fields read back from the log's JSON, where no field is undefined. */
const edited = (db: ProjectionDb, event: EventEnvelope, payload: RoutineEditedPayload): void => {
  const definition = definitionOf(db, event.streamId);
  if (definition === null) return;
  save(db, event, { ...definition, ...(payload.fields as Partial<RoutineDefinition>) }, payload.savedUnderCeiling);
  db.run("UPDATE routines SET edited_at = ? WHERE id = ?", event.occurredAt, event.streamId);
};

const enabled = (db: ProjectionDb, event: EventEnvelope, payload: RoutineEnabledPayload): void => {
  const definition = definitionOf(db, event.streamId);
  if (definition === null) return;
  save(db, event, { ...definition, enabled: true }, payload.savedUnderCeiling);
  db.run("UPDATE routines SET moved_to = NULL WHERE id = ?", event.streamId);
};

/** Disabled, with the copy a move made when one did; a disable that names none keeps the link a move left. */
const disabled = (db: ProjectionDb, event: EventEnvelope, payload: RoutineDisabledPayload): void => {
  const definition = definitionOf(db, event.streamId);
  if (definition === null) return;
  save(db, event, { ...definition, enabled: false }, null);
  if (payload.movedTo !== null) db.run("UPDATE routines SET moved_to = ? WHERE id = ?", json(payload.movedTo), event.streamId);
};

/** How an ended entry moves the failure streak: a failure adds one, a success resets it, and the rest leave it. */
const STREAK: Readonly<Record<FiringOutcome | SkipReason, "fails" | "resets" | "keeps">> = {
  succeeded: "resets",
  silent: "resets",
  failed: "fails",
  cancelled: "keeps",
  "no-change": "resets",
  "pre-check-failed": "fails",
  "cannot-start": "fails",
  missed: "keeps",
  overlap: "keeps",
};

/** Records how the routine's latest entry to end ended, and moves its streak by it. */
const settle = (db: ProjectionDb, routineId: string, outcome: RoutineLastOutcome, how: FiringOutcome | SkipReason): void => {
  const streak = STREAK[how];
  const next = streak === "fails" ? "failure_streak + 1" : streak === "resets" ? "0" : "failure_streak";
  db.run(`UPDATE routines SET last_outcome = ?, failure_streak = ${next} WHERE id = ?`, json(outcome), routineId);
};

const firingStarted = (db: ProjectionDb, event: EventEnvelope, payload: RoutineFiringStartedPayload): void => {
  const { firingId, trigger, count, preCheck, dueAt, sessionId, runId, requestedBy, targets } = payload;
  const entry: FiringEntry = {
    kind: "firing",
    id: firingId,
    trigger,
    count,
    preCheck,
    deliveries: [],
    dueAt,
    startedAt: event.occurredAt,
    endedAt: null,
    sessionId,
    runId,
    requestedBy,
    targets,
    outcome: null,
    reason: null,
    text: null,
    usage: null,
    durationMs: null,
    baselineAdvanced: null,
  };
  db.run("INSERT INTO routine_entries (id, routine_id, position, run_id, entry) VALUES (?, ?, ?, ?, ?)", firingId, event.streamId, event.sequence, runId, json(entry));
  db.run("UPDATE routines SET live_firing = ? WHERE id = ?", firingId, event.streamId);
};

const firingEnded = (db: ProjectionDb, event: EventEnvelope, payload: RoutineFiringEndedPayload): void => {
  const row = db.get<{ entry: string }>("SELECT entry FROM routine_entries WHERE id = ? AND routine_id = ?", payload.firingId, event.streamId);
  if (row === undefined) return;
  const { firingId, outcome, reason, text, usage, durationMs, baselineAdvanced } = payload;
  const entry: FiringEntry = { ...(JSON.parse(row.entry) as FiringEntry), endedAt: event.occurredAt, outcome, reason, text, usage, durationMs, baselineAdvanced };
  db.run("UPDATE routine_entries SET entry = ? WHERE id = ?", json(entry), firingId);
  db.run("UPDATE routines SET live_firing = NULL WHERE id = ? AND live_firing = ?", event.streamId, firingId);
  settle(db, event.streamId, { kind: "firing", entryId: firingId, outcome, reason, at: event.occurredAt }, outcome);
};

const skipped = (db: ProjectionDb, event: EventEnvelope, payload: RoutineSkippedPayload): void => {
  const { skipId, trigger, count, preCheck, dueAt, reason, cannotStart, detail } = payload;
  const entry: SkipEntry = { kind: "skip", id: skipId, trigger, count, preCheck, deliveries: [], dueAt, at: event.occurredAt, reason, cannotStart, detail };
  db.run("INSERT INTO routine_entries (id, routine_id, position, run_id, entry) VALUES (?, ?, ?, NULL, ?)", skipId, event.streamId, event.sequence, json(entry));
  settle(db, event.streamId, { kind: "skip", entryId: skipId, reason, at: event.occurredAt }, reason);
};

export const routinesProjector: Projector = {
  name: ROUTINES_PROJECTOR,
  tables: ROUTINES_TABLES,
  apply(event, db) {
    if (event.streamKind !== ROUTINE_STREAM_KIND) return;
    switch (event.type) {
      case "routine.created":
        return created(db, event, event.payload as RoutineCreatedPayload);
      case "routine.edited":
        return edited(db, event, event.payload as RoutineEditedPayload);
      case "routine.enabled":
        return enabled(db, event, event.payload as RoutineEnabledPayload);
      case "routine.disabled":
        return disabled(db, event, event.payload as RoutineDisabledPayload);
      case "routine.deleted":
        return void db.run("UPDATE routines SET deleted_at = ? WHERE id = ?", event.occurredAt, event.streamId);
      case "routine.firing-started":
        return firingStarted(db, event, event.payload as RoutineFiringStartedPayload);
      case "routine.firing-ended":
        return firingEnded(db, event, event.payload as RoutineFiringEndedPayload);
      case "routine.skipped":
        return skipped(db, event, event.payload as RoutineSkippedPayload);
    }
  },
};

/** One `routines` row as SQLite returns it. */
interface RoutineRow {
  id: string;
  definition: string;
  saved_under_ceiling: Ceiling;
  saved_by: string;
  created_at: string;
  edited_at: string | null;
  moved_from: string | null;
  moved_to: string | null;
  last_outcome: string | null;
  failure_streak: number;
  /** The live firing's entry, joined from `routine_entries`. */
  live_entry: string | null;
}

/** A routine the environment holds: its definition as saved, and its state. */
export interface StoredRoutine {
  readonly definition: RoutineDefinition;
  readonly state: RoutineState;
}

/** A routine's row with its live firing's entry beside it. */
const SELECT_ROUTINES = `SELECT r.id, r.definition, r.saved_under_ceiling, r.saved_by, r.created_at, r.edited_at, r.moved_from, r.moved_to,
  r.last_outcome, r.failure_streak, e.entry AS live_entry
  FROM routines r LEFT JOIN routine_entries e ON e.id = r.live_firing`;

/** A live firing as the state names it, from its entry. */
const liveFiringOf = (entry: FiringEntry): LiveFiring => ({
  firingId: entry.id,
  trigger: entry.trigger,
  dueAt: entry.dueAt,
  startedAt: entry.startedAt,
  sessionId: entry.sessionId,
  runId: entry.runId,
});

const storedOf = (row: RoutineRow): StoredRoutine => ({
  definition: JSON.parse(row.definition) as RoutineDefinition,
  state: {
    id: row.id,
    savedUnderCeiling: row.saved_under_ceiling,
    savedBy: row.saved_by,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    movedFrom: parsed<RoutineMoveLink>(row.moved_from),
    movedTo: parsed<RoutineMoveLink>(row.moved_to),
    baseline: null,
    handledThrough: null,
    liveFiring: row.live_entry === null ? null : liveFiringOf(JSON.parse(row.live_entry) as FiringEntry),
    lastOutcome: parsed<RoutineLastOutcome>(row.last_outcome),
    failureStreak: row.failure_streak,
  },
});

/** The routines the environment holds, in the order they were made. */
export const listStoredRoutines = (reader: Reader): StoredRoutine[] =>
  reader.all<RoutineRow>(`${SELECT_ROUTINES} WHERE r.deleted_at IS NULL ORDER BY r.position`).map(storedOf);

/** The routine `id` names while the environment holds it; null when it never did or it was deleted. */
export const liveRoutine = (reader: Reader, id: string): StoredRoutine | null => {
  const [row] = reader.all<RoutineRow>(`${SELECT_ROUTINES} WHERE r.id = ? AND r.deleted_at IS NULL`, id);
  return row === undefined ? null : storedOf(row);
};

/** Whether a routine was ever made under `id`, deleted since or not. */
export const routineEver = (reader: Reader, id: string): boolean => reader.all("SELECT 1 AS found FROM routines WHERE id = ?", id).length > 0;

/** The live routine whose name is `name` ignoring case: its id and its name as saved; null when none is. */
export const routineNamed = (reader: Reader, name: string): { readonly id: string; readonly name: string } | null => {
  const [row] = reader.all<{ id: string; definition: string }>("SELECT id, definition FROM routines WHERE name_key = ? AND deleted_at IS NULL", routineNameKey(name));
  return row === undefined ? null : { id: row.id, name: (JSON.parse(row.definition) as RoutineDefinition).name };
};

/** A firing that has started and not ended, with its routine: what its run's end, or its routine's deletion, ends. */
export interface LiveFiringRecord {
  readonly routineId: string;
  readonly entry: FiringEntry;
}

const liveFirings = (reader: Reader, where: string, param: string): LiveFiringRecord | null => {
  const [row] = reader.all<{ routine_id: string; entry: string }>(
    `SELECT e.routine_id, e.entry FROM routine_entries e JOIN routines r ON r.live_firing = e.id WHERE ${where} = ?`,
    param,
  );
  return row === undefined ? null : { routineId: row.routine_id, entry: JSON.parse(row.entry) as FiringEntry };
};

/** The live firing whose run `runId` is; null when no live firing's is. */
export const liveFiringOfRun = (reader: Reader, runId: string): LiveFiringRecord | null => liveFirings(reader, "e.run_id", runId);

/** The routine's live firing; null when none is live. */
export const liveFiringOfRoutine = (reader: Reader, routineId: string): LiveFiringRecord | null => liveFirings(reader, "e.routine_id", routineId);

/** Where the routine's entry `entryId` stands in its history; null when it has no such entry. */
export const entryPosition = (reader: Reader, routineId: string, entryId: string): number | null =>
  reader.all<{ position: number }>("SELECT position FROM routine_entries WHERE id = ? AND routine_id = ?", entryId, routineId)[0]?.position ?? null;

/** The routine's entries recorded before `before` (every one when null), newest first, at most `limit`. */
export const routineEntries = (reader: Reader, routineId: string, before: number | null, limit: number): RoutineEntry[] =>
  reader
    .all<{ entry: string }>(
      "SELECT entry FROM routine_entries WHERE routine_id = ? AND position < ? ORDER BY position DESC LIMIT ?",
      routineId,
      before ?? Number.MAX_SAFE_INTEGER,
      limit,
    )
    .map((row) => JSON.parse(row.entry) as RoutineEntry);
