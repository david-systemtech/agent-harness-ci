import type { SignInFallback } from "@agent-harness/contracts";
import type { ProbeResult, SignInProgram } from "../../accounts/signin-seam.js";
import { CLAUDE_CONFIG_DIR, CLAUDE_LOGIN_ARGV, composeRunEnvironment, type HostEnvironment } from "./credentials.js";

export { CLAUDE_LOGIN_ARGV, CLAUDE_LOGOUT_ARGV, CLAUDE_STATUS_ARGV } from "./credentials.js";

/**
 * Sign-in through the bundled binary (claude-adapter spec, "Sign-in and
 * status through the bundled binary"; ADR 0018): the program the sign-in
 * director (`accounts/signin-director.ts`) drives for Claude accounts. It
 * runs `auth login` with `CLAUDE_CONFIG_DIR` at the account's directory and
 * every scrubbed variable absent, as every Claude process runs, reads the
 * verification URL from what the binary prints, and renders the command a
 * person can run in a terminal instead.
 *
 * Verified on the bundled 2.1.281 (#135), stdin a pipe and no terminal:
 * `auth login` prints
 *
 *     Opening browser to sign in…
 *     If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=…&state=…
 *     Paste code here if prompted >
 *
 * (the prompt with no line break), then waits for the code on stdin; it
 * needs no pseudo-terminal, and an end of stdin does not end it, so a cancel
 * kills it. `auth login --help` prints `Usage: claude auth login [options]`
 * and exits 0; a binary without the command also exits 0 on `--help`,
 * printing its parent's usage (`Usage: claude auth [options] [command]`), so
 * the probe reads the usage line, never the exit code alone.
 *
 * Subscription only: `--console` is never passed. A Console user runs the
 * fallback command with it (ADR 0018).
 */

/** Asks an executable whether it runs `auth login`: the usage line names the command when it does. */
export const CLAUDE_LOGIN_HELP_ARGV = [...CLAUDE_LOGIN_ARGV, "--help"] as const;

/** The managed tool's name (ADR 0026): the Claude CLI a person installs, the Managed tools registry's `claude` row. */
export const CLAUDE_TOOL = "claude";

/** Whether a probe's answer says the executable runs `auth login`: it exited 0 and its usage line names the command. */
export const runsClaudeLogin = (result: ProbeResult): boolean => result.code === 0 && /^Usage:\s+\S+\s+auth\s+login\b/m.test(result.stdout);

/**
 * The verification URL in what `auth login` has printed so far: the `https`
 * URL on the `visit:` line, else the first that goes to `/oauth/authorize`,
 * in either case followed by white space, so a URL split across two chunks
 * is read only once its line has ended; and only one that parses as a URL,
 * so a stray `https` line before it is never published and a bad match
 * never reaches the notice's schema. Null until then.
 */
export const claudeVerificationUrl = (output: string): string | null => {
  const candidates = [/\bvisit:\s*(https:\/\/\S+)\s/.exec(output)?.[1], /(https:\/\/[^\s/]+\/[^\s]*oauth\/authorize\S*)\s/.exec(output)?.[1]];
  return candidates.find((url): url is string => url !== undefined && URL.canParse(url)) ?? null;
};

/** A POSIX shell word in single quotes, each quote inside closed, escaped and reopened. */
const posixQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/** A word a POSIX shell reads as it is, needing no quotes. */
const posixPlain = (text: string): boolean => /^[A-Za-z0-9_./:@%+=,-]+$/.test(text);

/** A PowerShell string in single quotes, each quote inside doubled; PowerShell reads the typographic single quotes as quotes too. */
const powershellQuote = (text: string): string => `'${text.replace(/['‘’‚‛]/g, "$&$&")}'`;

/**
 * The command that signs `directory` in from a terminal on the environment's
 * machine, in both shells, the directory quoted: POSIX sets the variable on
 * the command alone, PowerShell sets it for the rest of the session and
 * calls the executable. `--console` is left for a Console user to add.
 */
export const claudeFallback = (directory: string, executable: string): SignInFallback => {
  const login = CLAUDE_LOGIN_ARGV.join(" ");
  return {
    posix: `${CLAUDE_CONFIG_DIR}=${posixQuote(directory)} ${posixPlain(executable) ? executable : posixQuote(executable)} ${login}`,
    powershell: `$env:${CLAUDE_CONFIG_DIR} = ${powershellQuote(directory)}; & ${powershellQuote(executable)} ${login}`,
  };
};

export interface ClaudeSignInOptions {
  /** The environment sign-ins inherit, before the scrub; preset: this process's, copied once. */
  readonly hostEnv?: HostEnvironment;
  /** The bundled binary (`bundledExecutable()`); null when this platform has none. */
  readonly bundled: string | null;
  /** The managed tool `claude` where the Managed tools registry found it, outside the harness's own files; null when it has none. */
  readonly managedTool: () => string | null | Promise<string | null>;
}

/** Claude's sign-in program: the bundled binary first, the managed tool `claude` when it does not run `auth login`. */
export const claudeSignInProgram = (options: ClaudeSignInOptions): SignInProgram => {
  const hostEnv: HostEnvironment = { ...(options.hostEnv ?? process.env) };
  const bundled = options.bundled;
  return {
    bundled,
    managedTool: options.managedTool,
    argv: CLAUDE_LOGIN_ARGV,
    probeArgv: CLAUDE_LOGIN_HELP_ARGV,
    runsSignIn: runsClaudeLogin,
    env: (directory) => composeRunEnvironment(hostEnv, directory),
    verificationUrl: claudeVerificationUrl,
    fallback: claudeFallback,
    toolName: CLAUDE_TOOL,
  };
};
