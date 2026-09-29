import { existsSync } from "node:fs";
import { loadSqlite } from "./sqlite.js";

/** SQLite's primary result codes for a lock another connection holds. */
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

/** The database, taken by this process alone until it lets go. */
export interface DatabaseHold {
  /** Closes the connection that holds it, which checkpoints the WAL into the main file, as the last connection to close does. */
  release(): void;
}

/** What letting go of nothing takes: there was no connection to close. */
const NOTHING_HELD: DatabaseHold = { release: () => undefined };

/** Whether `error` is SQLite refusing a lock another connection holds, extended codes included. */
const isLockRefused = (error: unknown): boolean => {
  const code = (error as { errcode?: unknown }).errcode;
  return typeof code === "number" && [SQLITE_BUSY, SQLITE_LOCKED].includes(code & 0xff);
};

/**
 * Takes the database at `path` for this process alone, unless a connection
 * holds it (#349): what the container's `update` verbs do before they copy
 * its files, from a process of their own, perhaps in another container on
 * the same volume. A connection to a database in WAL mode, as the event
 * log's is, keeps a shared lock on its file from its first read until it
 * closes, so a connection asking for the exclusive lock without waiting is
 * refused while any other is open, in this process or another: that is
 * `held`. Otherwise the answer holds the database until it is released,
 * having changed none of its files (a WAL is made, empty, where there was
 * none), so a copy taken meanwhile is the database as it was left.
 *
 * With no file at `path`, nothing holds it. A failure other than the lock
 * refused says nothing of other connections (a database a restore cut short
 * left torn cannot be read at all), so the connection is closed and nothing
 * is held.
 */
export const holdDatabase = (path: string): DatabaseHold | "held" => {
  if (!existsSync(path)) return NOTHING_HELD;
  const db = new (loadSqlite().DatabaseSync)(path, { timeout: 0 });
  try {
    // In exclusive locking mode the lock the transaction takes is kept until the connection closes.
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    db.exec("BEGIN EXCLUSIVE");
    db.exec("ROLLBACK");
  } catch (error) {
    db.close();
    return isLockRefused(error) ? "held" : NOTHING_HELD;
  }
  return { release: () => db.close() };
};
