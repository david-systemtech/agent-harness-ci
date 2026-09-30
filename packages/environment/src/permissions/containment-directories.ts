import { mkdirSync, mkdtempSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
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
    remove: (sessionId) => rm(sessionDir(sessionId), { recursive: true, force: true }),
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
      for (const name of gone) await rm(join(rootOf(), name), { recursive: true, force: true });
      return gone;
    },
    async close() {
      if (owned && resolved !== undefined) await rm(resolved, { recursive: true, force: true });
    },
  };
};

/** The adapter host's preset: a root of its own made with `mkdtemp` on first use, removed when the host closes. */
export const temporaryContainmentDirectories = (): ContainmentDirectories =>
  containmentDirectories(() => mkdtempSync(join(tmpdir(), "agent-harness-containment-")), true);

/**
 * The repository's git directory when it lies outside `workspace`
 * (workspace-picker spec, "Containment's workspace level"; #322): a
 * worktree's objects, refs and index live in its repository's common git
 * directory (its main checkout's `.git`, or its bare repository), and a
 * directory below a repository's root has the repository's `.git` above
 * it, so a run contained to either could edit but never commit. Null for a
 * checkout root, whose `.git` is inside it, and for a directory in no
 * repository. Read from the files git keeps, so nothing the repository's
 * config names runs.
 */
const gitDirectoryOutside = (workspace: string): string | null => {
  const found = commonGitDirectory(workspace);
  if (found === null) return null;
  const gitDirectory = resolve(found);
  return isInside(resolve(workspace), gitDirectory) ? null : gitDirectory;
};

/**
 * A run's containment as its adapter is handed it: the resolved level and
 * mechanism, and where it may write, read as the run starts. At a workspace
 * level that is the workspace (always first), the scratch directory and the
 * temporary directory, and then the repository's git directory when it lies
 * outside the workspace; at `off`, where nothing applies, only the first three.
 */
export const runContainment = (resolution: ContainmentResolution, workspace: string, directories: SessionDirectories): RunContainment => {
  const gitDirectory = resolution.effective === "off" ? null : gitDirectoryOutside(workspace);
  return {
    level: resolution.effective,
    mechanism: resolution.mechanism,
    scratchDirectory: directories.scratchDirectory,
    temporaryDirectory: directories.temporaryDirectory,
    writable: [workspace, directories.scratchDirectory, directories.temporaryDirectory, ...(gitDirectory === null ? [] : [gitDirectory])],
    network: resolution.effective !== "workspace-no-network",
  };
};
