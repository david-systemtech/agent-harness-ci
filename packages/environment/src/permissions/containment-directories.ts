import { removeTree } from "../serve/remove-tree.js";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ContainmentResolution } from "@agent-harness/contracts";
import type { RunContainment } from "../adapter/contract.js";
import { isInside } from "../workspace/paths.js";
import { commonGitDirectory } from "../workspace/repository-key.js";

/**
 * Where a contained run may write beside its workspace (permissions spec,
 * "Containment": "its workspace, the session's scratch directory and a
 * temporary directory"): per session, under one root, a `scratch` directory
 * that lives with the session and a `tmp` directory the provider is handed
 * as its temporary directory. The temporary directory is the session's runs'
 * rather than each run's: a session's runs share its provider process (ADR
 * 0015), whose environment is fixed when it starts, and one per run would
 * mean a cold start for every run. Both are made, owner-only, when a run
 * starts at a workspace level, and removed when the session is purged; a
 * sweep at startup removes those of sessions that are gone.
 */

export interface SessionDirectories {
  readonly scratchDirectory: string;
  readonly temporaryDirectory: string;
}

export interface ContainmentDirectories {
  /** The session's directories, named; nothing is made. Throws for an id that is not a session id. */
  of(sessionId: string): SessionDirectories;
  /** Makes the session's directories if they are not there. */
  make(sessionId: string): void;
  /** Removes the session's directories and what is in them; nothing when they are not there. */
  remove(sessionId: string): Promise<void>;
  /** Removes the directories of every session `exists` says is gone; resolves with their ids. Anything not named by a session id is left. */
  sweep(exists: (sessionId: string) => boolean): Promise<string[]>;
  /** Removes the root itself, for a root the directories made (the host's preset); nothing otherwise. */
  close(): Promise<void>;
}

/** The environment's directory for them, under its data directory. */
export const CONTAINMENT_DIRECTORY = "containment";

/** A session id as the wire checks it: a UUID. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The directory name of a session: its id, lower-cased, never a path of anyone's choosing. */
const nameOf = (sessionId: string): string => {
  if (!SESSION_ID.test(sessionId)) throw new Error(`${JSON.stringify(sessionId)} is not a session id, so it names no containment directory.`);
  return sessionId.toLowerCase();
};

/**
 * The directories under `root`: a path, or a function that gives it on
 * first use (the root is made then). `owned` says the root is the
 * directories' own, removed by `close`.
 */
