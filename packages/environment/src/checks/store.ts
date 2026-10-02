import { ENVIRONMENT_STREAM_KIND, SESSION_STREAM_KIND, type ChecksStartedPayload } from "@agent-harness/contracts";
import type { Projector } from "../event-log/event-log.js";
import type { Reader } from "../sessions/session-tables.js";

/**
 * What Workspace checks keep (#1187), as a projection of their events, so
 * a restart and a rebuild find it again: each canonical directory's check
 * command and the client session that last set it (the `checks.changed`
 * notices, whose actor is that client session), and the checks started and
 * not yet finished (a `checks.started` with no `checks.finished` naming its
 * terminal), which a restart finds interrupted.
 */

export const CHECKS_PROJECTOR = "workspace-checks";

export const CHECKS_TABLES = {
  workspace_checks: `CREATE TABLE workspace_checks (
    workspace TEXT PRIMARY KEY,
    command TEXT,
    configured_by TEXT NOT NULL
  ) STRICT`,
  unfinished_checks: `CREATE TABLE unfinished_checks (
    terminal_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    command TEXT NOT NULL,
    source_run_id TEXT
  ) STRICT`,
} as const;

export const checksProjector: Projector = {
  name: CHECKS_PROJECTOR,
  tables: CHECKS_TABLES,
  apply(event, db) {
    if (event.streamKind === ENVIRONMENT_STREAM_KIND && event.type === "checks.changed") {
      db.run(
        "INSERT INTO workspace_checks (workspace, command, configured_by) VALUES (?, ?, ?) ON CONFLICT (workspace) DO UPDATE SET command = excluded.command, configured_by = excluded.configured_by",
        String(event.payload["workspace"]),
        (event.payload["command"] as string | null) ?? null,
        event.actor,
      );
      return;
    }
    if (event.streamKind !== SESSION_STREAM_KIND) return;
    if (event.type === "checks.started") {
      const started = event.payload as ChecksStartedPayload;
      db.run(
        "INSERT OR IGNORE INTO unfinished_checks (terminal_id, session_id, command, source_run_id) VALUES (?, ?, ?, ?)",
        started.terminalId,
        event.streamId,
        started.command,
        started.sourceRunId,
      );
    } else if (event.type === "checks.finished") {
      db.run("DELETE FROM unfinished_checks WHERE terminal_id = ?", String(event.payload["terminalId"]));
    } else if (event.type === "session.purged") {
      // A purged session's stream holds its tombstone alone: nothing of its checks is left to finish.
      db.run("DELETE FROM unfinished_checks WHERE session_id = ?", event.streamId);
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
