import { ContractError, SETTINGS_STREAM_KIND, invalidParams, type ReviewSeenPayload } from "@agent-harness/contracts";
import type { EventLog } from "../event-log/event-log.js";
import type { MethodHandlers } from "../serve/methods.js";
import type { Reader } from "../sessions/session-reads.js";
import { reviewRuns, reviewWatermark } from "./review-store.js";

/**
 * The Unattended review's methods (#131; permissions spec, "The Unattended
 * review view"; ADR 0003): `permissions.review.list` reads the review
 * projection (`review-store.ts`) since the environment-wide watermark, and
 * `permissions.review.seen` moves the watermark with `review.seen` on the
 * environment's settings stream: the environment's own state that a person
 * moves, beside its settings, and not the access log's, which says who
 * could do what. Clients hold no state: the watermark is the environment's.
 */

export interface ReviewMethodsOptions {
  readonly log: EventLog;
  /** The environment's id: the id of its settings stream, which the watermark is on. */
  readonly environmentId: string;
}

type ReviewMethodName = "permissions.review.list" | "permissions.review.seen";

export const reviewMethods = ({ log, environmentId }: ReviewMethodsOptions): Required<Pick<MethodHandlers, ReviewMethodName>> => {
  // The log's query-only read: inside a command it reads that command's own transaction.
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  return {
    // The head is read first: a run decided after it is listed and not marked seen by a `seen` through it.
    "permissions.review.list": () => {
      const head = log.head();
      const watermark = reviewWatermark(reader);
      return { watermark, head, runs: reviewRuns(reader, watermark) };
    },

    /** Moves the watermark forward to `through`, the head when absent; never back, and never past the head. */
    "permissions.review.seen": (params) => {
      const aggregate = { kind: SETTINGS_STREAM_KIND, id: environmentId };
      const head = log.head();
      const through = params.through ?? head;
      if (through > head) {
        const message = `The review cannot be seen through ${through}: the log's head is ${head}.`;
        throw new ContractError(invalidParams([{ code: "custom", path: ["through"], message }], message));
      }
      const watermark = reviewWatermark(reader);
      if (through <= watermark) return { aggregate, result: { watermark } };
      const payload: ReviewSeenPayload = { through };
      return { aggregate, result: { watermark: through }, events: [{ type: "review.seen", payload }] };
    },
  };
};
