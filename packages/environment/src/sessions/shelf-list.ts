import type { SessionSettledPayload, SessionSnoozedPayload, SessionUnsettledPayload } from "@agent-harness/contracts";
import type { EventEnvelope, ProjectionDb, SqlValue } from "../event-log/event-log.js";
import type { SessionRow } from "./session-tables.js";

/**
 * How the shelf's events change the session-list tables (session-state
 * spec, "Events"), for the session-list projector (`session-list.ts`),
 * which attaches each one's patch. Every one is an organisation change, so
 * moves `updatedAt`, whoever appended it: a command, or the sweep.
 */

/** Sets columns of the event's session; `organise` also moves its `updatedAt` to the event's time. */
export type ColumnWriter = (event: EventEnvelope, db: ProjectionDb, columns: Readonly<Record<string, SqlValue>>) => void;

/** How one event type changes the tables. */
export type Projection = (event: EventEnvelope, db: ProjectionDb) => void;

/** The projections of the four shelf events, writing through the projector's `organise`. */
export const shelfProjections = (organise: ColumnWriter): Readonly<Record<string, Projection>> => ({
  // Settled by the user or by auto-settle, the session is held settled; `settledBy` says who.
  "session.settled": (event, db) => {
    const { settledAt, by } = event.payload as SessionSettledPayload;
    organise(event, db, { settled_at: settledAt, settled_by: by, settled_override: "settled" });
  },
  // A user's unsettle holds the session active against auto-settle; activity's clears the override.
  "session.unsettled": (event, db) => {
    const { unsettledAt, reason } = event.payload as SessionUnsettledPayload;
    organise(event, db, { settled_at: null, settled_by: null, unsettled_at: unsettledAt, settled_override: reason === "user" ? "active" : null });
  },
  "session.snoozed": (event, db) => {
    const { snoozedUntil, snoozedAt } = event.payload as SessionSnoozedPayload;
    organise(event, db, { snoozed_until: snoozedUntil, snoozed_at: snoozedAt });
  },
  // The snooze ends at its time when it expired, else when it was woken: auto-settle counts a full span from then.
  "session.unsnoozed": (event, db) => {
    const [row] = db.all<Pick<SessionRow, "snoozed_until">>("SELECT snoozed_until FROM sessions WHERE id = ?", event.streamId);
    const until = row?.snoozed_until ?? null;
    const ended = until !== null && Date.parse(until) < Date.parse(event.occurredAt) ? until : event.occurredAt;
    organise(event, db, { snoozed_until: null, snoozed_at: null, snooze_ended_at: ended });
  },
});
