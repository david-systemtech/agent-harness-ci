import type { AppendOptions, EventEnvelope, EventInput, EventLog, StreamRef, Tx } from "../event-log/event-log.js";

/**
 * Companion events (session-state spec, "Events"): the events a command
 * appends only because its own event made them necessary, in the same
 * transaction. Settle unpins, clears the active key and wakes a snooze; a
 * pin unsettles and wakes. A decider marks them; the appender puts the
 * command's own events first and names the last of them as every
 * companion's causation, as `groups.delete` does for the ungroupings.
 */

/** An event a decider appends only because the command's own event made it necessary. */
export interface CompanionInput extends EventInput {
  readonly companion: true;
}

/** Marks `event` as a companion of the command's own event. */
export const companion = (event: EventInput): CompanionInput => ({ ...event, companion: true });

const isCompanion = (event: EventInput): boolean => (event as Partial<CompanionInput>).companion === true;

/** The event as the log takes it, without the marker. */
const plain = (event: EventInput): EventInput => ({
  type: event.type,
  payload: event.payload,
  ...(event.metadata !== undefined && { metadata: event.metadata }),
  ...(event.eventId !== undefined && { eventId: event.eventId }),
  ...(event.occurredAt !== undefined && { occurredAt: event.occurredAt }),
});

/**
 * Appends a decision's events to one stream, in the order decided, in the
 * transaction `attribution` names, with its actor and, when a command decided
 * them, the command's id: the command's own events, then its companions,
 * each companion naming the last own event as its causation. Companions
 * with no own event before them (a settle on a settled session that is
 * still pinned) have none. An own event after a companion is a decider's
 * mistake, and throws.
 */
export const appendDecided = (
  log: EventLog,
  stream: StreamRef,
  events: readonly EventInput[],
  attribution: AppendOptions & { readonly tx: Tx },
): readonly EventEnvelope[] => {
  const split = events.findIndex(isCompanion);
  const own = split === -1 ? events : events.slice(0, split);
  const companions = split === -1 ? [] : events.slice(split);
  if (companions.some((event) => !isCompanion(event))) {
    throw new Error(`A decision put a ${companions.find((event) => !isCompanion(event))?.type} event after a companion.`);
  }
  const appended = own.length > 0 ? log.append(stream, own.map(plain), attribution).events : [];
  if (companions.length === 0) return appended;
  const cause = appended.at(-1)?.eventId;
  const followed = log.append(stream, companions.map(plain), { ...attribution, ...(cause !== undefined && { causationId: cause }) }).events;
  return [...appended, ...followed];
};
