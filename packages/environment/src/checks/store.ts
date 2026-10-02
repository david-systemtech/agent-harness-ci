import { ENVIRONMENT_STREAM_KIND, SESSION_STREAM_KIND, checkPassed, type ChecksFinishedPayload, type ChecksStartedPayload } from "@agent-harness/contracts";
import type { Projector } from "../event-log/event-log.js";
import type { Reader } from "../sessions/session-tables.js";

/**
 * What Workspace checks keep (#1187, #1188), as a projection of their events, so
 * a restart and a rebuild find it again: each canonical directory's check
 * command and the client session that last set it (the `checks.changed`
 * notices, whose actor is that client session), and the checks started and
 * not yet finished (a `checks.started` with no `checks.finished` naming its
 * terminal), which a restart finds interrupted. Successful hook evidence,
 * Run deduplication, one latest pending edit per directory and offered failure
 * identities are projected here too, in the transaction of their events.
 */

export const CHECKS_PROJECTOR = "workspace-checks";

export const CHECKS_TABLES = {
  workspace_checks: `CREATE TABLE workspace_checks (
    workspace TEXT PRIMARY KEY,
    command TEXT,
    configured_by TEXT NOT NULL,
    revision INTEGER NOT NULL
  ) STRICT`,
  check_failure_offers: `CREATE TABLE check_failure_offers (
    workspace TEXT NOT NULL,
    failure_key TEXT NOT NULL,
    PRIMARY KEY (workspace, failure_key)
  ) STRICT`,
  check_edits: `CREATE TABLE check_edits (
    run_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    workspace TEXT NOT NULL,
    ended INTEGER NOT NULL DEFAULT 0
  ) STRICT`,
  pending_checks: `CREATE TABLE pending_checks (
    workspace TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    revision INTEGER NOT NULL
  ) STRICT`,
  unfinished_checks: `CREATE TABLE unfinished_checks (
    terminal_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    command TEXT NOT NULL,
    source_run_id TEXT,
    workspace TEXT,
    revision INTEGER
  ) STRICT`,
} as const;

export const checksProjector: Projector = {
  name: CHECKS_PROJECTOR,
  tables: CHECKS_TABLES,
  apply(event, db) {
    if (event.streamKind === ENVIRONMENT_STREAM_KIND && event.type === "checks.changed") {
      db.run(
        "INSERT INTO workspace_checks (workspace, command, configured_by, revision) VALUES (?, ?, ?, ?) ON CONFLICT (workspace) DO UPDATE SET command = excluded.command, configured_by = excluded.configured_by, revision = excluded.revision",
        String(event.payload["workspace"]),
        (event.payload["command"] as string | null) ?? null,
        event.actor,
        event.sequence,
      );
      db.run("DELETE FROM pending_checks WHERE workspace = ?", String(event.payload["workspace"]));
      db.run("DELETE FROM check_failure_offers WHERE workspace = ?", String(event.payload["workspace"]));
      return;
    }
    if (event.streamKind !== SESSION_STREAM_KIND) return;
    if (event.type === "checks.edit-observed") {
      db.run("INSERT OR IGNORE INTO check_edits (run_id, session_id, workspace) VALUES (?, ?, ?)", String(event.payload["runId"]), event.streamId, String(event.payload["workspace"]));
    } else if (event.type === "run.ended") {
      const runId = String(event.payload["runId"]);
      const edit = db.get<{ workspace: string; ended: number }>("SELECT workspace, ended FROM check_edits WHERE run_id = ? AND session_id = ?", runId, event.streamId);
      if (edit === undefined || edit.ended !== 0) return;
      db.run("UPDATE check_edits SET ended = 1 WHERE run_id = ?", runId);
      if (event.payload["reason"] !== "completed") return;
      const config = db.get<{ command: string | null; revision: number }>("SELECT command, revision FROM workspace_checks WHERE workspace = ?", edit.workspace);
      if (config?.command == null) return;
      db.run("INSERT INTO pending_checks (workspace, session_id, run_id, revision) VALUES (?, ?, ?, ?) ON CONFLICT (workspace) DO UPDATE SET session_id = excluded.session_id, run_id = excluded.run_id, revision = excluded.revision", edit.workspace, event.streamId, runId, config.revision);
    } else if (event.type === "checks.started") {
      const started = event.payload as ChecksStartedPayload;
      db.run(
        "INSERT OR IGNORE INTO unfinished_checks (terminal_id, session_id, command, source_run_id, workspace, revision) VALUES (?, ?, ?, ?, ?, ?)",
        started.terminalId,
        event.streamId,
        started.command,
        started.sourceRunId,
        (event.metadata["workspace"] as string | undefined) ?? null,
        (event.metadata["revision"] as number | undefined) ?? null,
      );
      if (started.sourceRunId === null && typeof event.metadata["workspace"] === "string") db.run("DELETE FROM check_failure_offers WHERE workspace = ?", event.metadata["workspace"]);
      if (started.sourceRunId !== null) db.run("DELETE FROM pending_checks WHERE run_id = ?", started.sourceRunId);
    } else if (event.type === "checks.finished") {
      const terminalId = String(event.payload["terminalId"]);
      const context = db.get<{ workspace: string | null; revision: number | null }>("SELECT workspace, revision FROM unfinished_checks WHERE terminal_id = ?", terminalId);
      const config = context?.workspace == null ? undefined : db.get<{ revision: number }>("SELECT revision FROM workspace_checks WHERE workspace = ?", context.workspace);
      if (context?.workspace != null && context.revision === config?.revision) {
        if (checkPassed(event.payload as ChecksFinishedPayload)) db.run("DELETE FROM check_failure_offers WHERE workspace = ?", context.workspace);
        else if (event.payload["offerFailure"] === true && typeof event.metadata["failureKey"] === "string") db.run("INSERT OR IGNORE INTO check_failure_offers (workspace, failure_key) VALUES (?, ?)", context.workspace, event.metadata["failureKey"]);
      }
      db.run("DELETE FROM unfinished_checks WHERE terminal_id = ?", String(event.payload["terminalId"]));
    } else if (event.type === "session.purged") {
      // A purged session's stream holds its tombstone alone: nothing of its checks is left to finish.
      db.run("DELETE FROM unfinished_checks WHERE session_id = ?", event.streamId);
      db.run("DELETE FROM pending_checks WHERE session_id = ?", event.streamId);
      db.run("DELETE FROM check_edits WHERE session_id = ?", event.streamId);
    }
  },
};

