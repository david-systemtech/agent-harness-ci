import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { removeTree } from "@agent-harness/filesystem";

/**
 * Per-test cleanup for a test file: `onCleanup` queues work that runs after
 * each test, newest first, awaited; `tempDir` makes a directory removed the
 * same way. Call once at the top of a test file.
 */
export const useCleanups = () => {
  let cleanups: (() => void | Promise<void>)[] = [];
  afterEach(async () => {
    const pending = cleanups.reverse();
    cleanups = [];
    // Every cleanup runs even when one throws, so a failed removal leaks nothing else.
    const failures: unknown[] = [];
    for (const cleanup of pending) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `${failures.length} cleanups failed.`);
  });
  const onCleanup = (cleanup: () => void | Promise<void>): void => void cleanups.push(cleanup);
  const tempDir = (prefix = "agent-harness-test-"): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    onCleanup(() => removeTree(dir));
    return dir;
  };
  return { onCleanup, tempDir };
};
