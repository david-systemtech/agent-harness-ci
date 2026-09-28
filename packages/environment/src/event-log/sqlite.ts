import type * as Sqlite from "node:sqlite";

let sqlite: typeof Sqlite | undefined;

const isSqliteExperimentalWarning = (warning: string | Error, rest: readonly unknown[]): boolean => {
  const [typeOrOptions] = rest;
  const type =
    typeof typeOrOptions === "string"
      ? typeOrOptions
      : typeof typeOrOptions === "object" && typeOrOptions !== null && "type" in typeOrOptions
        ? typeOrOptions.type
        : warning instanceof Error
          ? warning.name
          : undefined;
  const message = typeof warning === "string" ? warning : warning.message;
  return type === "ExperimentalWarning" && message.startsWith("SQLite ");
};

/**
 * `node:sqlite`, loaded on first use. Node prints a one-time
 * ExperimentalWarning when the module first loads; that one warning is
 * dropped here, at the load, and every other warning passes through.
 */
export const loadSqlite = (): typeof Sqlite => {
  if (sqlite) return sqlite;
  const emitWarning = process.emitWarning;
  process.emitWarning = function (this: NodeJS.Process, warning: string | Error, ...rest: unknown[]) {
    if (isSqliteExperimentalWarning(warning, rest)) return;
    Reflect.apply(emitWarning, this, [warning, ...rest]);
  } as typeof process.emitWarning;
  try {
    sqlite = process.getBuiltinModule("node:sqlite");
  } finally {
    process.emitWarning = emitWarning;
  }
  return sqlite;
};
