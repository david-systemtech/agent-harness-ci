import { rmSync } from "node:fs";
import { join } from "node:path";
import type { DocumentStore } from "@agent-harness/client-runtime";
import { readTextIfPresent, writePrivateFile } from "./files.js";

/**
 * The runtime's document storage in the terminal UI: one JSON file per key
 * in `dir` (`<state dir>/documents/<key>.json`). The keys are the runtime's
 * own (the saved connections, the client-local preferences, later its
 * caches); the terminal UI adds none, so nothing here is named after a
 * session field (ADR 0003).
 */
export const jsonDocuments = (dir: string): DocumentStore => {
  const pathOf = (key: string) => join(dir, `${encodeURIComponent(key)}.json`);
  return {
    get: async (key) => {
      const text = readTextIfPresent(pathOf(key));
      return text === undefined ? undefined : (JSON.parse(text) as unknown);
    },
    set: async (key, value) => writePrivateFile(pathOf(key), `${JSON.stringify(value)}\n`),
    delete: async (key) => rmSync(pathOf(key), { force: true }),
  };
};
