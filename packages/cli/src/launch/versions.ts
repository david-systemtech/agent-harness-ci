import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RELEASE_VERSION_PATTERN } from "@agent-harness/contracts/launcher";

/**
 * The versions directory (launcher-update spec, "Versions and the launcher"):
 * one folder in the data directory per installed version, named by the
 * version and holding that version's unpacked server artefact. A folder
 * counts as a version only once its sentinel is there, which whoever puts a
 * version in writes last, so a copy cut short is never run.
 */

/** The versions directory's folder in the data directory. */
export const VERSIONS_DIRECTORY = "versions";

/** The file written last into a version's folder: with it the version is complete. */
export const VERSION_SENTINEL = ".complete";

/** The folder `version` is installed in. */
export const versionDirectory = (dataDir: string, version: string): string => join(dataDir, VERSIONS_DIRECTORY, version);

/** Whether `version` is complete in the versions directory: its folder holds the sentinel. */
export const isComplete = (dataDir: string, version: string): boolean => existsSync(join(versionDirectory(dataDir, version), VERSION_SENTINEL));

/** The versions complete in the versions directory, sorted by their numbers for a stable answer (not by SemVer precedence); none when it does not exist. */
export const completeVersions = (dataDir: string): string[] => {
  let entries;
  try {
    entries = readdirSync(join(dataDir, VERSIONS_DIRECTORY), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && RELEASE_VERSION_PATTERN.test(entry.name) && isComplete(dataDir, entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
};

/**
 * The command line that runs the `agent-harness` of the version installed in
 * `versionDir`: the version's own Node runtime, where Node's archive for the
 * platform puts it once unpacked into the version's `node` folder, on its
 * CLI's entry. The launcher runs node directly, never the version's
 * `bin/agent-harness` script, so the IPC channel reaches the CLI on every
 * platform (a Windows command script would stand between them).
 */
export const versionCommand = (versionDir: string, platform: NodeJS.Platform = process.platform): readonly [node: string, entry: string] => [
  platform === "win32" ? join(versionDir, "node", "node.exe") : join(versionDir, "node", "bin", "node"),
  join(versionDir, "packages", "cli", "dist", "main.js"),
];
