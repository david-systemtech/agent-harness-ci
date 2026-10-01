import type { Workspace, WorkspaceRequest } from "@agent-harness/contracts";
import type { EventLog } from "../event-log/event-log.js";
import type { AvailabilityWatcher } from "./availability.js";

/**
 * The checkout index (workspace-picker spec, "Completions, minted sessions,
 * routines, hand-off"; #329): for a repository identity, where on this
 * environment a session on that repository should work. A routine's move
 * (#92) and later hand-off re-resolve through it.
 *
 * It answers the most recently used known directory holding the identity
 * that is there now, as a `directory` request, else `scratch`. A known
 * directory is one this environment's sessions (deleted ones aside) use: a
 * directory's path, a worktree's repository. A session uses its directory
 * at its last run's start, else at its creation.
 *
 * It looks at each known directory through the availability watcher's
 * `look` (#709), within its time bound and gate, and marks nothing: a
 * directory on a network mount whose server is gone does not hold the
 * answer. One not found there, not answering in time, or not looked at while
 * the gate holds is passed over for the next.
 */

/** What the index answers: a directory to resolve, or a scratch workspace. */
export type CheckoutRequest = Extract<WorkspaceRequest, { kind: "directory" | "scratch" }>;

export interface CheckoutIndex {
  /** The request a session on `repositoryIdentity` works from here: see the module comment. */
  checkoutFor(repositoryIdentity: string): Promise<CheckoutRequest>;
}

/** The known directory a session's workspace names: a directory's path, a worktree's repository; none for scratch. */
const knownDirectory = (workspace: Workspace): string | null => {
  switch (workspace.kind) {
    case "directory":
      return workspace.path;
    case "worktree":
      return workspace.repository;
    case "scratch":
      return null;
  }
};

export interface CheckoutIndexOptions {
  readonly log: Pick<EventLog, "read">;
  /** The availability watcher, whose bounded look says whether a known directory is there now. */
  readonly availability: Pick<AvailabilityWatcher, "look">;
}

/** The checkout index over the environment's session list. */
export const createCheckoutIndex = ({ log, availability }: CheckoutIndexOptions): CheckoutIndex => ({
  checkoutFor: async (repositoryIdentity) => {
    const rows = log.read<{ workspace: string }>(
      "SELECT workspace FROM sessions WHERE deleted_at IS NULL AND repository_identity = ? ORDER BY COALESCE(last_activity_at, created_at) DESC, id",
      repositoryIdentity,
    );
    const asked = new Set<string>();
    for (const row of rows) {
      const directory = knownDirectory(JSON.parse(row.workspace) as Workspace);
      if (directory === null || asked.has(directory)) continue;
      asked.add(directory);
      if ((await availability.look(directory)) === "present") return { kind: "directory", path: directory };
    }
    return { kind: "scratch" };
  },
});
