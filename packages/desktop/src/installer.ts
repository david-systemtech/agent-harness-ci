import { readFile, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { ShellBundledServer, ShellInstaller } from "@agent-harness/client-runtime";
import { ARTEFACT_CLI_PACKAGE, INSTALL_RESERVE_BYTES, RELEASE_VERSION_PATTERN } from "@agent-harness/contracts/launcher";

/**
 * The shell's `installer` (launcher-update spec, "The desktop moves with its
 * local environment"): the server artefact the desktop carries, unpacked,
 * where the shell's `service` runs its verbs from. The runtime hands it to
 * the local environment when it is newer, so nothing downloads twice.
 */

/** The installer of a desktop carrying the artefact at `server`; build-time inspection needs no environment directory. */
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
    return { version, path: server };
  },
});
