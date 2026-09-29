import type * as Sqlite from "node:sqlite";
import { LAUNCHER_PROTOCOL, PROTOCOL_VERSION, type PreflightReport } from "@agent-harness/contracts";
import type { CommandRunner } from "../adapters/claude/credentials.js";
import { bundledExecutable } from "../adapters/claude/executable.js";
import { claudeCodeVersionOf } from "../adapters/claude/version.js";
import { applyMigrations, DATABASE_SCHEMA_VERSION } from "../event-log/migrations.js";
import { loadSqlite } from "../event-log/sqlite.js";
import { HARNESS_VERSION } from "../serve/start.js";
import { loadNodePty } from "../terminals/pty.js";

/**
 * A version's preflight (launcher-update spec, "Preflight"; #339): whether
 * this build, on this machine, can load what it needs, asked before the
 * launcher installs it, so only a version that can run is ever switched to.
 * It loads SQLite and migrates a database in memory with this build's
 * migrations, loads `node-pty` (the terminals' native module), and runs the
 * bundled Claude binary's `--version`. It touches no data directory: the
 * environment running beside it holds the database.
 */

/** What a preflight checks: SQLite, `node-pty`, and the bundled Claude binary. */
export type PreflightCheck = "sqlite" | "node-pty" | "claude";

/** A check that failed, and why. */
export interface PreflightFailure {
  readonly check: PreflightCheck;
  readonly message: string;
}

/** The version's report once every check passed, or every check that failed, in the order they ran. */
export type PreflightAnswer = { readonly report: PreflightReport } | { readonly failures: readonly PreflightFailure[] };

/** What a preflight loads and runs; seams for tests. */
export interface PreflightSeams {
  /** Preset: the event log's loader of `node:sqlite`. */
  readonly loadSqlite?: () => typeof Sqlite;
  /** Preset: the terminals' loader of `node-pty`, which throws naming why it did not load. */
  readonly loadPty?: () => unknown;
  /** The bundled Claude binary; null when this platform has none. Preset: the SDK's for this platform. */
  readonly claudeExecutable?: string | null;
  /** Preset: a spawn with no shell, killed at `--version`'s timeout. */
  readonly runClaude?: CommandRunner;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Loads SQLite and migrates a database in memory: undefined when both work, else why not. */
const checkSqlite = (load: () => typeof Sqlite): string | undefined => {
  let db: Sqlite.DatabaseSync;
  try {
    db = new (load().DatabaseSync)(":memory:");
  } catch (error) {
    return `SQLite did not load: ${messageOf(error)}`;
  }
  try {
    applyMigrations(db);
    return undefined;
  } catch (error) {
    return `SQLite could not take this version's migrations: ${messageOf(error)}`;
  } finally {
    db.close();
  }
};

/** Runs every check, and answers the version's report when all of them passed, else each that failed. */
export const preflight = async (seams: PreflightSeams = {}): Promise<PreflightAnswer> => {
  const failures: PreflightFailure[] = [];
  const sqlite = checkSqlite(seams.loadSqlite ?? loadSqlite);
  if (sqlite !== undefined) failures.push({ check: "sqlite", message: sqlite });
  try {
    (seams.loadPty ?? loadNodePty)();
  } catch (error) {
    failures.push({ check: "node-pty", message: messageOf(error) });
  }
  const executable = seams.claudeExecutable === undefined ? bundledExecutable() : seams.claudeExecutable;
  const claude = await claudeCodeVersionOf({ executable, ...(seams.runClaude !== undefined && { run: seams.runClaude }) });
  if ("problem" in claude) failures.push({ check: "claude", message: claude.problem });
  if ("problem" in claude || failures.length > 0) return { failures };
  return {
    report: {
      version: HARNESS_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      launcherProtocol: LAUNCHER_PROTOCOL,
      databaseSchemaVersion: DATABASE_SCHEMA_VERSION,
      bundledClaudeCodeVersion: claude.version,
    },
  };
};
