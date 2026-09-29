import { ContractError, type Workspace, type WorkspaceStatus } from "@agent-harness/contracts";
import type { EventLog } from "../event-log/event-log.js";
import { sessionNotFound } from "../sessions/decider.js";

/**
 * A session's workspace directory, as the terminal, file and diff methods
 * find it: from the session list's read model, which `sessions.create`
 * wrote. A session that is not on this environment, or is deleted, has none.
 */

/**
 * The session's workspace path, and its status as the availability watcher
 * last marked it (#328); null when there is no such session, or it is deleted.
 */
export const sessionWorkspaceStatus = (log: Pick<EventLog, "read">, sessionId: string): { readonly path: string; readonly status: WorkspaceStatus } | null => {
  const [row] = log.read<{ deleted_at: string | null; workspace: string; workspace_missing_since: string | null }>(
    "SELECT deleted_at, workspace, workspace_missing_since FROM sessions WHERE id = ?",
    sessionId,
  );
  if (row === undefined || row.deleted_at !== null) return null;
  return { path: (JSON.parse(row.workspace) as Workspace).path, status: row.workspace_missing_since === null ? "present" : "missing" };
};

/** The session's workspace path; null when there is no such session, or it is deleted. */
export const sessionWorkspace = (log: Pick<EventLog, "read">, sessionId: string): string | null => sessionWorkspaceStatus(log, sessionId)?.path ?? null;

/** The session's workspace path, or the `not_found` (kind `session`) a query answers with. */
export const requireSessionWorkspace = (log: Pick<EventLog, "read">, sessionId: string): string => {
  const path = sessionWorkspace(log, sessionId);
  if (path === null) throw new ContractError(sessionNotFound(sessionId));
  return path;
};

/**
 * The session whose recorded workspace is the worktree at `path` (as the
 * environment records it): the first made there, a deleted one in its grace
 * included; null for none. What a worktree the harness made is held by.
 */
export const worktreeSession = (log: Pick<EventLog, "read">, path: string): string | null => {
  const [row] = log.read<{ id: string }>(
    "SELECT id FROM sessions WHERE json_extract(workspace, '$.kind') = 'worktree' AND json_extract(workspace, '$.path') = ? ORDER BY created_at, id LIMIT 1",
    path,
  );
  return row?.id ?? null;
};
