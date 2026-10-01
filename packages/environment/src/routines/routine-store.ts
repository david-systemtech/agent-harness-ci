import {
  ROUTINE_PRESETS,
  ROUTINE_STREAM_KIND,
  type Ceiling,
  type DeliveryTarget,
  type FiringEntry,
  type FiringOutcome,
  type LiveFiring,
  type RoutineCreatedPayload,
  type RoutineDefinition,
  type RoutineDelivery,
  type RoutineDeliveryAttemptedPayload,
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
  type RoutineTrigger,
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
 * `overlap`. The baseline (#526) is the pre-check of the latest firing that
 * ended with `baselineAdvanced`: its hash, when it ran, and its kept output,
 * which the next firing's diff reads.
 *
 * `handledThrough` (#527) is the latest due time handled: a firing's or a
 * skip's from the schedule or a catch-up raises it to its due time, never
 * lowers it; a run now's leaves it. It moves to the save time when the
 * routine is created, when a disabled routine is enabled (by `enable` or by
 * an edit of `enabled`), and when an edit changes its schedule or zone, so
 * no earlier due time is owed. Instants are ISO strings, which compare as
 * text.
 *
 * Each entry keeps the targets it delivers to (#525): a firing the ones its
 * `routine.firing-started` recorded, so an edit during it changes nothing
 * for it; a skip its routine's at its record, none once the routine is
 * deleted. Each `routine.delivery-attempted` joins its target's delivery on
 * the entry, which the history lists in the targets' order. A firing keeps
 * the silence marker and the maximum duration it finishes under (#524),
 * the presets for one recorded before they were, and its session with the
 * skills its runs load (#531), none for one recorded before them.
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
    failure_streak INTEGER NOT NULL DEFAULT 0,
    baseline TEXT,
    handled_through TEXT
  ) STRICT;
  CREATE UNIQUE INDEX routines_live_name ON routines (name_key) WHERE deleted_at IS NULL`,
  routine_entries: `CREATE TABLE routine_entries (
    id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    run_id TEXT,
    targets TEXT NOT NULL,
    silence_marker TEXT,
    max_duration_minutes INTEGER,
    session_id TEXT,
    skills TEXT,
    entry TEXT NOT NULL
  ) STRICT;
  CREATE INDEX routine_entries_by_routine ON routine_entries (routine_id, position);
  CREATE INDEX routine_entries_by_run ON routine_entries (run_id) WHERE run_id IS NOT NULL;
  CREATE INDEX routine_entries_by_session ON routine_entries (session_id) WHERE session_id IS NOT NULL`,
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
    `INSERT INTO routines (id, position, name_key, definition, saved_under_ceiling, saved_by, created_at, moved_from, handled_through)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    event.streamId,
    event.sequence,
    routineNameKey(payload.definition.name),
    json(payload.definition),
    payload.savedUnderCeiling,
    savedBy(event),
    event.occurredAt,
    jsonOrNull(payload.movedFrom),
    event.occurredAt,
  );
};

/** Whether a save from `before` to `after` owes nothing before it: the routine was enabled, or its schedule or zone changed. */
const owesNothingBefore = (before: RoutineDefinition, after: RoutineDefinition): boolean =>
  (!before.enabled && after.enabled) || json(before.schedule) !== json(after.schedule) || before.timezone !== after.timezone;

/** Moves the routine's `handledThrough` to the save time when the save from `before` to `after` owes nothing before it. */
const resetHandled = (db: ProjectionDb, event: EventEnvelope, before: RoutineDefinition, after: RoutineDefinition): void => {
  if (owesNothingBefore(before, after)) db.run("UPDATE routines SET handled_through = ? WHERE id = ?", event.occurredAt, event.streamId);
};

/** Raises the routine's `handledThrough` to an entry's due time when the schedule or a catch-up made the entry; a run now's handles none. */
const handled = (db: ProjectionDb, routineId: string, trigger: RoutineTrigger, dueAt: string): void => {
  if (trigger === "run-now") return;
  db.run("UPDATE routines SET handled_through = ? WHERE id = ? AND (handled_through IS NULL OR handled_through < ?)", dueAt, routineId, dueAt);
};

/** Some fields changed, the rest as they were: the fields read back from the log's JSON, where no field is undefined. */
const edited = (db: ProjectionDb, event: EventEnvelope, payload: RoutineEditedPayload): void => {
  const definition = definitionOf(db, event.streamId);
  if (definition === null) return;
  const after: RoutineDefinition = { ...definition, ...(payload.fields as Partial<RoutineDefinition>) };
  save(db, event, after, payload.savedUnderCeiling);
  resetHandled(db, event, definition, after);
  db.run("UPDATE routines SET edited_at = ? WHERE id = ?", event.occurredAt, event.streamId);
};

const enabled = (db: ProjectionDb, event: EventEnvelope, payload: RoutineEnabledPayload): void => {
  const definition = definitionOf(db, event.streamId);
  if (definition === null) return;
  const after: RoutineDefinition = { ...definition, enabled: true };
  save(db, event, after, payload.savedUnderCeiling);
  resetHandled(db, event, definition, after);
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
  // A firing recorded before #524 names neither, and one before #531 no skills.
  const { silenceMarker = null, maxDurationMinutes = null, skills = [] } = payload as Partial<RoutineFiringStartedPayload>;
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
  db.run(
    "INSERT INTO routine_entries (id, routine_id, position, run_id, targets, silence_marker, max_duration_minutes, session_id, skills, entry) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    firingId,
    event.streamId,
    event.sequence,
    runId,
    json(targets),
    silenceMarker,
    maxDurationMinutes,
    sessionId,
    json(skills),
    json(entry),
  );
  db.run("UPDATE routines SET live_firing = ? WHERE id = ?", firingId, event.streamId);
  handled(db, event.streamId, trigger, dueAt);
};

const firingEnded = (db: ProjectionDb, event: EventEnvelope, payload: RoutineFiringEndedPayload): void => {
  const row = db.get<{ entry: string }>("SELECT entry FROM routine_entries WHERE id = ? AND routine_id = ?", payload.firingId, event.streamId);
  if (row === undefined) return;
  const { firingId, outcome, reason, text, usage, durationMs, baselineAdvanced } = payload;
  const entry: FiringEntry = { ...(JSON.parse(row.entry) as FiringEntry), endedAt: event.occurredAt, outcome, reason, text, usage, durationMs, baselineAdvanced };
  db.run("UPDATE routine_entries SET entry = ? WHERE id = ?", json(entry), firingId);
  db.run("UPDATE routines SET live_firing = NULL WHERE id = ? AND live_firing = ?", event.streamId, firingId);
  const { preCheck } = entry;
  if (baselineAdvanced && preCheck !== null && preCheck.hash !== null) {
    const baseline: Baseline = { hash: preCheck.hash, at: preCheck.startedAt, output: preCheck.output };
    db.run("UPDATE routines SET baseline = ? WHERE id = ?", json(baseline), event.streamId);
  }
  settle(db, event.streamId, { kind: "firing", entryId: firingId, outcome, reason, at: event.occurredAt }, outcome);
};

/** A skip delivers to its routine's targets at its record: none once the routine is deleted. */
const skipped = (db: ProjectionDb, event: EventEnvelope, payload: RoutineSkippedPayload): void => {
  const { skipId, trigger, count, preCheck, dueAt, reason, cannotStart, detail } = payload;
  const entry: SkipEntry = { kind: "skip", id: skipId, trigger, count, preCheck, deliveries: [], dueAt, at: event.occurredAt, reason, cannotStart, detail };
  const routine = db.get<{ definition: string }>("SELECT definition FROM routines WHERE id = ? AND deleted_at IS NULL", event.streamId);
  const delivery = routine === undefined ? [] : (JSON.parse(routine.definition) as RoutineDefinition).delivery;
  db.run(
    "INSERT INTO routine_entries (id, routine_id, position, run_id, targets, entry) VALUES (?, ?, ?, NULL, ?, ?)",
    skipId,
    event.streamId,
    event.sequence,
    json(delivery),
    json(entry),
  );
  handled(db, event.streamId, trigger, dueAt);
  settle(db, event.streamId, { kind: "skip", entryId: skipId, reason, at: event.occurredAt }, reason);
};

/** Whether two targets are the same: a delivery is to a target, however often the routine names it. */
export const sameTarget = (a: DeliveryTarget, b: DeliveryTarget): boolean =>
  a.kind === b.kind && a.on === b.on && (a.kind !== "webhook" || (b.kind === "webhook" && a.target === b.target));

/** Where a delivery stands once an attempt came to `result`. */
const DELIVERY_RESULT: Readonly<Record<RoutineDeliveryAttemptedPayload["result"], RoutineDelivery["result"]>> = {
  delivered: "delivered",
  retrying: "pending",
  failed: "failed",
};

/** An attempt joins its target's delivery on the entry, which stands as the attempt came to; the deliveries stay in the targets' order. */
const deliveryAttempted = (db: ProjectionDb, event: EventEnvelope, payload: RoutineDeliveryAttemptedPayload): void => {
  const row = db.get<{ targets: string; entry: string }>("SELECT targets, entry FROM routine_entries WHERE id = ? AND routine_id = ?", payload.entryId, event.streamId);
  if (row === undefined) return;
  const entry = JSON.parse(row.entry) as RoutineEntry;
  const { target, attempt, result, status, error, retryAt } = payload;
  const made = { attempt, at: event.occurredAt, result, status, error, retryAt };
  const held = entry.deliveries.find((delivery) => sameTarget(delivery.target, target));
  const others = entry.deliveries.filter((delivery) => delivery !== held);
  const delivery: RoutineDelivery = { target, result: DELIVERY_RESULT[result], attempts: [...(held?.attempts ?? []), made] };
  const targets = JSON.parse(row.targets) as DeliveryTarget[];
  const place = (of: RoutineDelivery): number => targets.findIndex((named) => sameTarget(named, of.target));
  const deliveries = [...others, delivery].sort((a, b) => place(a) - place(b));
  db.run("UPDATE routine_entries SET entry = ? WHERE id = ?", json({ ...entry, deliveries }), payload.entryId);
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
      case "routine.delivery-attempted":
        return deliveryAttempted(db, event, event.payload as RoutineDeliveryAttemptedPayload);
    }
  },
};

/** A routine's baseline: the hash of the pre-check output it was advanced to, when that pre-check ran, and its kept output. */
export interface Baseline {
  readonly hash: string;
  readonly at: string;
  /** The output's kept part, scrubbed, its first 64 KiB; null when the pre-check kept none. */
  readonly output: string | null;
}

/** The routine's baseline; null until a firing with a pre-check has ended succeeded or silent. */
export const routineBaseline = (reader: Reader, routineId: string): Baseline | null =>
  parsed<Baseline>(reader.all<{ baseline: string | null }>("SELECT baseline FROM routines WHERE id = ?", routineId)[0]?.baseline ?? null);

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
  baseline: string | null;
  handled_through: string | null;
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
  r.last_outcome, r.failure_streak, r.baseline, r.handled_through, e.entry AS live_entry
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

/** The baseline as the state names it: its hash and when it ran. */
const baselineOf = (text: string | null): RoutineState["baseline"] => {
  const baseline = parsed<Baseline>(text);
  return baseline === null ? null : { hash: baseline.hash, at: baseline.at };
};

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
    baseline: baselineOf(row.baseline),
    handledThrough: row.handled_through,
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
  /** The marker its final text is read against (#524). */
  readonly silenceMarker: string;
  /** How long after its start its live run is interrupted (#524). */
  readonly maxDurationMinutes: number;
}

