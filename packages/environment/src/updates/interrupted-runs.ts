import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import {
  ENVIRONMENT_STREAM_KIND,
  SESSION_STREAM_KIND,
  type RunUpdateInterruptedPayload,
  type UpdateInterruptReason,
} from "@agent-harness/contracts";
import type { AdapterHost } from "../adapter/host.js";
import type { EventInput, EventLog } from "../event-log/event-log.js";
import { actorOfPolicy } from "../permissions/resolver.js";
import { readRunPolicy } from "../permissions/review-store.js";
import { decideStart, type PlannedRun } from "../runs/run-decider.js";
import { latestRun, readRun, readSessionFacts } from "../runs/run-reads.js";
import { appendRunEvents } from "../sessions/activity-companions.js";
import type { Reader } from "../sessions/session-reads.js";
import { sessionStream } from "../sessions/streams.js";
import { readUpdateHistory } from "./outcomes.js";

/**
 * The runs half of the settle (launcher-update spec, "The update
 * coordinator", Settle, and "Interrupted runs and parked prompts"; ADR 0007;
 * #345): an update never silently drops work. The runs an update cut are
 * those ended `drained` after its `environment.update-started` and before
 * the next start, parked runs included, since the drain ends them `drained`
 * as the environment closes. Whatever the update's outcome and whoever
 * recorded it, each that has no `run.update-interrupted` yet gets one on its
 * session, as `system:updates`, saying what became of it:
 *
 * - `next-message` when its session is deleted (`deleted`), or it was a
 *   completions request's (`completions`: its caller was answered 503
 *   `drained` and owns the retry, so it is never continued);
 * - `waiting-on-prompt` while a prompt of its session is parked: continuation
 *   never answers a prompt, and a person's answer resumes the session at once
 *   (`resumesOnAnswer`);
 * - `next-message` when it cannot go on by itself: the session's account is
 *   another now, signed out or no longer offers the run's model
 *   (`account`), its adapter cannot resume or it linked no provider session
 *   (`no-resume`), the workspace is gone (`workspace`), or the mode resolved
 *   now differs from the run's (`mode`);
 * - otherwise `continued`: one run as `system:updates` with the origin
 *   `update`, in the same transaction, resolved for the actor the cut run's
 *   policy names under the ceiling it was resolved under (as the run of the
 *   queue after a restart is, #131), in its model and effort, resuming its
 *   provider session, whose first message is the environment's own: why the
 *   turn stopped, and to check the current state before repeating anything.
 *   The session's queued messages follow it.
 *
 * Each run is settled in a transaction of its own, and one already marked is
 * passed over, so a second start appends nothing; a run whose settling fails
 * is left for the next start. After a rollback past a commit the restored log
 * never saw the marks, so the restored version marks and continues again.
 */

export interface InterruptedRunsOptions {
  readonly log: EventLog;
  /** What a continuation starts through: the facts a start decides on, and the launch once it has committed. */
  readonly host: Pick<AdapterHost, "startFacts" | "launch">;
  /** The environment's name, which the continuation's message says. */
  readonly environmentName: string;
  /** The version this start runs: the update took when it is the update's target. */
  readonly harnessVersion: string;
  /** Who the marks and the continuations name. */
  readonly actor: string;
}

/** A run the update cut and nothing has marked yet, with the effort its start recorded. */
interface CutRun {
  readonly sessionId: string;
  readonly runId: string;
  readonly effort: string | null;
}

/** What becomes of a cut run: its mark's outcome and reason, and for a continuation the run it starts with its events. */
type Verdict =
  | { readonly outcome: "waiting-on-prompt" }
  | { readonly outcome: "next-message"; readonly reason: UpdateInterruptReason }
  | { readonly outcome: "continued"; readonly run: PlannedRun; readonly events: readonly EventInput[] };

const waitsForNextMessage = (reason: UpdateInterruptReason): Verdict => ({ outcome: "next-message", reason });

/**
 * The message a continuation reads first: what cut the turn, then to check
 * before repeating anything. When the update did not take (a refused switch,
 * a rollback) the environment runs the version it went from, so the message
 * does not say it was updated.
 */
export const continuationMessage = (environmentName: string, toVersion: string, took: boolean): string =>
  `${took ? `${environmentName} was updated to ${toVersion}` : `${environmentName} was restarted for an update to ${toVersion}, which did not take,`} while you were working and your turn was cut off. Check the current state before repeating anything that may already have finished, then continue.`;

/**
 * The runs ended `drained` after the update's start at `after` and before
 * the first start after it (the drain ends a run's lifetime with the
 * environment's; a later drain's runs are not this update's), with no mark
 * yet, in the order they ended.
 */
const unmarkedCutRuns = (reader: Reader, after: number): CutRun[] => {
  const [bound] = reader.all<{ until: number | null }>(
    "SELECT MIN(sequence) AS until FROM events WHERE stream_kind = ? AND type = 'environment.started' AND sequence > ?",
    ENVIRONMENT_STREAM_KIND,
    after,
  );
  const until = bound?.until ?? null;
  return reader.all<CutRun>(
    `SELECT ended.stream_id AS sessionId, json_extract(ended.payload, '$.runId') AS runId,
       (SELECT json_extract(started.payload, '$.effort') FROM events started
         WHERE started.stream_kind = ended.stream_kind AND started.stream_id = ended.stream_id AND started.type = 'run.started'
           AND json_extract(started.payload, '$.runId') = json_extract(ended.payload, '$.runId')) AS effort
     FROM events ended
     WHERE ended.stream_kind = ? AND ended.type = 'run.ended' AND json_extract(ended.payload, '$.reason') = 'drained'
       AND ended.sequence > ? AND (? IS NULL OR ended.sequence < ?)
       AND NOT EXISTS (SELECT 1 FROM events marked
         WHERE marked.stream_kind = ended.stream_kind AND marked.stream_id = ended.stream_id AND marked.type = 'run.update-interrupted'
           AND json_extract(marked.payload, '$.runId') = json_extract(ended.payload, '$.runId'))
     ORDER BY ended.sequence`,
    SESSION_STREAM_KIND,
    after,
    until,
    until,
  );
};

