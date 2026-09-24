import { GROUP_STREAM_KIND, SESSION_STREAM_KIND } from "@agent-harness/contracts";
import type { EventInput, StreamRef } from "../event-log/event-log.js";

/** What the session and group handlers share: the streams they append to, and the one instant a command's events carry. */

/** A session's stream. */
export const sessionStream = (id: string): StreamRef => ({ kind: SESSION_STREAM_KIND, id });

/** A group's stream. */
export const groupStream = (id: string): StreamRef => ({ kind: GROUP_STREAM_KIND, id });

/**
 * Stamps every event with the command's one instant, so a time in a payload,
 * the event's `occurredAt` and the `updatedAt` it moves are the same.
 */
export const stamp = (events: readonly EventInput[], at: string): EventInput[] => events.map((event) => ({ ...event, occurredAt: at }));
