import { readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { TrustKeyKind, Workspace } from "@agent-harness/contracts";

/**
 * The key a session's repository goes by on this environment
 * (workspace-picker spec, "Repository identity"; skills spec, "The trust
 * gate"): its repository identity; else its repository's main checkout, so
 * the worktrees of a repository with no remote share one key, as Claude
 * Code keys memory by repository; else its workspace path. A scratch
 * workspace, in which nothing is a checkout and which never has an
 * identity, has none. Auto memory keys its directories on it (#329), and
 * the trust gate its decisions (#500).
 */

/** A session's place, as the key reads it: its workspace and its repository identity. */
export interface RepositoryPlace {
  readonly workspace: Workspace;
  readonly repositoryIdentity: string | null;
}

/** A repository key: what it is (the identity, a main checkout, a workspace path) and its value. */
export interface RepositoryKey {
  readonly kind: TrustKeyKind;
  readonly value: string;
}

/** A repository's git directory, or the file naming it, in the checkout it belongs to. */
const DOT_GIT = ".git";

/**
 * The main checkout of the repository whose `.git` lies in `directory`, or
 * undefined when none does, as git names a repository's main worktree. A
 * `.git` directory is a checkout's own. A `.git` file names the git
 * directory elsewhere (`gitdir:`), whose common git directory is the one its
 * `commondir` names (a linked worktree's), else itself (a submodule's, or
 * one separated with `--separate-git-dir`): a common directory named `.git`
 * lies in the main checkout; any other (a bare repository, a submodule's
 * under its superproject's, a separated one) stands for it, as `git
 * worktree list` gives it, so a checkout and its worktrees share it. A
 * `.git` file that cannot be read is taken as the checkout here.
 */
const checkoutAt = (directory: string): string | undefined => {
  const dotGit = join(directory, DOT_GIT);
  let isDirectory: boolean;
  try {
    const stats = statSync(dotGit);
    if (!stats.isDirectory() && !stats.isFile()) return undefined;
    isDirectory = stats.isDirectory();
  } catch {
    return undefined;
  }
  if (isDirectory) return directory;
  try {
    const named = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"))?.[1];
    if (named === undefined) return directory;
    const gitDir = isAbsolute(named) ? named : resolve(directory, named);
    const common = commonDirectory(gitDir);
    return basename(common) === DOT_GIT ? dirname(common) : common;
  } catch {
    return directory;
  }
};

/** The common git directory of the git directory `gitDir`: the one its `commondir` names, else itself. */
const commonDirectory = (gitDir: string): string => {
  let named: string;
  try {
    named = readFileSync(join(gitDir, "commondir"), "utf8").trim();
  } catch {
    return gitDir;
  }
  return isAbsolute(named) ? named : resolve(gitDir, named);
};

/** The main checkout of the innermost repository holding `path`, found from `path` up; null when no repository holds it. */
const checkoutAbove = (path: string): string | null => {
  for (let directory = path; ; directory = dirname(directory)) {
    const checkout = checkoutAt(directory);
    if (checkout !== undefined) return checkout;
    if (dirname(directory) === directory) return null;
  }
};

/**
 * The main checkout (or bare repository) of the repository holding
 * `workspace`, or null for none, read from the files git keeps (no git
 * runs): the innermost repository found from the workspace's path up, a
 * worktree's (the environment's or the user's) through its `.git` file; for
 * a worktree the environment made whose directory is gone, the repository
 * it recorded. None for a scratch workspace, in which nothing is a
 * checkout.
 */
export const mainCheckout = (workspace: Workspace): string | null => {
  if (workspace.kind === "scratch") return null;
  const checkout = checkoutAbove(workspace.path);
  return workspace.kind === "worktree" ? (checkout ?? workspace.repository) : checkout;
};

/** The key of `place`'s repository: see the module comment; null for a scratch workspace. */
export const repositoryKey = (place: RepositoryPlace): RepositoryKey | null => {
  const { workspace, repositoryIdentity } = place;
  if (workspace.kind === "scratch") return null;
  if (repositoryIdentity !== null) return { kind: "identity", value: repositoryIdentity };
  const checkout = mainCheckout(workspace);
  return checkout !== null ? { kind: "checkout", value: checkout } : { kind: "directory", value: workspace.path };
};

/** The root of the innermost repository holding `path` (a worktree's own, a submodule's), found from `path` up: where its `.git` lies; null when none does. */
export const repositoryRoot = (path: string): string | null => {
  for (let directory = path; ; directory = dirname(directory)) {
    try {
      const stats = statSync(join(directory, DOT_GIT));
      if (stats.isDirectory() || stats.isFile()) return directory;
    } catch {
      // Not here: look in the parent.
    }
    if (dirname(directory) === directory) return null;
  }
};
