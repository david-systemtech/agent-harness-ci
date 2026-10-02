import { removeTree } from "../serve/remove-tree.js";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PORT_FILE_NAME, type PortFile } from "@agent-harness/contracts";

/**
 * The extension's folder (browser spec, "The extension, its folder and its
 * listener"; ADR 0024): the built extension the environment carries, copied
 * to `extension/current` in its data directory, the folder Chrome loads
 * unpacked. It is copied when the folder is absent or holds another version,
 * into a staging folder beside it that is then renamed into place, so the
 * path Chrome loads never holds a mix of two versions: a new harness version
 * replaces it whole as it starts, and Chrome needs only Reload. A folder of
 * the shipped version is left as it is. The port file is written into it,
 * and into a staging folder before its rename, whenever the listener is
 * bound; with no listener none is left there.
 */

/** Where the extension's folders live in the data directory. */
export const EXTENSION_DIRECTORY = "extension";

/** The folder Chrome loads, in `EXTENSION_DIRECTORY`. */
export const CURRENT_FOLDER = "current";

/** What a staging folder and a replaced folder are named before the rename, and left as by a stop between the two. */
const STAGING_PREFIX = ".staging-";
const REPLACED_PREFIX = ".replaced-";

/**
 * A built extension's version: its manifest's version name, which is the
 * harness version it was built with (Chrome's own version field takes only
 * dotted numbers). Undefined when the folder holds no manifest that names one.
 */
export const versionOf = async (folder: string): Promise<string | undefined> => {
  let text: string;
  try {
    text = await readFile(join(folder, "manifest.json"), "utf8");
  } catch {
    return undefined;
  }
  try {
    const manifest: unknown = JSON.parse(text);
    const name = typeof manifest === "object" && manifest !== null ? (manifest as { version_name?: unknown }).version_name : undefined;
    return typeof name === "string" && name !== "" ? name : undefined;
  } catch {
    return undefined;
  }
};

/** How the folder stands after a look: the version shipped, and why the folder does not hold it, if it does not. */
export interface FolderState {
  readonly shippedVersion: string | null;
  readonly problem: string | null;
}

export interface ExtensionFolder {
  /** The folder Chrome loads. */
  readonly path: string;
  /**
   * Makes the folder hold the shipped extension when it is absent or holds
   * another version, then writes `portFile` into it, or removes the port
   * file when there is none. One at a time; never rejects.
   */
  ensure(portFile: PortFile | null): Promise<FolderState>;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Writes the port file, when it does not already say this, through a file
 * of its own renamed over it, so the extension never reads half of one.
 */
const writePortFile = async (folder: string, portFile: PortFile | null): Promise<void> => {
  const path = join(folder, PORT_FILE_NAME);
  if (portFile === null) {
    await rm(path, { force: true });
    return;
  }
  const text = `${JSON.stringify(portFile, null, 2)}\n`;
  if ((await readFile(path, "utf8").catch(() => undefined)) === text) return;
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};

/**
 * The extension's folder in `dataDir`, filled from `source`, the built
 * extension the environment carries.
 */
export const extensionFolder = (options: { readonly dataDir: string; readonly source: string }): ExtensionFolder => {
  const directory = join(options.dataDir, EXTENSION_DIRECTORY);
  const path = join(directory, CURRENT_FOLDER);
  let swept = false;
  let queue: Promise<unknown> = Promise.resolve();

  /** Removes what a stop between a copy and its rename left: a staging folder, or a replaced one. */
  const sweep = async (): Promise<void> => {
    const entries = await readdir(directory).catch(() => [] as string[]);
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith(STAGING_PREFIX) || entry.startsWith(REPLACED_PREFIX))
        .map((entry) => removeTree(join(directory, entry))),
    );
  };

  /** Copies `source` into a staging folder with the port file, and renames it into place over the folder there. */
  const replace = async (portFile: PortFile | null): Promise<void> => {
    const staging = join(directory, `${STAGING_PREFIX}${randomUUID()}`);
    const replaced = join(directory, `${REPLACED_PREFIX}${randomUUID()}`);
    try {
      await cp(options.source, staging, { recursive: true, errorOnExist: true, force: false });
      await writePortFile(staging, portFile);
      const moved = await rename(path, replaced).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
      try {
        await rename(staging, path);
      } catch (error) {
        // The folder that was there goes back, whole, rather than leaving Chrome none; if even that fails, the next start's sweep removes it.
        if (moved) await rename(replaced, path).catch(() => undefined);
        throw error;
      }
      if (moved) await removeTree(replaced);
    } finally {
      await removeTree(staging);
    }
  };

  const look = async (portFile: PortFile | null): Promise<FolderState> => {
    await mkdir(directory, { recursive: true });
    if (!swept) {
      swept = true;
      await sweep();
    }
    const shipped = await versionOf(options.source);
    if (shipped === undefined) {
      // A folder an earlier start made still names this start's port, if there is one.
      if ((await versionOf(path)) !== undefined) await writePortFile(path, portFile).catch(() => undefined);
      return { shippedVersion: null, problem: `This environment carries no built extension: ${options.source} holds no manifest with a version name.` };
    }
    try {
      if ((await versionOf(path)) === shipped) await writePortFile(path, portFile);
      else await replace(portFile);
    } catch (error) {
      return { shippedVersion: shipped, problem: `The extension's folder could not be made: ${messageOf(error)}` };
    }
    return { shippedVersion: shipped, problem: null };
  };

  return {
    path,
    ensure(portFile) {
      const next = queue.then(() =>
        look(portFile).catch((error: unknown) => ({ shippedVersion: null, problem: `The extension's folder could not be read: ${messageOf(error)}` })),
      );
      queue = next;
      return next;
    },
  };
};
