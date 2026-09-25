import {
  ReviewSeenPayload,
  RunPolicyResolvedPayload,
  SESSION_STREAM_KIND,
  SETTINGS_STREAM_KIND,
  ToolDecisionPayload,
  type ReviewDenial,
  type ReviewRun,
  type RunPolicy,
  type ToolDecider,
} from "@agent-harness/contracts";
import type { EventEnvelope, ProjectionDb } from "../event-log/event-log.js";
import type { Reader } from "../sessions/session-reads.js";

/**
 * The review projector (#131; permissions spec, "Modules": the review
 * projector, "The Unattended review view"): part of the permissions
 * projector, kept in the transaction of the events it follows and rebuilt
 * from the log. One row per run, from its `run.policy.resolved` (who ran it,
 * when, attended or not, its mode and containment), counted up by each of
 * its `tool.decision`s, which are kept one per tool call; the watermark
 * `review.seen` moves on the settings stream. A session's deletion hides its
 * rows (the list reads only sessions not deleted, so a restore shows them
 * again); its purge removes them.
 *
 * The projection holds the rule "one decision per tool call": a second
 * `tool.decision` for a call of a run that has one fails its append. A
 * decision that names no call (a prompt about no tool call) is its own.
 */

export const REVIEW_TABLES = {
  review_runs: `CREATE TABLE review_runs (
    run_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    started_sequence INTEGER NOT NULL,
    ran_at TEXT NOT NULL,
    attended INTEGER NOT NULL,
    policy TEXT NOT NULL,
    tool_calls INTEGER NOT NULL DEFAULT 0,
    auto_approved INTEGER NOT NULL DEFAULT 0,
    denied INTEGER NOT NULL DEFAULT 0,
    by_person INTEGER NOT NULL DEFAULT 0,
    expired INTEGER NOT NULL DEFAULT 0,
    flagged INTEGER NOT NULL DEFAULT 0,
    updated_sequence INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX review_runs_by_session ON review_runs (session_id);
  CREATE INDEX review_runs_by_update ON review_runs (updated_sequence)`,
  tool_decisions: `CREATE TABLE tool_decisions (
    sequence INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    tool_call_id TEXT,
    decision TEXT NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX tool_decisions_by_call ON tool_decisions (run_id, tool_call_id);
  CREATE INDEX tool_decisions_by_session ON tool_decisions (session_id)`,
  review_watermark: `CREATE TABLE review_watermark (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    through INTEGER NOT NULL
  ) STRICT`,
} as const;

/**
 * `run.policy.resolved` as the review reads it: `actorName` came with #131,
 * and a rebuild reads the runs before it (nothing was released before #131,
 * but a development log may hold them), so its absence reads as null.
 */
const ResolvedPolicy = RunPolicyResolvedPayload.extend({ actorName: RunPolicyResolvedPayload.shape.actorName.default(null) });

/** The deciders that make an attended run worth reviewing (a chosen default: a person's own bypass runs do not flood the view). */
const FLAGGED: ReadonlySet<ToolDecider> = new Set(["ttl", "denylist", "containment"]);

/** Applies a session-stream or settings-stream event to the review tables: the permissions projector's part for the review. */
export const projectReview = (event: EventEnvelope, db: ProjectionDb): void => {
  if (event.streamKind === SETTINGS_STREAM_KIND) {
    if (event.type !== "review.seen") return;
    const { through } = ReviewSeenPayload.parse(event.payload);
    db.run(
      "INSERT INTO review_watermark (id, through) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET through = max(through, excluded.through)",
      through,
    );
    return;
  }
  if (event.streamKind !== SESSION_STREAM_KIND) return;
  switch (event.type) {
    case "run.policy.resolved": {
      const { runId, ...policy } = ResolvedPolicy.parse(event.payload);
      db.run(
        `INSERT INTO review_runs (run_id, session_id, started_sequence, ran_at, attended, policy, updated_sequence) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id) DO NOTHING`,
        runId,
        event.streamId,
        event.sequence,
        event.occurredAt,
        policy.attended ? 1 : 0,
        JSON.stringify(policy),
        event.sequence,
      );
      return;
    }
    case "tool.decision": {
      const decision = ToolDecisionPayload.parse(event.payload);
      if (decision.toolCallId !== null) {
        const decided = db.get("SELECT 1 FROM tool_decisions WHERE run_id = ? AND tool_call_id = ?", decision.runId, decision.toolCallId);
        if (decided !== undefined) throw new Error(`Tool call ${decision.toolCallId} of run ${decision.runId} is decided already: a tool call has exactly one decision.`);
      }
      db.run(
        "INSERT INTO tool_decisions (sequence, run_id, session_id, tool_call_id, decision) VALUES (?, ?, ?, ?, ?)",
        event.sequence,
        decision.runId,
        event.streamId,
        decision.toolCallId,
        JSON.stringify(decision),
      );
      const person = decision.decidedBy === "person";
      db.run(
        `UPDATE review_runs SET tool_calls = tool_calls + 1, auto_approved = auto_approved + ?, denied = denied + ?, by_person = by_person + ?,
         expired = expired + ?, flagged = flagged + ?, updated_sequence = ? WHERE run_id = ?`,
        decision.decision === "allowed" && !person ? 1 : 0,
        decision.decision === "denied" ? 1 : 0,
        person ? 1 : 0,
        decision.decidedBy === "ttl" ? 1 : 0,
        FLAGGED.has(decision.decidedBy) ? 1 : 0,
        event.sequence,
        decision.runId,
      );
      return;
    }
    case "session.purged":
      db.run("DELETE FROM review_runs WHERE session_id = ?", event.streamId);
      db.run("DELETE FROM tool_decisions WHERE session_id = ?", event.streamId);
      return;
    default:
  }
};

