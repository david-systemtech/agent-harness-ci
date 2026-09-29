import { mkdirSync, renameSync, statSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The desktop's log (docs/specs/gui.md, "The desktop platform"): the faults
 * that have no caller to hand them to, one dated entry each in
 * `logs/desktop.log` in the desktop's data directory. The main process
 * reports its own here (a refused told member, a window that failed to
 * load), and the window's: the renderer's platform reports a fault to its
 * console, whose errors the main process hears (`console-message`).
 */

/** A log this large when the desktop starts is set aside as `desktop.log.1`, replacing the one before, so a fault in a loop cannot fill the disk. */
export const LOG_SET_ASIDE_BYTES = 5 * 1024 * 1024;

const LOG_FILE = "desktop.log";

export interface DesktopLog {
  /** Writes `fault` with the time: an error with its stack, anything else as its text. */
  report(fault: unknown): void;
  /** Settles once every entry reported so far is written. */
  flushed(): Promise<void>;
}

export const desktopLog = (dataDir: string, now: () => Date = () => new Date()): DesktopLog => {
  const dir = join(dataDir, "logs");
  const file = join(dir, LOG_FILE);
  try {
    if (statSync(file).size > LOG_SET_ASIDE_BYTES) renameSync(file, `${file}.1`);
  } catch {
    // No log yet.
  }
  let writes: Promise<void> = Promise.resolve();
  return {
    report(fault) {
      const text = fault instanceof Error ? (fault.stack ?? String(fault)) : String(fault);
      const entry = `${now().toISOString()} ${text}\n`;
      writes = writes
        .then(async () => {
          mkdirSync(dir, { recursive: true });
          await appendFile(file, entry);
        })
        // A log that cannot be written leaves the fault on the process's own output.
        .catch(() => console.error(text));
    },
    flushed: () => writes,
  };
};