/** The live firing whose `column` is `value`; null when none is. */
const liveFiringWhere = (reader: Reader, column: "e.run_id" | "e.routine_id", value: string): LiveFiringRecord | null => {
  const [row] = reader.all<{ routine_id: string; entry: string; silence_marker: string | null; max_duration_minutes: number | null }>(
    `SELECT e.routine_id, e.entry, e.silence_marker, e.max_duration_minutes FROM routine_entries e JOIN routines r ON r.live_firing = e.id WHERE ${column} = ?`,
    value,
  );
  if (row === undefined) return null;
  return {
    routineId: row.routine_id,
    entry: JSON.parse(row.entry) as FiringEntry,
    silenceMarker: row.silence_marker ?? ROUTINE_PRESETS.silenceMarker,
    maxDurationMinutes: row.max_duration_minutes ?? ROUTINE_PRESETS.maxDurationMinutes,
  };
};

/** The live firing whose run `runId` is; null when no live firing's is. */
export const liveFiringOfRun = (reader: Reader, runId: string): LiveFiringRecord | null => liveFiringWhere(reader, "e.run_id", runId);

/** The routine's live firing; null when none is live. */
export const liveFiringOfRoutine = (reader: Reader, routineId: string): LiveFiringRecord | null => liveFiringWhere(reader, "e.routine_id", routineId);

