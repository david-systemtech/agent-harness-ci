import type { EventLog } from "../event-log/event-log.js";
import { sessionTranscript } from "../runs/transcript.js";
import type { MethodHandlers } from "../serve/methods.js";
import type { AvailabilityWatcher } from "./availability.js";
import { browseDirectory } from "./browse.js";
import { sessionDiff, workingTreeDiff } from "./diffs.js";
import { listFiles, readWorkspaceFile } from "./files.js";
import { inspectPath } from "./inspect.js";
import { workspaceRoot } from "./paths.js";
import type { DirectoryRules } from "./resolver.js";
import { requireSessionWorkspace, worktreeSession } from "./session.js";

/**
 * The file and diff methods on the method table (tui spec, "Terminals,
 * files and diffs"; #124): read-only queries at scope `terminal` over a
 * session's workspace directory. A session that is not on this environment,
 * or is deleted, is `not_found` (kind `session`); a workspace directory that
 * is gone is `conflict`, reason `workspace_missing`, and what each finds of
 * the workspace, gone or there, marks the session through the availability
 * watcher (#328); `diffs.session` reads the log and marks nothing. Beside
 * them, at the same scope, browsing and inspecting the environment's
 * directories for the workspace picker (#331), which read a path by the
 * resolver's own rules.
 */

export interface WorkspaceMethodsOptions {
  readonly log: EventLog;
  /** Told what a file or working-tree diff method found of a session's workspace, gone or there (#328). */
  readonly availability: Pick<AvailabilityWatcher, "found">;
  /** The environment's resolver's directory rules: how a path is recorded, its problem, the identity a session there gets. */
  readonly directoryRules: DirectoryRules;
  /** The data directory's worktrees root, where the worktrees the harness makes are. */
  readonly worktreesRoot: string;
  /** How long each git call inspecting a repository gets; preset: the hardened runner's 15 seconds. */
  readonly gitTimeoutMs?: number;
}

export const workspaceMethods = ({ log, availability, directoryRules, worktreesRoot, gitTimeoutMs }: WorkspaceMethodsOptions): MethodHandlers => {
  /** The session's workspace as its real path, which every read resolves inside; what was found of it marks the session. */
  const rootOf = async (sessionId: string): Promise<string> => {
    const id = sessionId.toLowerCase();
    const recorded = requireSessionWorkspace(log, id);
    try {
      const real = await workspaceRoot(recorded);
      availability.found(id, recorded, "present");
      return real;
    } catch (error) {
      availability.found(id, recorded, "missing");
      throw error;
    }
  };

  return {
    "workspaces.browse": (params) => browseDirectory(directoryRules.recorded(params.path ?? "~"), params.hidden === true, directoryRules),
    "workspaces.inspect": (params) =>
      inspectPath(params.path, {
        rules: directoryRules,
        worktreesRoot,
        sessionAt: (path) => worktreeSession(log, path),
        ...(gitTimeoutMs !== undefined && { timeoutMs: gitTimeoutMs }),
      }),
    "files.list": async (params) => listFiles(await rootOf(params.sessionId)),
    "files.read": async (params) => readWorkspaceFile(await rootOf(params.sessionId), params.path),
    "diffs.workingTree": async (params) => workingTreeDiff(await rootOf(params.sessionId)),
    "diffs.session": async (params) => {
      const sessionId = params.sessionId.toLowerCase();
      const recorded = requireSessionWorkspace(log, sessionId);
      // Its data is the log's, so a workspace directory that is gone does not stop it: the recorded path is a root.
      const real = await workspaceRoot(recorded).catch(() => undefined);
      // The runs' tool calls from the compaction snapshot, if any, folded on with the remaining stream.
      const { items } = sessionTranscript(log, sessionId);
      // A change files.undo took back is not the session's any more (#1183).
      return sessionDiff(real === undefined || real === recorded ? [recorded] : [recorded, real], items, log.fileChanges.undoneCalls(sessionId));
    },
  };
};
