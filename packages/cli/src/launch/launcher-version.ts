import { join } from "node:path";
import { writeFileDurably, type DurableFs } from "./durable.js";

/**
 * The launcher version file (launcher-update spec, "Versions and the
 * launcher"): one line in the data directory naming the version whose
 * launcher the launcher entry starts. `service install` writes it when no
 * launcher runs; while the service runs, the launcher writes it at a handover
 * and the entry when it falls back (#341).
 */

/** The launcher version file's name in the data directory. */
export const LAUNCHER_VERSION_FILE = "launcher-version";

/** Writes `version` durably, with CRLF on Windows for the batch entry, LF elsewhere. */
export const writeLauncherVersion = (dataDir: string, version: string, fs?: DurableFs, platform: NodeJS.Platform = process.platform): void =>
  writeFileDurably(join(dataDir, LAUNCHER_VERSION_FILE), `${version}${platform === "win32" ? "\r\n" : "\n"}`, fs, platform);

