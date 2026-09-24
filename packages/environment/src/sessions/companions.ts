import type { AppendOptions, EventEnvelope, EventInput, EventLog, StreamRef, Tx } from "../event-log/event-log.js";

/**
 * Companion events (session-state spec, "Events"): the events a command
 * appends only because its own events made them necessary, in the same
 * transaction. Settle unpins, clears the active key and wakes a snooze; a
 * pin unsettles and wakes. A decision carries them apart from its own events
 * (`Decision.companions`); this appends both, the own events first, each
 * companion naming the last of them as its causation, as `groups.delete`
 * does for the ungroupings.
 */

/** What `appendDecided` appends: a decision's own events and its companions. */
export interface Decided {
  readonly events: readonly EventInput[];
  readonly companions?: readonly EventInput[];
}

/**
 * Appends a decision to one stream in the transaction `attribution` names,
 * with its actor and, when a command decided it, the command's id: the own
 * events, then the companions, each naming the last own event as its
 * causation. Companions with no own event before them (a settle on a settled
 * session still pinned) have none. A decision with neither appends nothing.
 */
export const appendDecided = (
  log: EventLog,
  stream: StreamRef,
  decision: Decided,
  attribution: AppendOptions & { readonly tx: Tx },
): readonly EventEnvelope[] => {
  const companions = decision.companions ?? [];
  const own = decision.events.length > 0 ? log.append(stream, decision.events, attribution).events : [];
  if (companions.length === 0) return own;
  const cause = own.at(-1)?.eventId;
  return [...own, ...log.append(stream, companions, { ...attribution, ...(cause !== undefined && { causationId: cause }) }).events];
};
