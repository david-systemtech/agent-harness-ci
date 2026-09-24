import type { EventLog } from "../event-log/event-log.js";
import { foldTranscript, readTranscriptEvents } from "../runs/transcript.js";
import type { MethodHandlers } from "../serve/methods.js";
import { sessionDiff, workingTreeDiff } from "./diffs.js";
import { listFiles, readWorkspaceFile } from "./files.js";
import { workspaceRoot } from "./paths.js";
import { requireSessionWorkspace } from "./session.js";

/**
 * The file and diff methods on the method table (tui spec, "Terminals,
 * files and diffs"; #124): read-only queries at scope `terminal` over a
 * session's workspace directory. A session that is not on this environment,
 * or is deleted, is `not_found` (kind `session`); a workspace directory that
 * is gone is `conflict`, reason `workspace_missing`.
 */

export interface WorkspaceMethodsOptions {
  readonly log: EventLog;
}

export const workspaceMethods = ({ log }: WorkspaceMethodsOptions): MethodHandlers => {
  /** The session's workspace as its real path, which every read resolves inside. */
  const rootOf = (sessionId: string): Promise<string> => workspaceRoot(requireSessionWorkspace(log, sessionId.toLowerCase()));

  return {
    "files.list": async (params) => listFiles(await rootOf(params.sessionId)),
    "files.read": async (params) => readWorkspaceFile(await rootOf(params.sessionId), params.path),
    "diffs.workingTree": async (params) => workingTreeDiff(await rootOf(params.sessionId)),
    "diffs.session": async (params) => {
      const sessionId = params.sessionId.toLowerCase();
      const recorded = requireSessionWorkspace(log, sessionId);
      // Its data is the log's, so a workspace directory that is gone does not stop it: the recorded path is a root.
      const real = await workspaceRoot(recorded).catch(() => undefined);
      // The runs' tool calls, as the session's snapshot folds them from its stream, deltas left out (`runs/transcript.ts`).
      const { items } = foldTranscript(readTranscriptEvents(log, sessionId));
      return sessionDiff(real === undefined || real === recorded ? [recorded] : [recorded, real], items);
    },
  };
};
