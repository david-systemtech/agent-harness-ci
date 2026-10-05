import { CopySpaceError, requireCopyRoom } from "@agent-harness/filesystem";
import { readFile, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { ShellBundledServer, ShellInstaller } from "@agent-harness/client-runtime";
import { ARTEFACT_CLI_PACKAGE, compareReleaseVersions, DATABASE_FILE, INSTALL_RESERVE_BYTES, RELEASE_VERSION_PATTERN } from "@agent-harness/contracts/launcher";

/**
 * The shell's `installer` (launcher-update spec, "The desktop moves with its
 * local environment"): the server artefact the desktop carries, unpacked,
 * where the shell's `service` runs its verbs from. The runtime hands it to
 * the local environment when it is newer, so nothing downloads twice.
 */

/** The installer of a desktop carrying the artefact unpacked at `server`; one carrying none (`undefined`) answers null. */
export const bundledInstaller = (server: string | undefined, environmentDir?: string): ShellInstaller => ({
  async reserveSpace() {
    if (environmentDir === undefined) throw new Error("No local environment data directory is configured.");
    const { bavail, bsize } = await statfs(environmentDir);
    return { availableBytes: bavail * bsize, requiredBytes: INSTALL_RESERVE_BYTES };
  },
  async bundledServer(): Promise<ShellBundledServer | null> {
    if (server === undefined) return null;
    const file = join(server, ...ARTEFACT_CLI_PACKAGE);
    const declared = await readFile(file, "utf8")
      .then((text) => JSON.parse(text) as unknown)
      .catch(() => undefined);
    const version = typeof declared === "object" && declared !== null ? (declared as { readonly version?: unknown }).version : undefined;
    if (typeof version !== "string" || !RELEASE_VERSION_PATTERN.test(version)) throw new Error(`The server artefact this desktop carries names no release version in ${file}.`);
    const state = environmentDir === undefined ? undefined : await readFile(join(environmentDir, "service-state.json"), "utf8")
      .then((text) => JSON.parse(text) as { activeVersion?: unknown }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return undefined;
      });
    const active = state?.activeVersion;
    // Older running releases cannot budget their bundled copy; the new desktop must do so before handoff.
    if (environmentDir !== undefined && state !== undefined && (typeof active !== "string" || !RELEASE_VERSION_PATTERN.test(active) || compareReleaseVersions(version, active) > 0)) {
      try {
        requireCopyRoom(server, environmentDir, DATABASE_FILE, INSTALL_RESERVE_BYTES);
      } catch (error) {
        if (!(error instanceof CopySpaceError)) throw error;
        return { version, path: server, refusal: { reason: "disk", message: error.message } };
      }
    }
    return { version, path: server };
  },
});
