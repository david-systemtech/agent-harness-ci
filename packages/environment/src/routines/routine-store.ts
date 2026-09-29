import {
  ROUTINE_STREAM_KIND,
  type Ceiling,
  type RoutineCreatedPayload,
  type RoutineDefinition,
  type RoutineDisabledPayload,
  type RoutineEditedPayload,
  type RoutineEnabledPayload,
  type RoutineMoveLink,
  type RoutineState,
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
 * The firing engine's records (skips, firings, deliveries) and what they
 * keep in the state (the baseline, `handledThrough`, the live firing, the
 * last outcome, the failure streak) are the tickets' that append them; until
 * then a routine's state holds none.
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
    deleted_at TEXT
  ) STRICT;
  CREATE UNIQUE INDEX routines_live_name ON routines (name_key) WHERE deleted_at IS NULL`,
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
}

/** A routine the environment holds: its definition as saved, and its state. */
export interface StoredRoutine {
  readonly definition: RoutineDefinition;
  readonly state: RoutineState;
}

const COLUMNS = "id, definition, saved_under_ceiling, saved_by, created_at, edited_at, moved_from, moved_to";

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
    liveFiring: null,
    lastOutcome: null,
    failureStreak: 0,
  },
});

/** The routines the environment holds, in the order they were made. */
export const listStoredRoutines = (reader: Reader): StoredRoutine[] =>
  reader.all<RoutineRow>(`SELECT ${COLUMNS} FROM routines WHERE deleted_at IS NULL ORDER BY position`).map(storedOf);

/** The routine `id` names while the environment holds it; null when it never did or it was deleted. */
export const liveRoutine = (reader: Reader, id: string): StoredRoutine | null => {
  const [row] = reader.all<RoutineRow>(`SELECT ${COLUMNS} FROM routines WHERE id = ? AND deleted_at IS NULL`, id);
  return row === undefined ? null : storedOf(row);
};

/** Whether a routine was ever made under `id`, deleted since or not. */
export const routineEver = (reader: Reader, id: string): boolean => reader.all("SELECT 1 AS found FROM routines WHERE id = ?", id).length > 0;

/** The live routine whose name is `name` ignoring case: its id and its name as saved; null when none is. */
export const routineNamed = (reader: Reader, name: string): { readonly id: string; readonly name: string } | null => {
  const [row] = reader.all<{ id: string; definition: string }>("SELECT id, definition FROM routines WHERE name_key = ? AND deleted_at IS NULL", routineNameKey(name));
  return row === undefined ? null : { id: row.id, name: (JSON.parse(row.definition) as RoutineDefinition).name };
};
