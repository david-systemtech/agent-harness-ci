import { SESSION_STREAM_KIND, type EventEnvelope, type SessionSnapshot } from "@agent-harness/contracts";
import { permissionSchemaFixtures } from "../../contracts/test/permission-fixtures.js";
import { runSchemaFixtures } from "../../contracts/test/run-fixtures.js";

/**
 * The recorded fixtures of #119 (the transcript vocabulary) and #130 (the
 * prompts) and #131 (`tool.decision`), as events on one session's stream,
 * for the session reducer's suite: each payload is a valid instance the
 * contracts' own schema tests hold to its schema, so the reducer folds what
 * an environment records.
 */

/** The session the fixtures are about, the run they belong to and the two messages they name. */
export const FIXTURE_SESSION = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
export const FIXTURE_RUN = "3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b";
export const FIXTURE_MESSAGE = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
export const FIXTURE_OTHER_MESSAGE = "2c4e6a8b-1d3f-4b5a-9c7e-0a2b4c6d8e0f";

/** The instant the event at `sequence` occurred: a second apart, from the manual clock's start. */
export const occurredAt = (sequence: number): string => new Date(Date.parse("2026-09-24T00:00:00.000Z") + sequence * 1000).toISOString();

/** The `index`th valid payload the contracts record for `type`, a fresh copy, with `changes` over it. */
export const recorded = (type: string, index = 0, changes: Record<string, unknown> = {}): Record<string, unknown> => {
  const fixtures = runSchemaFixtures[`sessions/events/${type}.json`] ?? permissionSchemaFixtures[`sessions/events/${type}.json`];
  const payload = fixtures?.valid[index];
  if (payload === undefined) throw new Error(`No recorded ${type} payload at ${index}.`);
  return { ...(structuredClone(payload) as Record<string, unknown>), ...changes };
};

/** The recorded snapshot: two runs, one item of every kind (an opaque one and one of a kind no client knows among them) and a parked prompt. */
export const recordedSnapshot = (): SessionSnapshot => structuredClone(runSchemaFixtures["transcript/session-snapshot.json"]?.valid[0]) as SessionSnapshot;

/** An event of `type` at `sequence` on the fixtures' session stream, carrying `payload` and, when given, the list patch in its metadata. */
export const sessionStreamEvent = (sequence: number, type: string, payload: Record<string, unknown>, metadata: Record<string, unknown> = {}): EventEnvelope => ({
  sequence,
  eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
  streamKind: SESSION_STREAM_KIND,
  streamId: FIXTURE_SESSION,
  streamVersion: sequence,
  type,
  occurredAt: occurredAt(sequence),
  commandId: null,
  causationId: null,
  correlationId: FIXTURE_RUN,
  actor: { kind: "adapter", id: "fake" },
  payload,
  metadata,
});

/** A stream of events numbered from `first`, one per `[type, payload]`. */
export const numbered = (first: number, entries: readonly (readonly [string, Record<string, unknown>])[]): EventEnvelope[] =>
  entries.map(([type, payload], index) => sessionStreamEvent(first + index, type, payload));
