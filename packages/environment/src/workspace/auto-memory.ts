import { readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Workspace } from "@agent-harness/contracts";
import { carryMemory } from "./carry-memory.js";
import { hashedName } from "./directory-names.js";

/**
 * Auto memory's key (workspace-picker spec, "Repository identity", Auto
 * memory; ADR 0018; #121's key, refined by #329): the environment keeps one
 * auto-memory directory per key under `<data dir>/auto-memory/`, which every
 * account's runs share. The key is the session's repository identity; else
 * its repository's main checkout, so the worktrees of a repository with no
 * remote share one directory, as Claude Code keys memory by repository;
 * else, for a scratch workspace, one directory every scratch workspace
 * shares; else the workspace path.
 *
 * When a session's key changes (an identity pass gives it an identity or
 * moves its host, #329; `sessions.setWorkspace` gives it a new workspace,
 * #328), its old directory is copied into the new one by ADR 0021's
 * carry-over rule (`carry-memory.ts`) and left where it is.
 */

/** A session's place, as the key reads it. */
export interface MemoryPlace {
  readonly workspace: Workspace;
  readonly repositoryIdentity: string | null;
}

/** The auto-memory directory every scratch workspace shares, under the root: never a name `hashedName` gives, which ends in a hash. */
export const SCRATCH_MEMORY_DIRECTORY = "scratch";

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

/**
 * The main checkout (or bare repository) of the repository holding
 * `workspace`, or null for none: a worktree's recorded repository; for a
 * directory, the innermost repository found from its path up, read from the
 * files git keeps (no git runs), a linked worktree's main checkout for one
 * of its worktrees; none for a scratch workspace, in which nothing is a
 * checkout. The trust gate's key (#500) reads the same derivation.
 */
export const mainCheckout = (workspace: Workspace): string | null => {
  if (workspace.kind === "worktree") return workspace.repository;
  if (workspace.kind === "scratch") return null;
  for (let directory = workspace.path; ; directory = dirname(directory)) {
    const checkout = checkoutAt(directory);
    if (checkout !== undefined) return checkout;
    if (dirname(directory) === directory) return null;
  }
};

/** A place's key: its identity, else its main checkout, else its workspace path; null for a scratch workspace, which shares one directory. */
const keyOf = (place: MemoryPlace): string | null =>
  place.repositoryIdentity ?? (place.workspace.kind === "scratch" ? null : (mainCheckout(place.workspace) ?? place.workspace.path));

/** The name of `place`'s auto-memory directory under the root: named for a person reading the directory, and hashed so two keys never share one. */
export const autoMemoryName = (place: MemoryPlace): string => {
  const key = keyOf(place);
  return key === null ? SCRATCH_MEMORY_DIRECTORY : hashedName(key, key, "workspace");
};

export interface AutoMemory {
  /**
   * A session's key changed from `before` to `after`: the old key's
   * directory is copied into the new key's by the carry-over rule, and
   * stays. Carries run one at a time, in the order asked, so two for one
   * key never interleave; one that fails is said and never rejects. Settles
   * once this one has run.
   */
  carry(before: MemoryPlace, after: MemoryPlace): Promise<void>;
}

/** The environment's auto memory, whose directories live under `root` (`<data dir>/auto-memory`). */
export const createAutoMemory = (root: string): AutoMemory => {
  let queue: Promise<void> = Promise.resolve();
  const carryNow = async (before: MemoryPlace, after: MemoryPlace): Promise<void> => {
    const [from, to] = [autoMemoryName(before), autoMemoryName(after)];
    if (from === to) return;
    await carryMemory({ directory: join(root, from), name: from, label: keyOf(before) ?? "the scratch workspaces" }, join(root, to));
  };
  return {
    carry: (before, after) => {
      queue = queue.then(() =>
        carryNow(before, after).catch((error: unknown) => console.error("Copying a session's auto memory to its new key failed; the old directory stays:", error)),
      );
      return queue;
    },
  };
};