/**
 * The skills the firing whose session `sessionId` is started with, which a
 * run the environment starts to continue it after a restart loads always-on
 * (#531); none when no firing made the session.
 */
export const firingSkillsOfSession = (reader: Reader, sessionId: string): readonly string[] => {
  const skills = reader.all<{ skills: string | null }>("SELECT skills FROM routine_entries WHERE session_id = ?", sessionId)[0]?.skills ?? null;
  return skills === null ? [] : (JSON.parse(skills) as string[]);
};

/** The ids of the routines with a live firing. */
export const routinesWithLiveFirings = (reader: Reader): string[] =>
  reader.all<{ id: string }>("SELECT id FROM routines WHERE live_firing IS NOT NULL").map((row) => row.id);

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

/** An ended entry as its delivery reads it: the entry, the targets it delivers to, and its routine's name now. */
export interface DeliverableEntry {
  /** The routine's name as the environment holds it now, deleted since or not. */
  readonly name: string;
  readonly entry: RoutineEntry;
  readonly targets: readonly DeliveryTarget[];
}

/** The routine's entry `entryId` with its targets and the routine's name; null when it has no such entry. */
export const deliverableEntry = (reader: Reader, routineId: string, entryId: string): DeliverableEntry | null => {
  const [row] = reader.all<{ definition: string; targets: string; entry: string }>(
    "SELECT r.definition, e.targets, e.entry FROM routine_entries e JOIN routines r ON r.id = e.routine_id WHERE e.id = ? AND e.routine_id = ?",
    entryId,
    routineId,
  );
  if (row === undefined) return null;
  return {
    name: (JSON.parse(row.definition) as RoutineDefinition).name,
    entry: JSON.parse(row.entry) as RoutineEntry,
    targets: JSON.parse(row.targets) as DeliveryTarget[],
  };
};
