import {
  GROUP_STREAM_KIND,
  LIST_PATCH_KEY,
  SESSION_STREAM_KIND,
  type EventEnvelope,
  type Group,
  type GroupPatch,
  type SessionSummary,
  type SummaryPatch,
} from "@agent-harness/contracts";
import { uuidv7 } from "../src/ids.js";
import { MANUAL_CLOCK_START } from "../src/testing/in-memory-platform.js";

export { freshSummary as summaryOf } from "../../environment/test/sessions.js";

/**
 * Event envelopes as an environment sends them, for the stream suites: a
 * session or group event carrying its list patch, and one with none.
 */

const envelope = (sequence: number, fields: Pick<EventEnvelope, "streamKind" | "streamId" | "type" | "payload" | "metadata">): EventEnvelope => ({
  sequence,
  eventId: uuidv7(new Date(MANUAL_CLOCK_START)),
  streamVersion: 1,
  occurredAt: MANUAL_CLOCK_START,
  commandId: null,
  causationId: null,
  correlationId: null,
  actor: { kind: "system", id: "test" },
  ...fields,
});

/** A session event at `sequence` carrying `patch`. */
export const sessionEvent = (sequence: number, patch: SummaryPatch, type = "session.archived"): EventEnvelope =>
  envelope(sequence, {
    streamKind: SESSION_STREAM_KIND,
    streamId: patch.op === "add" ? patch.summary.id : patch.sessionId,
    type,
    payload: {},
    metadata: { [LIST_PATCH_KEY]: patch },
  });

/** A group event at `sequence` carrying `patch`. */
export const groupEvent = (sequence: number, patch: GroupPatch, type = "group.renamed"): EventEnvelope =>
  envelope(sequence, {
    streamKind: GROUP_STREAM_KIND,
    streamId: patch.op === "add" ? patch.group.id : patch.groupId,
    type,
    payload: {},
    metadata: { [LIST_PATCH_KEY]: patch },
  });

/** An event of `streamKind` with no patch: on the list stream by its type, and skipped. */
export const unpatchedEvent = (sequence: number, streamId: string, type = "session.group-set", streamKind = SESSION_STREAM_KIND): EventEnvelope =>
  envelope(sequence, { streamKind, streamId, type, payload: {}, metadata: {} });

/** An environment notice at `sequence`. */
export const noticeEvent = (sequence: number, environmentId: string, type: string, payload: Record<string, unknown>): EventEnvelope =>
  envelope(sequence, { streamKind: "environment", streamId: environmentId, type, payload, metadata: {} });

/** A group as the environment keeps it. */
export const groupOf = (id: string, name: string, fields: Partial<Group> = {}): Group => ({
  id,
  name,
  orderKey: null,
  createdAt: MANUAL_CLOCK_START,
  updatedAt: MANUAL_CLOCK_START,
  ...fields,
});

/** A summary patch adding `summary`. */
export const added = (summary: SessionSummary): SummaryPatch => ({ op: "add", summary });

/** `event` as the command `commandId` produced it: the envelope names the command, as an outbox's overlay reads it. */
export const byCommand = (event: EventEnvelope, commandId: string): EventEnvelope => ({ ...event, commandId });

/** An accepted receipt at `sequence`. */
export const accepted = (sequence: number, changed = true) => ({ status: "accepted", sequence, changed }) as const;

/** A rejected receipt at `sequence` for `code`, with the error's data. */
export const rejected = (sequence: number, code: string, data: Record<string, unknown> = {}) =>
  ({ status: "rejected", sequence, changed: false, reason: code, error: { code, message: `Rejected: ${code}.`, data } }) as const;
