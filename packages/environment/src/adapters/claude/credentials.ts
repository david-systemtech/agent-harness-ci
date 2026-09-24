import { spawn } from "node:child_process";
import type { AuthStatus } from "@agent-harness/contracts";
import type { AdapterCredentialSpec } from "../../adapter/contract.js";
import { CLAUDE_LOGIN_ARGV, CLAUDE_LOGOUT_ARGV, CLAUDE_STATUS_ARGV } from "./sign-in.js";

/**
 * How a Claude account's credential is scoped (claude-adapter spec, "The
 * adapter contract"; ADR 0018): one config directory per account, named by
 * `CLAUDE_CONFIG_DIR`, and nothing else. The harness never holds a Claude
 * credential and never sets a variable that would outrank the directory's
 * login; it strips them from every process it starts.
 */

/** A process environment as it is inherited: some variables unset. */
export type HostEnvironment = Readonly<Record<string, string | undefined>>;

/** The variable naming an account's config directory: its login, history and settings. */
export const CLAUDE_CONFIG_DIR = "CLAUDE_CONFIG_DIR";

/**
 * The variables stripped from every Claude process and never set (ADR 0018,
 * permissions spec "Never root"). The three credential overrides would
 * authenticate as, and bill, an account the directory did not choose: an
 * `ANTHROPIC_API_KEY` in the shell outranks a subscription login and turns
 * it into metered spend. `IS_SANDBOX` and `CLAUDE_CODE_BUBBLEWRAP` would tell
 * Claude its root check does not apply; the service never runs as root, so
 * the check is never worked around.
 */
export const CLAUDE_STRIPPED_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "IS_SANDBOX",
  "CLAUDE_CODE_BUBBLEWRAP",
] as const;

/**
 * What else never reaches a run from the host's environment (Artemis's
 * composer, ported): the variables that would retarget the account at another
 * backend or endpoint, or at another config directory, and the one that puts
 * the CLI in bare mode. Bare mode (`CLAUDE_CODE_SIMPLE`, the `--bare` flag)
 * turns off OAuth, auto memory, plugins and every configured MCP server; the
 * pinned SDK never passes `--bare` and has no option that opts out, but the
 * CLI it spawns inherits the variable, so leaving it out of the run's
 * environment is the opt-out (verified against the bundled 2.1.281: with it
 * set, `init` lists three tools, no MCP server and no auto-memory path).
 * The config directory and the project directory name are stripped here and
 * set again from the run, never inherited.
 */
export const CLAUDE_SCRUBBED_VARIABLES: readonly string[] = [
  ...CLAUDE_STRIPPED_VARIABLES,
  "ANTHROPIC_API_KEY_HELPER",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  CLAUDE_CONFIG_DIR,
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "CLAUDE_CODE_SIMPLE",
  "CLAUDE_CODE_PROJECT_DIR_NAME",
];

/** The model overrides come as a family of names (`ANTHROPIC_DEFAULT_OPUS_MODEL`), scrubbed by pattern. */
const SCRUBBED_PATTERN = /^ANTHROPIC_DEFAULT_[A-Z0-9_]+_MODEL$/;

/**
 * A Claude process's environment: the host's, with every scrubbed variable
 * removed, then the account's directory and `extra` layered on top. A null
 * directory is the provider's own default, so the host's `CLAUDE_CONFIG_DIR`
 * (if any) stands. Answers a fresh object: the SDK's `env` option replaces
 * the child's environment wholesale, so nothing here is merged later.
 */
export const composeRunEnvironment = (
  host: HostEnvironment,
  directory: string | null,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> => {
  const scrubbed = new Set(CLAUDE_SCRUBBED_VARIABLES);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(host)) {
    if (value === undefined || scrubbed.has(key) || SCRUBBED_PATTERN.test(key)) continue;
    env[key] = value;
  }
  const ambient = host[CLAUDE_CONFIG_DIR];
  if (directory !== null) env[CLAUDE_CONFIG_DIR] = directory;
  else if (ambient !== undefined && ambient !== "") env[CLAUDE_CONFIG_DIR] = ambient;
  for (const [key, value] of Object.entries(extra)) {
    // The stripped variables are never set, whoever asks.
    if ((CLAUDE_STRIPPED_VARIABLES as readonly string[]).includes(key)) continue;
    env[key] = value;
  }
  return env;
};

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