/** The policy run `runId` was resolved under, as its `run.policy.resolved` recorded it; null for a run it has no row of. */
export const readRunPolicy = (reader: Reader, runId: string): RunPolicy | null => {
  const [row] = reader.all<{ policy: string }>("SELECT policy FROM review_runs WHERE run_id = ?", runId);
  return row === undefined ? null : (JSON.parse(row.policy) as RunPolicy);
};

/** Whether the tool call `toolCallId` of run `runId` has its decision. */
export const isDecided = (reader: Reader, runId: string, toolCallId: string): boolean =>
  reader.all("SELECT 1 FROM tool_decisions WHERE run_id = ? AND tool_call_id = ?", runId, toolCallId).length > 0;

/** The log position the review has been seen through; 0 when it never has. */
export const reviewWatermark = (reader: Reader): number =>
  reader.all<{ through: number }>("SELECT through FROM review_watermark WHERE id = 1")[0]?.through ?? 0;

interface ReviewRow {
  run_id: string;
  session_id: string;
  ran_at: string;
  attended: number;
  policy: string;
  tool_calls: number;
  auto_approved: number;
  denied: number;
  by_person: number;
  expired: number;
}

/**
 * The runs the review lists, newest first, at most `limit`: those with
 * anything decided after `watermark` that qualify (unattended with a tool
 * call, or attended with a call decided by the TTL, the denylist or
 * containment), a deleted session's left out, each with its denials in the
 * order they were decided, read in one query for all of them.
 */
export const reviewRuns = (reader: Reader, watermark: number, limit: number): ReviewRun[] => {
  const rows = reader.all<ReviewRow>(
    `SELECT review_runs.* FROM review_runs JOIN sessions ON sessions.id = review_runs.session_id
     WHERE sessions.deleted_at IS NULL AND review_runs.updated_sequence > ?
     AND ((review_runs.attended = 0 AND review_runs.tool_calls > 0) OR (review_runs.attended = 1 AND review_runs.flagged > 0))
     ORDER BY review_runs.started_sequence DESC LIMIT ?`,
    watermark,
    limit,
  );
  const denials = new Map<string, ReviewDenial[]>();
  const runIds = JSON.stringify(rows.map((row) => row.run_id));
  for (const { run_id: runId, decision } of reader.all<{ run_id: string; decision: string }>(
    `SELECT run_id, decision FROM tool_decisions WHERE run_id IN (SELECT value FROM json_each(?)) AND json_extract(decision, '$.decision') = 'denied' ORDER BY sequence`,
    runIds,
  )) {
    const denied = JSON.parse(decision) as Extract<ToolDecisionPayload, { decision: "denied" }>;
    const list = denials.get(runId) ?? [];
    list.push({ toolCallId: denied.toolCallId, tool: denied.tool, summary: denied.summary, decidedBy: denied.decidedBy, reason: denied.reason });
    denials.set(runId, list);
  }
  return rows.map((row): ReviewRun => {
    const policy = JSON.parse(row.policy) as RunPolicy;
    return {
      sessionId: row.session_id,
      runId: row.run_id,
      ranAt: row.ran_at,
      actor: { kind: policy.actorKind, name: policy.actorName },
      attended: row.attended === 1,
      mode: policy.mode,
      containment: policy.containment,
      counts: { toolCalls: row.tool_calls, autoApproved: row.auto_approved, denied: row.denied, answeredByPerson: row.by_person, expired: row.expired },
      denials: denials.get(row.run_id) ?? [],
    };
  });
};
