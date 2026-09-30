import type { ToolCommand } from "@agent-harness/contracts";

/**
 * A command of the closed command table (#376) as the one line a tool
 * terminal's login shell runs: each argument quoted as one word, a step's
 * programs joined by `|`, the steps by `&&`. On POSIX an argument that is
 * not plainly safe is single-quoted, which every login shell a terminal
 * starts (sh, bash, zsh, dash, ksh, fish, csh and tcsh) reads the same
 * way; a leading `=` is quoted too, since zsh expands `=name` to a
 * program's path. On Windows the line is PowerShell's, which quotes with
 * single quotes and doubles one inside, and a command there is one step,
 * since Windows PowerShell has no `&&`.
 */

/** A POSIX word no shell reads as anything but itself. */
const POSIX_SAFE = /^[A-Za-z0-9_@+:,./-][A-Za-z0-9_@+=:,./-]*$/;

/** A PowerShell word read as a string: never an operator (`,`), a splat (`@`) or a variable (`$`). */
const POWERSHELL_SAFE = /^[A-Za-z0-9_+:./-][A-Za-z0-9_+=:./-]*$/;

const posixWord = (word: string): string => (POSIX_SAFE.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

const powershellWord = (word: string): string => (POWERSHELL_SAFE.test(word) ? word : `'${word.replaceAll("'", "''")}'`);

/** `command` as the line the login shell of `platform` runs. */
export const commandLine = (command: ToolCommand, platform: NodeJS.Platform): string => {
  const windows = platform === "win32";
  if (windows && command.length !== 1) throw new Error("A Windows command of the table is one step: Windows PowerShell has no &&.");
  const word = windows ? powershellWord : posixWord;
  return command.map((step) => step.map((program) => program.map(word).join(" ")).join(" | ")).join(" && ");
};
