import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

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
    for (const cleanup of pending) await cleanup();
  });
  const onCleanup = (cleanup: () => void | Promise<void>): void => void cleanups.push(cleanup);
  const tempDir = (prefix = "agent-harness-test-"): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    onCleanup(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };
  return { onCleanup, tempDir };
};
