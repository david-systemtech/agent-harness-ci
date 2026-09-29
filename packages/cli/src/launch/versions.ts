import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ARTEFACT_CLI_ENTRY, artefactNode, RELEASE_VERSION_PATTERN } from "@agent-harness/contracts/launcher";

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

/** Whether `version` is complete in the versions directory: it is a version, which is all a folder there is named by, and its folder holds the sentinel. */
export const isComplete = (dataDir: string, version: string): boolean =>
  RELEASE_VERSION_PATTERN.test(version) && existsSync(join(versionDirectory(dataDir, version), VERSION_SENTINEL));

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

/** Where a version's own Node runtime is in its folder: the server artefact's (`artefactNode`), which a version is unpacked from. */
export const versionNode = (platform: NodeJS.Platform): readonly string[] => artefactNode(platform);

/** Where a version's CLI entry is in its folder: the server artefact's. */
export const VERSION_CLI_ENTRY: readonly string[] = ARTEFACT_CLI_ENTRY;

/**
 * The command line that runs the `agent-harness` of the version installed in
 * `versionDir`: the version's own Node runtime (`versionNode`) on its CLI's
 * entry. The launcher runs node directly, never the version's
 * `bin/agent-harness` script, so the IPC channel reaches the CLI on every
 * platform (a Windows command script would stand between them).
 */
export const versionCommand = (versionDir: string, platform: NodeJS.Platform = process.platform): readonly [node: string, entry: string] => [
  join(versionDir, ...versionNode(platform)),
  join(versionDir, ...VERSION_CLI_ENTRY),
];
