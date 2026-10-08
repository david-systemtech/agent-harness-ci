import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { syncDirectory, syncFile, writeFileDurably, type DurableFs } from "./durable.js";
import { heldOnWindows, MOVE_RETRY_FIRST_WAIT_MS, MOVE_RETRY_LONGEST_WAIT_MS, MOVE_RETRY_MS } from "./install.js";
import { versionDirectory, versionNode } from "./versions.js";

/**
 * The Node the launcher runs a version's `serve` on (#1910). `serve` listens
 * beyond loopback, on the tailnet and LAN addresses, and Windows Defender
 * Firewall keys its allow or block on the listening program's path: a Node
 * in the version's own folder was a new program to it at every update, which
 * raised its prompt again, unattended, and left two more rules each time. So
 * on Windows the launcher runs one copy of the version's Node, in the data
 * directory's `node` folder, at a path no update changes, and copies the
 * version's Node over it before it spawns a version whose Node it does not
 * hold. Only one child runs at a time, so nothing runs from the copy while it
 * is replaced. Windows may still hold the copy a moment after the child
 * running it exits, or an on-access scan the file just written, so the
 * launcher tries again while it is held, as an install's move does
 * (`waitForHeldCopy`). Elsewhere, and whenever the copy cannot be made, the
 * version's own Node runs, as before.
 */

/** The data directory's folder holding the copy. */
export const SERVE_NODE_DIRECTORY = "node";

/**
 * The file beside the copy that names the version whose Node it is. It is
 * removed before the copy is replaced and written after, so it never names
 * a copy it is not.
 */
export const SERVE_NODE_SOURCE_FILE = "version";

/** What a copy cut short leaves in the folder: dot-led, so it is never the copy. */
const PARTIAL = /^\..+\.partial$/;

/** The Node to spawn a version's `serve` on. */
export interface ServeNode {
  readonly node: string;
  /** Why the version's own Node runs in place of the copy, when the copy could not be made. */
  readonly problem?: string;
  /** Whether the copy failed because Windows still held a file of it (`heldOnWindows`), which waiting may end. */
  readonly held?: true;
}

/**
 * How long to wait before the copy is tried again after a hold, when
 * `waited` ms went on such waits already: doubling from
 * `MOVE_RETRY_FIRST_WAIT_MS` up to `MOVE_RETRY_LONGEST_WAIT_MS`, as an
 * install's move does; none once the waits would pass `MOVE_RETRY_MS`.
 */
export const waitForHeldCopy = (waited: number): number | undefined => {
  const wait = Math.min(MOVE_RETRY_FIRST_WAIT_MS + waited, MOVE_RETRY_LONGEST_WAIT_MS);
  return waited + wait > MOVE_RETRY_MS ? undefined : wait;
};

const readSource = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** Removes, ignoring what is not there, whatever a copy cut short by a crash or a kill left in `folder`. */
const clearPartials = (folder: string, fs: DurableFs): void => {
  for (const name of readdirSync(folder)) if (PARTIAL.test(name)) fs.rmSync(join(folder, name), { force: true });
};

/** The Node `version`'s `serve` runs on in `dataDir` on `platform`: on Windows the copy, made the version's first; elsewhere the version's own. */
export const serveNode = (dataDir: string, version: string, platform: NodeJS.Platform = process.platform, fs: DurableFs = nodeFs): ServeNode => {
  const own = join(versionDirectory(dataDir, version), ...versionNode(platform));
  if (platform !== "win32") return { node: own };
  const folder = join(dataDir, SERVE_NODE_DIRECTORY);
  const copy = join(folder, basename(own));
  const source = join(folder, SERVE_NODE_SOURCE_FILE);
  if (readSource(source) === version && existsSync(copy)) return { node: copy };
  const partial = join(folder, `.${basename(own)}.${randomUUID()}.partial`);
  try {
    mkdirSync(folder, { recursive: true });
    clearPartials(folder, fs);
    fs.rmSync(source, { force: true });
    syncDirectory(folder, fs, platform);
    copyFileSync(own, partial);
    syncFile(partial, fs, platform);
    fs.renameSync(partial, copy);
    syncDirectory(folder, fs, platform);
    writeFileDurably(source, version, fs, platform);
    return { node: copy };
  } catch (error) {
    try {
      fs.rmSync(partial, { force: true });
    } catch {
      // Held too, as by the scan that held its rename: the next try's `clearPartials` removes it.
    }
    return { node: own, problem: error instanceof Error ? error.message : String(error), ...(heldOnWindows(error, platform) && { held: true as const }) };
  }
};
