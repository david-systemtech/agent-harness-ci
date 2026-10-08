import type { ToolCommand } from "@agent-harness/contracts";

/**
 * A command of the closed command table (#376) as the one line a tool
 * terminal's login shell runs: each argument quoted as one word, a step's
 * programs joined by `|`, the steps by `&&`. On POSIX an argument that is
 * not plainly safe is single-quoted, which every login shell a terminal
 * starts (sh, bash, zsh, dash, ksh, fish, csh and tcsh) reads the same
 * way; a leading `=` is quoted too, since zsh expands `=name` to a
 * program's path. A single quote is written outside the quotes as `\'`,
 * and so is a backslash fish would read as an escape inside them (one
 * before another, before a quote or ending the word), as `\\`; a backslash
 * anywhere else stays inside, where every shell keeps it. On Windows the
 * line is PowerShell's, which quotes with single quotes and doubles one
 * inside, and a command there is one step, since Windows PowerShell has
 * no `&&`.
 */

/** A POSIX word no shell reads as anything but itself. */
const POSIX_SAFE = /^[A-Za-z0-9_@+:,./-][A-Za-z0-9_@+=:,./-]*$/;

/** A PowerShell word read as a string: never an operator (`,`), a splat (`@`) or a variable (`$`). */
const POWERSHELL_SAFE = /^[A-Za-z0-9_+:./-][A-Za-z0-9_+=:./-]*$/;

/** What a POSIX word is written outside its quotes: a single quote, and a backslash fish would read as an escape inside them. */
const POSIX_UNQUOTED = /('|\\(?=[\\']|$))/;

const posixWord = (word: string): string =>
  POSIX_SAFE.test(word)
    ? word
    : word
        .split(POSIX_UNQUOTED)
        .map((part, index) => (index % 2 === 1 ? `\\${part}` : part === "" ? "" : `'${part}'`))
        .join("");

const powershellWord = (word: string): string => (POWERSHELL_SAFE.test(word) ? word : `'${word.replaceAll("'", "''")}'`);

/** `command` as the line the login shell of `platform` runs. */
export const commandLine = (command: ToolCommand, platform: NodeJS.Platform): string => {
  const windows = platform === "win32";
  if (windows && command.length !== 1) throw new Error("A Windows command of the table is one step: Windows PowerShell has no &&.");
  const word = windows ? powershellWord : posixWord;
  return command.map((step) => step.map((program) => program.map(word).join(" ")).join(" | ")).join(" && ");
};

/** What a tool terminal says under the command it holds back until Enter (#1833). */
export const CONFIRM_PROMPT = "Press Enter to run it here, or Ctrl+C to cancel.";

/**
 * `command` as the line a tool terminal runs only once a person presses
 * Enter in it (Run in a terminal pane, #1833): the command written out,
 * the prompt, a read of one line, then the command; Ctrl+C, or the
 * terminal closing, ends it before anything runs. On POSIX the read is
 * `sh`'s, so a login shell without `read` (csh) holds it back too.
 */
export const confirmedLine = (command: ToolCommand, platform: NodeJS.Platform): string => {
  const line = commandLine(command, platform);
  if (platform === "win32") return `Write-Host ${powershellWord(line)}; $null = Read-Host ${powershellWord(CONFIRM_PROMPT)}; ${line}`;
  return `${commandLine([[["printf", "%s\\n\\n%s ", line, CONFIRM_PROMPT]], [["sh", "-c", "read -r answer"]]], platform)} && ${line}`;
};
