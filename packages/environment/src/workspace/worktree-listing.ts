import { realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { isInside } from "./paths.js";

/**
 * The worktrees git lists for a repository, as the worktree maker (#326),
 * `workspaces.inspect` (#331) and the reaper (#330) read them: `git worktree list --porcelain
 * -z`, and where each lies as the environment records it when it is one of
 * the environment's own, under its worktrees root.
 */

/** The arguments that list a repository's worktrees, the main checkout (or the bare repository) first. */
export const WORKTREE_LIST = ["worktree", "list", "--porcelain", "-z"] as const;

/** One worktree as `git worktree list --porcelain -z` lists it; the first is the main checkout or the bare repository. */
export interface ListedWorktree {
  /** Where it is, as git lists it: links resolved. */
  readonly path: string;
  readonly bare: boolean;
  /** The branch checked out, as a full ref; null when detached, or bare. */
  readonly branch: string | null;
  /** Whether it is locked, so `git worktree prune` and a non-forcing remove leave it alone. */
  readonly locked: boolean;
}

/** The worktrees in a `--porcelain -z` listing: fields ended by a NUL, each worktree's ended by an empty one. */
export const listedWorktrees = (listing: string): ListedWorktree[] => {
  const worktrees: ListedWorktree[] = [];
  let current: { path: string; bare: boolean; branch: string | null; locked: boolean } | null = null;
  for (const field of listing.split("\0")) {
    const space = field.indexOf(" ");
    const [key, value] = space === -1 ? [field, ""] : [field.slice(0, space), field.slice(space + 1)];
    if (key === "worktree") {
      current = { path: value, bare: false, branch: null, locked: false };
      worktrees.push(current);
    } else if (current !== null && key === "bare") current.bare = true;
    else if (current !== null && key === "branch") current.branch = value;
    else if (current !== null && key === "locked") current.locked = true;
  }
  return worktrees;
};

/**
 * How the environment records a worktree git lists: the path under the
 * worktrees root `root` as the environment names that root (git lists
 * paths with their links resolved, and the root's may have one), or null
 * for a worktree outside it, one of the user's.
 */
export const worktreeRecorder = async (root: string): Promise<(listed: string) => string | null> => {
  const real = await realpath(root).catch(() => root);
  return (listed) => {
    for (const at of [root, real]) if (isInside(at, listed)) return join(root, relative(at, listed));
    return null;
  };
};
