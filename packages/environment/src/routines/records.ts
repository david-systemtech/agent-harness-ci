import { ENVIRONMENT_STREAM_KIND, ROUTINE_STREAM_KIND, type RoutineChange, type RoutineUpdatedPayload } from "@agent-harness/contracts";
import { formatActor, type AppendOptions, type EventEnvelope, type EventInput, type EventLog, type StreamRef, type Tx } from "../event-log/event-log.js";

/**
 * A routine's records on its own stream (routines spec, "Events and
 * notices"): each appended with the `routine.updated` notice its commit
 * raises on the environment's stream, so the client runtime refreshes
 * `routines.list`. The commands' records are the client session's; the
 * firing engine's are the routine's own actor's, `routine:<id>`.
 */

/** A routine's stream. */
export const routineStream = (id: string): StreamRef => ({ kind: ROUTINE_STREAM_KIND, id });

/** The actor the firing engine's records, and a firing's session and run, are appended as. */
export const routineActor = (id: string): string => formatActor({ kind: "routine", id });

/**
 * Appends `event` to the routine's stream in the open transaction, then the
 * `routine.updated` notice naming `change` to the environment's, caused by
 * it, at the same instant; answers the record as appended.
 */
export const appendRoutineRecord = (
  log: EventLog,
  environmentId: string,
  routineId: string,
  record: { readonly event: EventInput; readonly change: RoutineChange },
  attribution: AppendOptions & { readonly tx: Tx },
): EventEnvelope => {
  const [appended] = log.append(routineStream(routineId), [record.event], attribution).events;
  if (appended === undefined) throw new Error(`The ${record.event.type} of the routine ${routineId} appended no event.`);
  const notice: RoutineUpdatedPayload = { routineId, change: record.change };
  log.append({ kind: ENVIRONMENT_STREAM_KIND, id: environmentId }, [{ type: "routine.updated", payload: notice, occurredAt: appended.occurredAt }], {
    ...attribution,
    causationId: appended.eventId,
  });
  return appended;
};
