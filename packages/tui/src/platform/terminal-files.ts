import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensurePrivateDirectory } from "./files.js";

/** SQLite's process-safe write lock also owns recovery, including every ordinary writer. */
export const TERMINAL_JOURNAL = "terminal-state.sqlite";
export interface TerminalWrite { readonly path: string; readonly text: string }
/** Filesystem/crash injection at the durable batch boundary; production uses the defaults. */
export interface TerminalCommitFaults {
  readonly beforeCommit?: () => void;
  readonly afterCommit?: () => void;
  readonly write?: (path: string, text: string) => void;
  readonly rename?: (from: string, to: string) => void;
  readonly afterInstall?: (path: string) => void;
}
export interface TerminalFiles {
  read(path: string): string | undefined;
  write(path: string, text: string): void;
  delete(path: string): void;
  /** The journal commit is the point of no return. Failure afterwards is recovered before the next read/write. */
  commit(writes: readonly TerminalWrite[], faults?: TerminalCommitFaults): void;
}

let sequence = 0;
const install = (path: string, text: string, faults: TerminalCommitFaults = {}): void => {
  ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${++sequence}.tmp`;
  try {
    if (faults.write) faults.write(temporary, text);
    else writeFileSync(temporary, text, { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(temporary, 0o600);
    // Windows requires write access for FlushFileBuffers (fsync).
    const fd = openSync(temporary, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    (faults.rename ?? renameSync)(temporary, path);
    // Persist the rename too, before retiring the recovery journal.
    if (process.platform !== "win32") {
      const directory = openSync(dirname(path), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
    faults.afterInstall?.(path);
  } finally { rmSync(temporary, { force: true }); }
};

/** No caller can load partially installed data: journal replay runs inside the same lock first. */
export const withTerminalFiles = <T>(dir: string, work: (files: TerminalFiles) => T): T => {
  ensurePrivateDirectory(dir);
  const path = join(dir, TERMINAL_JOURNAL);
  // Create privately before SQLite opens it (its own default mode follows the process umask).
  const fd = openSync(path, "a", 0o600);
  closeSync(fd);
  if (process.platform !== "win32") chmodSync(path, 0o600);
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; BEGIN IMMEDIATE");
    db.exec("CREATE TABLE IF NOT EXISTS recovery (id INTEGER PRIMARY KEY CHECK (id = 1), writes TEXT NOT NULL)");
    const replay = (faults?: TerminalCommitFaults): void => {
      const row = db.prepare("SELECT writes FROM recovery WHERE id = 1").get();
      if (!row) return;
      const writes = JSON.parse(String(row["writes"])) as TerminalWrite[];
      for (const write of writes) install(write.path, write.text, faults);
      db.exec("DELETE FROM recovery WHERE id = 1");
    };
    try { replay(); } catch { throw new Error("Terminal persistence recovery failed; local data has not been loaded."); }
    const result = work({
      read: (file) => {
        try { return readFileSync(file, "utf8"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
      },
      write: (file, text) => install(file, text),
      delete: (file) => rmSync(file, { force: true }),
      commit: (writes, faults = {}) => {
        db.prepare("INSERT INTO recovery (id, writes) VALUES (1, ?)").run(JSON.stringify(writes.map((write) => ({ path: resolve(write.path), text: write.text }))));
        faults.beforeCommit?.();
        db.exec("COMMIT");
        faults.afterCommit?.();
        db.exec("BEGIN IMMEDIATE");
        // Another writer may have recovered the committed snapshot while this lock was released.
        replay(faults);
      },
    });
    db.exec("COMMIT");
    return result;
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
  }
};

/** Missing/unreadable individual stores retain their tolerant parsing; recovery itself never does. */
export const readTerminalText = (path: string): string | undefined => {
  try { return withTerminalFiles(dirname(path), (files) => files.read(path)); }
  catch (error) {
    if (["ENOENT", "ENOTDIR", "EISDIR", "EACCES", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
};