const unreadable = (error: string): AuthStatus => ({ signedIn: false, authMethod: null, email: null, orgName: null, subscriptionType: null, error });

/**
 * Parses `claude auth status --json` into a sign-in state. The CLI may print
 * a notice before the JSON, so the outermost object is taken; it exits 1 when
 * signed out and still prints the object, so the exit code is not read here.
 * Signed in only when `loggedIn` is exactly true: a missing field reads as
 * signed out, never as ready to run. `authMethod: "none"` is no method.
 */
export const parseClaudeStatus = (output: string): AuthStatus => {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end <= start) return unreadable("The Claude binary did not print a readable status.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(start, end + 1));
  } catch {
    return unreadable("The Claude binary printed a status that could not be parsed.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return unreadable("The Claude binary printed an unexpected status.");
  const raw = parsed as Record<string, unknown>;
  const signedIn = raw["loggedIn"] === true;
  const method = text(raw["authMethod"]);
  return {
    signedIn,
    authMethod: signedIn && method !== "none" ? method : null,
    email: signedIn ? text(raw["email"]) : null,
    orgName: signedIn ? text(raw["orgName"]) : null,
    subscriptionType: signedIn ? text(raw["subscriptionType"]) : null,
    error: null,
  };
};

/** The Claude credential spec: the directory variable, the stripped variables, the argv of the bundled binary's auth commands and the status parser. */
export const claudeCredentials: AdapterCredentialSpec = {
  configDirVariable: CLAUDE_CONFIG_DIR,
  strippedVariables: [...CLAUDE_STRIPPED_VARIABLES],
  signIn: [...CLAUDE_LOGIN_ARGV],
  status: [...CLAUDE_STATUS_ARGV],
  logout: [...CLAUDE_LOGOUT_ARGV],
  parseStatus: parseClaudeStatus,
};

/** What a command printed, and how it exited (null when it could not be run, or timed out). */
export interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the bundled binary with an argv and an environment; injectable, so no test spawns it. */
export type CommandRunner = (executable: string, argv: readonly string[], env: Record<string, string>, timeoutMs: number) => Promise<CommandResult>;

/**
 * The real runner: no shell, stdin closed so a command that unexpectedly
 * prompts fails fast instead of hanging, killed at the timeout. Never
 * rejects: a binary that cannot be run answers a null code and its error.
 */
export const spawnCommand: CommandRunner = (executable, argv, env, timeoutMs) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(executable, [...argv], { env, stdio: ["ignore", "pipe", "pipe"] });
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ code: null, stdout, stderr: `${stderr}\nTimed out after ${timeoutMs} ms.` });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => finish({ code: null, stdout, stderr: error.message }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });

export interface StatusReadOptions {
  /** The bundled binary; null when this platform has none, which reads as an error rather than a spawn of the user's own `claude`. */
  readonly executable: string | null;
  readonly directory: string | null;
  readonly hostEnv: HostEnvironment;
  readonly run?: CommandRunner;
  readonly timeoutMs?: number;
}

/**
 * Reads an account's sign-in state with the bundled binary's status command,
 * under the account's directory with the stripped variables absent (an
 * inherited `ANTHROPIC_API_KEY` would make a signed-out directory report
 * itself signed in, as the wrong account). Never rejects: what could not be
 * read is a signed-out state with the reason, the binary's own words first.
 */
export const readClaudeStatus = async (options: StatusReadOptions): Promise<AuthStatus> => {
  if (options.executable === null) return unreadable("The bundled Claude binary was not found for this platform.");
  const run = options.run ?? spawnCommand;
  const result = await run(options.executable, CLAUDE_STATUS_ARGV, composeRunEnvironment(options.hostEnv, options.directory), options.timeoutMs ?? 15_000);
  const parsed = parseClaudeStatus(result.stdout);
  if (parsed.error === null) return parsed;
  const fallback = result.code === null ? "The bundled Claude binary could not be run." : `The Claude binary exited with code ${result.code}.`;
  return { ...parsed, error: result.stderr.trim() || parsed.error || fallback };
};
