import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ContainmentResolution } from "@agent-harness/contracts";
import type { RunContainment } from "../adapter/contract.js";

/**
 * Where a contained run may write beside its workspace (permissions spec,
 * "Containment": "its workspace, the session's scratch directory and a
 * temporary directory of its own"): per session, under one root, a
 * `scratch` directory that lives with the session and a `tmp` directory the
 * provider is handed as its temporary directory. The temporary directory is
 * the session's runs' rather than each run's: a session's runs share its
 * provider process (ADR 0015), whose environment is fixed when it starts,
 * and one per run would mean a cold start for every run. Both are made,
 * owner-only, when a run starts at a workspace level, and removed when the
 * session is purged.
 */

export interface SessionDirectories {
  readonly scratchDirectory: string;
  readonly temporaryDirectory: string;
}

export interface ContainmentDirectories {
  /** The session's directories, named; nothing is made. */
  of(sessionId: string): SessionDirectories;
  /** Makes the session's directories if they are not there. */
  make(sessionId: string): void;
  /** Removes the session's directories and what is in them; nothing when they are not there. */
  remove(sessionId: string): void;
}

/** The environment's directory for them, under its data directory. */
export const CONTAINMENT_DIRECTORY = "containment";

export const containmentDirectories = (root: string): ContainmentDirectories => {
  const of = (sessionId: string): SessionDirectories => {
    // A session id is a UUID the wire checked; the name is never a path of the client's choosing.
    const session = join(root, sessionId.toLowerCase());
    return { scratchDirectory: join(session, "scratch"), temporaryDirectory: join(session, "tmp") };
  };
  return {
    of,
    make(sessionId) {
      const { scratchDirectory, temporaryDirectory } = of(sessionId);
      mkdirSync(scratchDirectory, { recursive: true, mode: 0o700 });
      mkdirSync(temporaryDirectory, { recursive: true, mode: 0o700 });
    },
    remove(sessionId) {
      rmSync(join(root, sessionId.toLowerCase()), { recursive: true, force: true });
    },
  };
};

/** A run's containment as its adapter is handed it: the resolved level and mechanism, and where it may write. */
export const runContainment = (resolution: ContainmentResolution, workspace: string, directories: SessionDirectories): RunContainment => ({
  level: resolution.effective,
  mechanism: resolution.mechanism,
  scratchDirectory: directories.scratchDirectory,
  temporaryDirectory: directories.temporaryDirectory,
  writable: [workspace, directories.scratchDirectory, directories.temporaryDirectory],
  network: resolution.effective !== "workspace-no-network",
});
