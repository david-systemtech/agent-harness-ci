import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

/** Arguments the CLI cannot parse: it prints the message and its usage, and exits 2. */
export class UsageError extends Error {}

/** The options of one verb, strictly: an unknown option or a positional is a `UsageError`. */
export const parseOptions = <const Options extends ParseArgsOptionsConfig>(args: readonly string[], options: Options) => {
  try {
    return parseArgs({ args: [...args], options, strict: true, allowPositionals: false }).values;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
};

/** A `--port` value from `min` (0 lets `serve` pick a free port) to 65535, or undefined when none was given. */
export const parsePort = (value: string | undefined, min: 0 | 1): number | undefined => {
  if (value === undefined) return undefined;
  if (!(/^\d+$/.test(value) && Number(value) >= min && Number(value) <= 65535)) {
    throw new UsageError(`--port takes a port number from ${min} to 65535; got ${value}.`);
  }
  return Number(value);
};

/** A `--name` value: the name a new environment is created with, one line with something in it; undefined when none was given. */
export const parseName = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  if (value.trim() === "") throw new UsageError("--name takes the environment's name; got an empty one.");
  if (/[\r\n]/.test(value)) throw new UsageError("--name takes the environment's name on one line; got a line break in it.");
  return value;
};

/** The options and positionals of one verb: an unknown option is a `UsageError`, and the verb judges its positionals. */
export const parseVerb = <const Options extends ParseArgsOptionsConfig>(args: readonly string[], options: Options) => {
  try {
    return parseArgs({ args: [...args], options, strict: true, allowPositionals: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
};
