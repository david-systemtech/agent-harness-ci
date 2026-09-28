import { join, resolve } from "node:path";

/**
 * The workspace roots (workspace-picker spec, "The resolver"): the
 * directories inside the data directory where the environment keeps what it
 * makes for sessions, the data directory's `scratch` (a scratch workspace
 * per session) and `worktrees` (the worktrees it makes, #326), and those a
 * later workstream declares (bank checkouts, #90) through the one
 * registration, `workspaceRoots`'s `declared`. A directory request inside a
 * root is allowed, though the rest of the data directory is reserved, and
 * every root is exempt from the denylist's data-directory preset, as the
 * containment directories are (#132, #140).
 */

/** The scratch root's name under the data directory. */
export const SCRATCH_DIRECTORY = "scratch";

/** The worktrees root's name under the data directory. */
export const WORKTREES_DIRECTORY = "worktrees";

export interface WorkspaceRoots {
  /** `<data dir>/scratch`: a scratch workspace per session, named by its id. */
  readonly scratch: string;
  /** `<data dir>/worktrees`: the worktrees the environment makes. */
  readonly worktrees: string;
  /** Every root, absolute: scratch, worktrees, then the declared ones in the order given. */
  readonly all: readonly string[];
}

/** The workspace roots of the environment whose data directory is `dataDir` (absolute), with the roots `declared` beside them. */
export const workspaceRoots = (dataDir: string, declared: readonly string[] = []): WorkspaceRoots => {
  const scratch = join(dataDir, SCRATCH_DIRECTORY);
  const worktrees = join(dataDir, WORKTREES_DIRECTORY);
  return { scratch, worktrees, all: [scratch, worktrees, ...declared.map((root) => resolve(root))] };
};
