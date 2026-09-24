import type { MessageSentPayload, SessionUnsettledPayload, SessionUnsnoozedPayload } from "@agent-harness/contracts";
import type { AppendOptions, EventEnvelope, EventInput, EventLog, Tx } from "../event-log/event-log.js";
import type { SessionState } from "./decider.js";
import { readSessionState, type Reader } from "./session-reads.js";
import { sessionStream, stamp } from "./streams.js";
import { decidePromptTitle } from "./titles.js";

/**
 * The activity companions (session-state spec, "Events"): the only way run
 * events touch a session's organisation fields. A run starting on an
 * archived, settled or snoozed session unarchives it, unsettles it (reason
 * `activity`) and wakes it (reason `activity`); a run ending, however it
 * ends, wakes a snoozed one. Each is appended in the transaction of the run
 * event, after the events appended with it, naming the run event as its
 * causation and carrying its command id (when a command started the run),
 * its actor and its instant. The first user message's generated title
 * (`titles.ts`) rides the same path, naming its `message.sent`.
 *
 * Activity also clears a user's `active` override (set by
 * `sessions.unsettle`, which holds a session against auto-settle until its
 * next activity): a run's start on a session held active and not settled
 * appends `session.unsettled` with reason `activity` too, whose projection
 * clears the override to null and stamps `unsettledAt` at the run's start,
 * the same instant as its `lastActivityAt`, so the auto-settle anchor and
 * the active list's order do not move for it.
 *
 * Every path that appends `run.started` or `run.ended` appends through
 * `appendRunEvents`: the run methods' `runs.start` and `runs.send` in the
 * command's transaction, and the adapter host's run of the environment's
 * queue, its adopted provider turns and every end it records.
 */

/** The companions a run event owes the session in `state` at `at`, the run event's instant; none for any other event. */
export const activityCompanions = (state: SessionState | null, type: string, at: string): EventInput[] => {
  if (state === null || state.deleted) return [];
  const woken: SessionUnsnoozedPayload = { reason: "activity" };
  const wake: EventInput[] = state.snoozedUntil !== null ? [{ type: "session.unsnoozed", payload: woken }] : [];
  if (type === "run.ended") return wake;
  if (type !== "run.started") return [];
  const unsettled: SessionUnsettledPayload = { unsettledAt: at, reason: "activity" };
  return [
    ...(state.archivedAt !== null ? [{ type: "session.unarchived", payload: {} }] : []),
    ...(state.settledAt !== null || state.settledOverride === "active" ? [{ type: "session.unsettled", payload: unsettled }] : []),
    ...wake,
  ];
};

/** What one appended event owes the session as it stands: a run event its activity companions, a user message its generated title. */
const companionsOf = (event: EventEnvelope, state: SessionState | null): EventInput[] => {
  if (event.type === "message.sent") return decidePromptTitle(state, (event.payload as MessageSentPayload).text);
  return activityCompanions(state, event.type, event.occurredAt);
};

/**
 * Appends events to a session's stream in the transaction `attribution`
 * names, then, for each of them in order, the companions it owes, reading
 * the session as the events before it left it: each companion carries the
 * event's instant and the append's command id, actor and correlation, and
 * names the event as its causation. Returns every event appended, in order.
 */
export const appendRunEvents = (
  log: EventLog,
  sessionId: string,
  events: readonly EventInput[],
  attribution: AppendOptions & { readonly tx: Tx },
): readonly EventEnvelope[] => {
  if (events.length === 0) return [];
  const stream = sessionStream(sessionId);
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  const appended = [...log.append(stream, events, attribution).events];
  for (const event of [...appended]) {
    const companions = companionsOf(event, readSessionState(reader, sessionId));
    if (companions.length === 0) continue;
    appended.push(...log.append(stream, stamp(companions, event.occurredAt), { ...attribution, causationId: event.eventId }).events);
  }
  return appended;
};
