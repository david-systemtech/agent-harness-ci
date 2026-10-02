import { SESSION_STREAM_KIND, SETTINGS_STREAM_KIND, type ReviewUpdatedPayload } from "@agent-harness/contracts";
import type { EventEnvelope, EventLog, StreamRef } from "../event-log/event-log.js";
import type { Reader } from "../sessions/session-reads.js";
import { PERMISSIONS_ACTOR } from "./actor.js";
import { holdsListedRuns, isListed } from "./review-store.js";

/**
 * The Unattended review's notice (#811; permissions spec, "Events"):
 * `review.updated` on the environment's stream, which `environment.subscribe`
 * delivers to every connected client, once an event that changes what
 * `permissions.review.list` answers has committed, as the log's subscriber,
 * caused by it. Those events are on streams a client does not follow whole,
 * so without it a client's cached list would wait for the cache's five
 * minutes:
 *
 * - a `tool.decision` in a run the review then lists: every decision of an
 *   unattended run that called a tool or had a denial, and of an attended
 *   run the TTL, the denylist or containment decided in, since each changes
 *   that run's counts or brings it back past the watermark;
 * - a `review.seen`, which is appended only when the watermark moves;
 * - a session's deletion or restore while it holds a run the review lists
 *   but for the deletion.
 *
 * One notice per such event, carrying nothing: a client reads the list
 * again, and its request cache has one fetch under way at a time.
 */

export interface ReviewNoticesOptions {
  readonly log: EventLog;
  /** The environment's own stream, which `environment.subscribe` reads. */
  readonly stream: StreamRef;
}

const UPDATED: { readonly type: "review.updated"; readonly payload: ReviewUpdatedPayload } = { type: "review.updated", payload: {} };

/** Starts raising the notice; the answer stops it. */
export const startReviewNotices = ({ log, stream }: ReviewNoticesOptions): (() => void) => {
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  /** Whether `event`, committed, changed what the review lists. */
  const changesReview = (event: EventEnvelope): boolean => {
    if (event.streamKind === SETTINGS_STREAM_KIND) return event.type === "review.seen";
    if (event.streamKind !== SESSION_STREAM_KIND) return false;
    switch (event.type) {
      case "tool.decision": {
        const runId = event.payload["runId"];
        return typeof runId === "string" && isListed(reader, runId);
      }
      case "session.deleted":
      case "session.restored":
        return holdsListedRuns(reader, event.streamId);
      default:
        return false;
    }
  };

  return log.subscribe((event) => {
    try {
      if (!changesReview(event)) return;
      log.append(stream, [UPDATED], { actor: PERMISSIONS_ACTOR, causationId: event.eventId, ...(event.correlationId !== null && { correlationId: event.correlationId }) });
    } catch (error) {
      // A notice is a courtesy to the clients: what changed the review is in the log whatever happens here.
      console.error(`Raising review.updated for ${event.type} ${event.eventId} failed:`, error);
    }
  });
};
