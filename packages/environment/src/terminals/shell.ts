import { accessSync, constants } from "node:fs";
import { userInfo } from "node:os";
import { basename, isAbsolute } from "node:path";

/**
 * What a terminal runs, and the environment it runs in (tui spec: "the
 * login shell in the workspace directory"). The shell is the one the user's
 * passwd entry names, started as a login shell (`-l`) when it is one whose
 * flag is known, so the user's profile builds the PATH as a terminal
 * emulator's would; with none usable (no entry, `nologin`, `false`, a
 * relative path, a file that is not there) it is `/bin/sh -l`. On Windows it
 * is PowerShell. The environment is a clean base (`TERM`, `PATH`, `HOME`,
 * `LANG`, the user's names) under the client's variables: never the
 * environment's own, which may hold a provider's config directory or a key
 * manager's token.
 */

/** A program and its arguments. */
export interface ShellCommand {
  readonly file: string;
  readonly args: readonly string[];
}

/** The passwd entry, as far as the shell and the base environment read it. */
export interface ShellUser {
  readonly username: string;
  readonly homedir: string;
  readonly shell: string | null;
}

/** Shells whose `-l` starts a login shell. */
const LOGIN_FLAG_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish", "tcsh", "csh", "yash"]);

/** Entries that name a refusal, not a shell. */
const NOT_SHELLS = new Set(["nologin", "false"]);

const FALLBACK: ShellCommand = { file: "/bin/sh", args: ["-l"] };

const executable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * The running process's passwd entry. A uid with none (a container's
 * arbitrary uid) makes `userInfo` throw on POSIX; then the names come from
 * `USER` or `LOGNAME`, else the uid, the home from `HOME`, else `/`, and no
 * shell, so a terminal starts `/bin/sh -l` and nothing that reads the entry
 * throws.
 */
export const processUser = (
  read: () => { readonly username: string; readonly homedir: string; readonly shell: string | null } = userInfo,
  env: Readonly<Record<string, string | undefined>> = process.env,
  uid: number = process.getuid?.() ?? 0,
): ShellUser => {
  try {
    const info = read();
    return { username: info.username, homedir: info.homedir, shell: info.shell };
  } catch {
    return { username: env["USER"] || env["LOGNAME"] || String(uid), homedir: env["HOME"] || "/", shell: null };
  }
};

/** The shell a terminal starts: see the module comment. */
export const loginShell = (
  platform: NodeJS.Platform = process.platform,
  user: ShellUser = processUser(),
  isExecutable: (file: string) => boolean = executable,
): ShellCommand => {
  if (platform === "win32") return { file: "powershell.exe", args: [] };
  const shell = user.shell;
  if (shell === null || shell === "" || !isAbsolute(shell)) return FALLBACK;
  const name = basename(shell);
  if (NOT_SHELLS.has(name) || !isExecutable(shell)) return FALLBACK;
  return { file: shell, args: LOGIN_FLAG_SHELLS.has(name) ? ["-l"] : [] };
};

/** Shells whose `-l` must be their only flag, so a command line is given them without it. */
const LOGIN_FLAG_ALONE = new Set(["csh", "tcsh"]);

/** PowerShell, which takes a command line after `-Command`. */
const POWERSHELL = /(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i;

/**
 * `shell` running the command line `line` and nothing else: after `-c`,
 * with the login flag it has (so the profile builds the PATH as it would
 * for a person's terminal), but alone for csh and tcsh, whose `-l` takes no
 * other flag; after `-Command` for PowerShell. What a tool terminal (#362)
 * and the read of the login shell's PATH run.
 */
export const throughShell = (shell: ShellCommand, line: string): ShellCommand => {
  if (POWERSHELL.test(shell.file)) return { file: shell.file, args: [...shell.args, "-Command", line] };
  return { file: shell.file, args: [...(LOGIN_FLAG_ALONE.has(basename(shell.file)) ? [] : shell.args), "-c", line] };
};

/** What Windows needs of the environment to run anything, carried when present. */
const WINDOWS_KEPT = [
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "HOMEDRIVE",
  "HOMEPATH",
];

/** The value of `name` in `env`, whatever its case on Windows (`Path`). */
const lookup = (env: Readonly<Record<string, string | undefined>>, name: string, platform: NodeJS.Platform): string | undefined => {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
};

/** A terminal's base environment: see the module comment. `SHELL` is left to the terminal, which knows which shell it started. */
export const baseEnvironment = (
  platform: NodeJS.Platform = process.platform,
  own: Readonly<Record<string, string | undefined>> = process.env,
  user: ShellUser = processUser(),
): Record<string, string> => {
  const env: Record<string, string> = {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    PATH: lookup(own, "PATH", platform) ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: lookup(own, "HOME", platform) ?? user.homedir,
    LANG: lookup(own, "LANG", platform) ?? "C.UTF-8",
    USER: user.username,
    LOGNAME: user.username,
  };
  if (platform === "win32") {
    for (const name of WINDOWS_KEPT) {
      const value = own[name];
      if (value !== undefined) env[name] = value;
    }
  }
  return env;
};
