import { ServiceError } from "./errors.js";

/**
 * Text written into the scripts `service install` lays out: the launcher
 * entry and the shim, as `sh` and as `cmd` batch files, each reading the
 * text back exactly as it was given.
 */

/** Refuses text a script line cannot carry: a line break would end the line. */
export const oneLine = (what: string, text: string): string => {
  if (/[\r\n]/.test(text)) throw new ServiceError(`${what} cannot hold a line break: ${JSON.stringify(text)}.`);
  return text;
};

/** `text` as one word to a POSIX shell: single-quoted, each single quote closed, escaped and reopened. */
export const shellWord = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/** `text` inside a double-quoted POSIX shell word, where a backslash, a quote, `$` and a backquote would otherwise act. */
export const shellDoubleQuoted = (text: string): string => text.replace(/[\\"$`]/g, "\\$&");

/**
 * One argument as the Windows C runtime splits a command line: bare when it
 * has no space, tab or quote, else quoted, with each quote escaped and the
 * backslashes before a quote (or before the closing quote) doubled.
 */
export const windowsArgument = (arg: string): string => {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  let quoted = '"';
  let backslashes = 0;
  for (const char of arg) {
    if (char === "\\") {
      backslashes++;
      continue;
    }
    quoted += "\\".repeat(char === '"' ? backslashes * 2 + 1 : backslashes) + char;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
};

/** A `%` in a batch file starts a variable; doubled, it is one `%`. */
const batchPercents = (text: string): string => text.replaceAll("%", "%%");

/** `text` as the value of a batch file's `set "NAME=value"`, whose quotes keep every other character literal; it holds no quote. */
export const batchSetValue = (text: string): string => batchPercents(text);

/**
 * One argument to a program on a batch file's command line: quoted for the C
 * runtime (`windowsArgument`), then each character cmd acts on, its quotes
 * included, escaped with `^`, so cmd never enters a quoted stretch and hands
 * the program the C runtime's quoting unchanged; `%` is doubled.
 */
export const batchArgument = (arg: string): string => batchPercents(windowsArgument(arg).replace(/[\^"&|<>()!]/g, "^$&"));
