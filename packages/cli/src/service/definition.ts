import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { prepareDataDirectory } from "@agent-harness/environment";
import { ServiceError } from "./errors.js";
import { LOG_DIRECTORY, type ServiceSpec } from "./spec.js";

/** The folders from `dir` upwards that do not exist yet, outermost first: what `mkdir -p dir` would create. */
export const missingDirectories = (dir: string): string[] => {
  const missing: string[] = [];
  for (let current = dir; !existsSync(current); current = dirname(current)) {
    missing.unshift(current);
    if (dirname(current) === current) break;
  }
  return missing;
};

/** Removes each folder that is empty, innermost first; a folder with anything in it stays. */
export const removeEmptyDirectories = (dirs: readonly string[]): void => {
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    try {
      rmdirSync(dir);
    } catch {
      // Not empty, already gone, or not ours to remove: it stays.
    }
  }
};

/**
 * Creates the data directory, readable by its owner alone, and its log folder,
 * and returns the folders that did not exist before, outermost first.
 */
export const prepareServiceDirectories = (spec: ServiceSpec): string[] => {
  const created = missingDirectories(join(spec.dataDir, LOG_DIRECTORY));
  prepareDataDirectory(spec.dataDir);
  mkdirSync(join(spec.dataDir, LOG_DIRECTORY), { recursive: true });
  return created;
};

/** A definition file just written, and how to take the write back. */
export interface WrittenDefinition {
  /** The file's content before the write; undefined when there was no file. */
  readonly previous: string | undefined;
  /** The folders the write created above the file, outermost first. */
  readonly createdDirectories: readonly string[];
  /** Puts the previous content back, or removes the file and the folders the write created when there was none. */
  restore(): void;
}

/** How the bytes reach the disk; tests swap in a failing writer. */
export type WriteFile = (path: string, content: string) => void;

/**
 * Writes a definition file, creating its folder. Only a missing file counts
 * as "no previous definition": any other failure to read the existing one
 * fails before anything is written.
 */
export const writeDefinition = (path: string, content: string, write: WriteFile = writeFileSync): WrittenDefinition => {
  let previous: string | undefined;
  try {
    previous = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ServiceError(`Could not read the existing definition at ${path}, so nothing was changed: ${reason}`, { cause: error });
    }
    previous = undefined;
  }
  const createdDirectories = missingDirectories(dirname(path));
  mkdirSync(dirname(path), { recursive: true });
  // Written beside the definition and renamed over it, so a write that fails leaves the previous file whole.
  const replace = (text: string) => {
    const temp = `${path}.${process.pid}.tmp`;
    try {
      write(temp, text);
      renameSync(temp, path);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  };
  try {
    replace(content);
  } catch (error) {
    if (previous === undefined) removeEmptyDirectories(createdDirectories);
    throw error;
  }
  return {
    previous,
    createdDirectories,
    restore: () => {
      if (previous !== undefined) return replace(previous);
      rmSync(path, { force: true });
      removeEmptyDirectories(createdDirectories);
    },
  };
};
