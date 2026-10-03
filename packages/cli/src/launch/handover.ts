import * as nodeFs from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RELEASE_VERSION_PATTERN } from "@agent-harness/contracts/launcher";
import { syncDirectory, writeFileDurably, type DurableFs } from "./durable.js";

/**
 * The handover's files in the data directory (launcher-update spec,
 * "Handover"): how the launcher is replaced only by a launcher whose version
 * has proved itself. A launcher hands over by writing the handover record,
 * naming itself and the launcher it hands over to, then the launcher version
 * file, and exiting with the relaunch code. The launcher entry counts each
 * start of the launcher handed over to in its start counter until that
 * launcher confirms its child passed the gate, which removes both files;
 * once the count reaches `UNCONFIRMED_STARTS`, the entry names the launcher
 * that handed over again, which finds the record naming itself and records
 * the handover failed. Both files are one version or number a line, as the
 * entry's shell and batch file read them.
 */

/** The handover record's file: the version whose launcher handed over, then the version whose launcher it handed over to, one a line. */
export const HANDOVER_FILE = "launcher-handover";

/** The launcher entry's start counter: how often it has started the launcher handed over to, one number and a line ending (CRLF on Windows, LF elsewhere). */
export const HANDOVER_STARTS_FILE = "launcher-handover-starts";

/** How many starts of a launcher handed over to go unconfirmed before the launcher entry names the launcher that handed over again. */
export const UNCONFIRMED_STARTS = 3;

/** A handover under way: from the launcher of one version to that of another. */
export interface Handover {
  readonly fromVersion: string;
  readonly toVersion: string;
}

/** The handover record in `dataDir`, or undefined when there is none, or none that names two versions. */
export const readHandover = (dataDir: string): Handover | undefined => {
  let lines: string[];
  try {
    lines = readFileSync(join(dataDir, HANDOVER_FILE), "utf8").split(/\r?\n/);
  } catch {
    return undefined;
  }
  const [fromVersion = "", toVersion = ""] = lines;
  return RELEASE_VERSION_PATTERN.test(fromVersion) && RELEASE_VERSION_PATTERN.test(toVersion) ? { fromVersion, toVersion } : undefined;
};

/** Writes `handover` as the handover record in `dataDir`, durably, after removing a start counter an earlier handover left, so its count starts again. */
export const writeHandover = (dataDir: string, { fromVersion, toVersion }: Handover, fs: DurableFs = nodeFs, platform: NodeJS.Platform = process.platform): void => {
  fs.rmSync(join(dataDir, HANDOVER_STARTS_FILE), { force: true });
  const end = platform === "win32" ? "\r\n" : "\n";
  writeFileDurably(join(dataDir, HANDOVER_FILE), `${fromVersion}${end}${toVersion}${end}`, fs, platform);
};

/** Removes the handover record and then the start counter from `dataDir`, durably: the launcher entry stops counting. */
export const clearHandover = (dataDir: string, fs: DurableFs = nodeFs): void => {
  fs.rmSync(join(dataDir, HANDOVER_FILE), { force: true });
  fs.rmSync(join(dataDir, HANDOVER_STARTS_FILE), { force: true });
  syncDirectory(dataDir, fs);
};