export const containmentDirectories = (root: string | (() => string), owned = false): ContainmentDirectories => {
  let resolved: string | undefined = typeof root === "string" ? root : undefined;
  const rootOf = (): string => (resolved ??= (root as () => string)());
  const sessionDir = (sessionId: string): string => join(rootOf(), nameOf(sessionId));
  return {
    of: (sessionId) => {
      const session = sessionDir(sessionId);
      return { scratchDirectory: join(session, "scratch"), temporaryDirectory: join(session, "tmp") };
    },
    make(sessionId) {
      const session = sessionDir(sessionId);
      mkdirSync(join(session, "scratch"), { recursive: true, mode: 0o700 });
      mkdirSync(join(session, "tmp"), { recursive: true, mode: 0o700 });
    },
    remove: (sessionId) => removeTree(sessionDir(sessionId)),
    async sweep(exists) {
      if (resolved === undefined && typeof root !== "string") return [];
      let names: string[];
      try {
        names = await readdir(rootOf());
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const gone = names.filter((name) => SESSION_ID.test(name) && !exists(name));
      for (const name of gone) await removeTree(join(rootOf(), name));
      return gone;
    },
    async close() {
      if (owned && resolved !== undefined) await removeTree(resolved);
    },
  };
};

/** The adapter host's preset: a root of its own made with `mkdtemp` on first use, removed when the host closes. */
export const temporaryContainmentDirectories = (): ContainmentDirectories =>
  containmentDirectories(() => mkdtempSync(join(tmpdir(), "agent-harness-containment-")), true);

/**
 * The common git directory of the repository holding `workspace` (#322),
 * read from the files git keeps, so nothing the repository's config names
 * runs (`commonGitDirectory`); null for a directory in no repository. A
 * worktree's objects, refs and index live there (its main checkout's
 * `.git`, or its bare repository), a directory below a repository's root
 * has the repository's `.git` above it, and a checkout whose `.git` is a
 * file (a submodule's, or one made with `--separate-git-dir`) keeps it
 * where that file names, its root included.
 */
const gitDirectoryOf = (workspace: string): string | null => {
  const found = commonGitDirectory(workspace);
  return found === null ? null : resolve(found);
};

/** The names of the worktrees the git directory `gitDirectory` records (the directories under its `worktrees`), sorted; none when it records none. */
const worktreeNames = (gitDirectory: string): string[] => {
  try {
    return readdirSync(join(gitDirectory, "worktrees"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
};

/** Whether `path` is a directory itself, not a link to one; false when it is not there or cannot be read. */
const isDirectory = (path: string): boolean => {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** The directories in `directory`, sorted, a link to one left out; none when it cannot be read. */
const subdirectories = (directory: string): string[] => {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
};

/**
 * The git directories of the submodules the git directory `gitDirectory`
 * keeps under its `modules` (#933), as they are now: a directory there
 * with a `HEAD` is one, as git takes it, and so is one with `objects`, so
 * the walk never goes through a damaged one's objects. One with neither is
 * a component of a name (a submodule's name may hold slashes,
 * `modules/vendor/lib`), walked through. git puts no submodule's git
 * directory inside another's (it refuses the name), so the walk stops at
 * one; its own submodules are under its `modules`, found when it is
 * closed. A link is not walked, nor a `modules` that is one: git makes
 * none there, and one a run made could lead the next run's start anywhere
 * on the host.
 */
const submoduleGitDirectories = (gitDirectory: string): string[] => {
  const found: string[] = [];
  const walk = (directory: string): void => {
    if (existsSync(join(directory, "HEAD")) || existsSync(join(directory, "objects"))) found.push(directory);
    else for (const name of subdirectories(directory)) walk(join(directory, name));
  };
  const modules = join(gitDirectory, "modules");
  if (isDirectory(modules)) for (const name of subdirectories(modules)) walk(join(modules, name));
  return found;
};

/**
 * What a run may not write in the git directory `gitDirectory` (#791):
 * where git finds programs to run for the user outside containment. Its
 * `hooks`, its `config` (`core.hooksPath`, `core.fsmonitor`, a filter,
 * `core.sshCommand`), and the per-worktree `config.worktree` git reads once
 * the config sets `extensions.worktreeConfig` (sparse checkout does): the
 * main worktree's beside `config`, each linked worktree's under
 * `worktrees/<name>/`, there or not, so none can be made either. Then the
 * same in each submodule's git directory under its `modules` (#933), whose
 * config the superproject's own `git status` reads as it looks into the
 * submodule, and in theirs in turn, as listed now.
 */
const closedIn = (gitDirectory: string): string[] => [
  join(gitDirectory, "hooks"),
  join(gitDirectory, "config"),
  join(gitDirectory, "config.worktree"),
  ...worktreeNames(gitDirectory).map((name) => join(gitDirectory, "worktrees", name, "config.worktree")),
  ...submoduleGitDirectories(gitDirectory).flatMap(closedIn),
];

/**
 * A run's containment as its adapter is handed it: the resolved level and
 * mechanism, and where it may write, read as the run starts. At a workspace
 * level that is the workspace (always first), the scratch directory and the
 * temporary directory, and then the repository's git directory when it lies
 * outside the workspace (#322: a run contained to a worktree, or to a
 * directory below a repository's root, could edit but never commit
 * without it), less what that git directory names programs in, wherever
 * it lies (#791); at `off`, where nothing applies, only the first three.
 */
export const runContainment = (resolution: ContainmentResolution, workspace: string, directories: SessionDirectories): RunContainment => {
  const gitDirectory = resolution.effective === "off" ? null : gitDirectoryOf(workspace);
  const outside = gitDirectory !== null && !isInside(resolve(workspace), gitDirectory);
  return {
    level: resolution.effective,
    mechanism: resolution.mechanism,
    scratchDirectory: directories.scratchDirectory,
    temporaryDirectory: directories.temporaryDirectory,
    writable: [workspace, directories.scratchDirectory, directories.temporaryDirectory, ...(outside ? [gitDirectory] : [])],
    readOnly: gitDirectory === null ? [] : closedIn(gitDirectory),
    network: resolution.effective !== "workspace-no-network",
  };
};