/** A canonical directory's check: its command (null once cleared) and the client session that set it, as the log names an actor; undefined for a directory never set. */
export const readWorkspaceCheck = (reader: Reader, workspace: string): { readonly command: string | null; readonly configuredBy: string } | undefined => {
  const [row] = reader.all<{ command: string | null; configured_by: string }>("SELECT command, configured_by FROM workspace_checks WHERE workspace = ?", workspace);
  return row === undefined ? undefined : { command: row.command, configuredBy: row.configured_by };
};

/** The checks started and never finished, each with its session: what the environment's stop or crash cut. */
export const readUnfinishedChecks = (reader: Reader): (ChecksStartedPayload & { readonly sessionId: string })[] =>
  reader
    .all<{ terminal_id: string; session_id: string; command: string; source_run_id: string | null }>(
      "SELECT terminal_id, session_id, command, source_run_id FROM unfinished_checks ORDER BY rowid",
    )
    .map((row) => ({ terminalId: row.terminal_id, sessionId: row.session_id, command: row.command, sourceRunId: row.source_run_id }));

/** The latest completed edited Run waiting in each canonical directory. */
export interface PendingCheck {
  readonly workspace: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
}
export const readPendingChecks = (reader: Reader): PendingCheck[] => reader
  .all<{ workspace: string; session_id: string; run_id: string; revision: number }>("SELECT * FROM pending_checks ORDER BY rowid")
  .map((row) => ({ workspace: row.workspace, sessionId: row.session_id, runId: row.run_id, revision: row.revision }));
export const checkRevision = (reader: Reader, workspace: string): number | undefined => reader.all<{ revision: number }>("SELECT revision FROM workspace_checks WHERE workspace = ?", workspace)[0]?.revision;

export const failureWasOffered = (reader: Reader, workspace: string, key: string): boolean => reader.all("SELECT 1 FROM check_failure_offers WHERE workspace = ? AND failure_key = ?", workspace, key).length !== 0;

/** Canonical context kept with an unfinished attempt, including a crash before terminal launch. */
export const readCheckContext = (reader: Reader, terminalId: string): { readonly workspace: string | null; readonly revision: number | null } | undefined => reader.all<{ workspace: string | null; revision: number | null }>("SELECT workspace, revision FROM unfinished_checks WHERE terminal_id = ?", terminalId)[0];