/**
 * Whether a person's answer to a prompt of the session resumes it at once:
 * its latest run is one an update cut while a prompt of the session was
 * parked (`waiting-on-prompt`). The person did not stop that run, the update
 * did (David's decision of 2026-09-28, #345). Any other late answer is kept
 * for the session's next run and starts nothing (#130).
 */
export const resumesOnAnswer = (reader: Reader, sessionId: string): boolean => {
  const latest = latestRun(reader, sessionId);
  return (
    latest !== null &&
    reader.all(
      `SELECT 1 FROM events WHERE stream_kind = ? AND stream_id = ? AND type = 'run.update-interrupted'
         AND json_extract(payload, '$.runId') = ? AND json_extract(payload, '$.outcome') = 'waiting-on-prompt' LIMIT 1`,
      SESSION_STREAM_KIND,
      sessionId,
      latest.runId,
    ).length > 0
  );
};

/** Whether a prompt of the session is parked. */
const hasParkedPrompt = (reader: Reader, sessionId: string): boolean =>
  reader.all("SELECT 1 FROM prompts WHERE session_id = ? AND answered_sequence IS NULL LIMIT 1", sessionId).length > 0;

/** Whether the workspace directory at `path` is still there. */
const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

export const settleInterruptedRuns = (options: InterruptedRunsOptions): void => {
  const { log, host, actor } = options;
  const latest = readUpdateHistory(log).latest;
  if (latest === undefined) return;
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  const { updateId, toVersion } = latest.started;
  const text = continuationMessage(options.environmentName, toVersion, options.harnessVersion === toVersion);

  /** What becomes of `cut`, read in the transaction that marks it. */
  const verdictOf = (cut: CutRun): Verdict => {
    const session = readSessionFacts(log, reader, cut.sessionId);
    if (session === null || session.deleted) return waitsForNextMessage("deleted");
    const run = readRun(reader, cut.runId);
    const policy = readRunPolicy(reader, cut.runId);
    // A run with no recorded policy (a development log's, before #129) has no mode to go on in.
    if (run === null || policy === null) return waitsForNextMessage("mode");
    if (policy.actorKind === "completions") return waitsForNextMessage("completions");
    if (hasParkedPrompt(reader, cut.sessionId)) return { outcome: "waiting-on-prompt" };
    const facts = host.startFacts(cut.sessionId, actorOfPolicy(policy));
    const { account } = facts;
    if (account === null || !account.signedIn || facts.accountId !== run.accountId) return waitsForNextMessage("account");
    if (!account.descriptor.resume || run.providerSessionId === null) return waitsForNextMessage("no-resume");
    if (!isDirectory(session.workspace.path)) return waitsForNextMessage("workspace");
    const model = account.models.find((option) => option.id === run.model);
    if (model === undefined) return waitsForNextMessage("account");
    const decision = decideStart(facts, {
      origin: "update",
      message: { messageId: randomUUID(), text, attachments: [] },
      model: model.id,
      ...(cut.effort !== null && model.efforts.includes(cut.effort) && { effort: cut.effort }),
      messageFirst: true,
    });
    if (decision.rejected !== undefined) {
      if (decision.rejected.data.reason === "mode_unavailable") return waitsForNextMessage("mode");
      throw new Error(`The continuation of run ${cut.runId} was refused: ${decision.rejected.message}`);
    }
    if (decision.run.policy.mode.effective !== policy.mode.effective) return waitsForNextMessage("mode");
    return { outcome: "continued", run: decision.run, events: decision.events };
  };

  /** Marks `cut` with its verdict, and appends its continuation's start with it; answers the continuation to launch once committed. */
  const mark = (cut: CutRun): PlannedRun | undefined =>
    log.atomically((tx) => {
      const verdict = verdictOf(cut);
      const marked = { runId: cut.runId, updateId, toVersion };
      const payload: RunUpdateInterruptedPayload =
        verdict.outcome === "continued"
          ? { ...marked, outcome: "continued", reason: null, continuationRunId: verdict.run.runId }
          : verdict.outcome === "waiting-on-prompt"
            ? { ...marked, outcome: "waiting-on-prompt", reason: null, continuationRunId: null }
            : { ...marked, outcome: "next-message", reason: verdict.reason, continuationRunId: null };
      log.append(sessionStream(cut.sessionId), [{ type: "run.update-interrupted", payload }], { tx, actor, correlationId: cut.runId });
      if (verdict.outcome !== "continued") return undefined;
      appendRunEvents(log, cut.sessionId, verdict.events, { tx, actor, correlationId: verdict.run.runId });
      return verdict.run;
    });

  for (const cut of unmarkedCutRuns(reader, latest.sequence)) {
    let continuation: PlannedRun | undefined;
    try {
      continuation = mark(cut);
    } catch (error) {
      console.error(`Settling run ${cut.runId}, which update ${updateId} cut, failed; the next start settles it:`, error);
      continue;
    }
    if (continuation !== undefined) host.launch(continuation);
  }
};
