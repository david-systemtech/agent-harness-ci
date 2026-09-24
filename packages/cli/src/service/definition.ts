import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { prepareDataDirectory } from "@agent-harness/environment";
import { LOG_DIRECTORY, type ServiceSpec } from "./spec.js";

/** The data directory, readable by its owner alone, and the log folder under it. */
export const prepareServiceDirectories = (spec: ServiceSpec): void => {
  prepareDataDirectory(spec.dataDir);
  mkdirSync(join(spec.dataDir, LOG_DIRECTORY), { recursive: true });
};

/**
 * Writes a definition file, creating its folder, and returns what undoes the
 * write: the previous content put back, or the file removed if there was none.
 */
export const writeDefinition = (path: string, content: string): (() => void) => {
  let previous: string | undefined;
  try {
    previous = readFileSync(path, "utf8");
  } catch {
    previous = undefined;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return () => {
    if (previous === undefined) rmSync(path, { force: true });
    else writeFileSync(path, previous);
  };
};

/** Runs `register` after writing the definition, and undoes the write when it throws. */
export const installDefinition = async (path: string, content: string, register: () => Promise<void>): Promise<void> => {
  const undo = writeDefinition(path, content);
  try {
    await register();
  } catch (error) {
    undo();
    throw error;
  }
};
