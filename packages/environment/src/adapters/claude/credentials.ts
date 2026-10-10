import { ProbeTimeoutError } from "../../adapter/probe.js";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AuthStatus } from "@agent-harness/contracts";
import type { AdapterCredentialSpec } from "../../adapter/contract.js";
import { afterInheritedGitConfig } from "../../adapter/process-environment.js";

/**
 * How a Claude account's credential is scoped (claude-adapter spec, "The
 * adapter contract"; ADR 0018): one config directory per account, named by
 * `CLAUDE_CONFIG_DIR`, and nothing else. The harness never holds a Claude
 * credential and never sets a variable that would outrank the directory's
 * login; it strips them from every process it starts.
 */

/** Claude's provider id: what the host registers the adapter by, and an account identity's provider. */
export const CLAUDE_PROVIDER = "claude";

/** A process environment as it is inherited: some variables unset. */
export type HostEnvironment = Readonly<Record<string, string | undefined>>;

/** The variable naming an account's config directory: its login, history and settings. */
export const CLAUDE_CONFIG_DIR = "CLAUDE_CONFIG_DIR";

/**
 * The variable naming the CLI's credential store (#229): the directory whose
 * `.credentials.json` it reads, refreshes and writes back (Linux, Windows),
 * whose name its macOS keychain item is keyed by, and where its refresh lock
 * (`.oauth_refresh.lock`) lives; read by the bundled 2.1.281 before its
 * config directory. Set to the account's directory on every process, as
 * `CLAUDE_CONFIG_DIR` is, so a resume through the session store, which the
 * pinned SDK runs in a temporary config directory whose credentials copy has
 * no refresh token, still reads and refreshes the account's own login, under
 * the same lock as every other process of the account. The SDK sets it
 * itself on Windows only, and only when the run's environment has none.
 */
export const CLAUDE_SECURESTORAGE_CONFIG_DIR = "CLAUDE_SECURESTORAGE_CONFIG_DIR";

/**
 * The bundled binary's auth commands (claude-adapter spec, "Sign-in and
 * status through the bundled binary"), run with `CLAUDE_CONFIG_DIR` at the
 * account's directory and the stripped variables absent, as every Claude
 * process runs. Here rather than in `signin.ts`, which re-exports them, so
 * the sign-in program can compose its environment from this module without
 * an import cycle.
 *
 * Subscription only: `--console` is never passed. A Console user runs the
 * fallback command with it (ADR 0018). `--claudeai` is not passed either: it
 * restates the binary's default in a line a person may read and paste.
 */

/** Starts a sign-in: the binary prints a verification URL and reads the code on stdin. */
export const CLAUDE_LOGIN_ARGV = ["auth", "login"] as const;

/** Prints the account's sign-in state as JSON; exits 1 when signed out, still printing it. */
export const CLAUDE_STATUS_ARGV = ["auth", "status", "--json"] as const;

/** Clears the credential from the account's directory. */
export const CLAUDE_LOGOUT_ARGV = ["auth", "logout"] as const;

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
 * What else never reaches a Claude process from the host's environment
 * (a list widened here to prefixes): anything that would
 * authenticate, retarget the account at another backend or endpoint, or
 * point it at another config directory, and the variable that puts the CLI
 * in bare mode. Scrubbed by name and by family:
 *
 * - every `ANTHROPIC_*` (keys, tokens, base URLs, headers, model overrides,
 *   the cloud backends' settings, `ANTHROPIC_CONFIG_DIR`); the SDK needs none
 *   of them to run a subscription login;
 * - every `CLAUDE_CODE_USE_*` (the backend selectors) and `CLAUDE_CODE_OAUTH_*`
 *   (the token, the refresh token, the token's file descriptor);
 * - every name holding `_TOKEN` or ending `_FILE_DESCRIPTOR` (a refresh token,
 *   a gateway token passed by descriptor, a forge token a run must reach
 *   through the harness's credential helper instead, ADR 0020), except the
 *   numeric limits and thresholds that only share the word (`*_TOKENS`,
 *   `CLAUDE_CODE_IDLE_TOKEN_THRESHOLD`, `CLAUDE_CODE_RESUME_TOKEN_THRESHOLD`,
 *   `CLAUDE_CODE_ENABLE_TOKEN_USAGE_ATTACHMENT`, the total-tokens reminders),
 *   which the CLI reads as tuning and which carry no credential;
 * - `CLAUDE_CODE_API_BASE_URL`, `CLAUDE_CODE_CUSTOM_OAUTH_URL`, and
 *   `CLAUDE_CODE_SIMPLE`: bare mode (`--bare`) turns
 *   off OAuth, auto memory, plugins and every configured MCP server; the
 *   pinned SDK never passes `--bare` and has no option that opts out, but the
 *   CLI inherits the variable (verified on the bundled 2.1.281), so leaving
 *   it out is the opt-out;
 * - `CLAUDE_CONFIG_DIR`, the secure-storage directory
 *   (`CLAUDE_SECURESTORAGE_CONFIG_DIR`) and `CLAUDE_CODE_PROJECT_DIR_NAME`,
 *   set again from the run, never inherited (the first two to the account's
 *   directory, #229);
 * - `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`, which the bundled CLI reads before
 *   any setting for where auto memory lives (2.1.281's resolver: this, then
 *   the settings layers from policy down, then the project directory's
 *   default), so a stray one cannot move memory out of the directory every
 *   account shares (ADR 0018, #137);
 * - every `FORGE_*`: a run's forge variables are the harness's injection's
 *   alone (forge spec, "Runs: the injection"; #315), set again from what the
 *   spawn is supplied, so an inherited `FORGE_URL` never names a forge the
 *   harness does not serve;
 * - every `BWS_*`: a run's bws variables are the key managers' Bitwarden
 *   block's alone (key-managers spec, "Injection"; #1141), which names no
 *   server URL, so an inherited `BWS_SERVER_URL` never makes bws through
 *   2.1.0 skip the block's configuration and keep its state under the
 *   host's `~/.bws/state`.
 *
 * What the SDK itself sets (`CLAUDE_CODE_ENTRYPOINT`) or the harness sets
 * (`CLAUDE_AGENT_SDK_CLIENT_APP`) is layered on after the scrub.
 */
export const CLAUDE_SCRUBBED_VARIABLES: readonly string[] = [
  ...CLAUDE_STRIPPED_VARIABLES,
  "CLAUDE_CODE_API_BASE_URL",
  "CLAUDE_CODE_CUSTOM_OAUTH_URL",
  CLAUDE_CONFIG_DIR,
  CLAUDE_SECURESTORAGE_CONFIG_DIR,
  "CLAUDE_CODE_SIMPLE",
  "CLAUDE_CODE_PROJECT_DIR_NAME",
  "CLAUDE_COWORK_MEMORY_PATH_OVERRIDE",
];

/** The families scrubbed by pattern. */
const SCRUBBED_PATTERNS: readonly RegExp[] = [/^ANTHROPIC_/, /^CLAUDE_CODE_USE_/, /^CLAUDE_CODE_OAUTH_/, /_TOKEN/, /_FILE_DESCRIPTOR$/];

/** The forge's variables, which only the harness's injection sets (ADR 0020, #315): an inherited one would name a forge the harness does not serve. */
const FORGE_VARIABLES = /^FORGE_/;

/** bws's variables, which only the key managers' Bitwarden block sets (#1141): an inherited server URL would bypass the block's profile and its state folder. */
const BWS_VARIABLES = /^BWS_/;

/** Names that hold the word token and no credential: limits and thresholds the CLI reads as tuning. */
const TOKEN_TUNING: readonly RegExp[] = [
  /_TOKENS$/,
  /^CLAUDE_CODE_TOTAL_TOKENS_REMINDER/,
  /^CLAUDE_CODE_(IDLE|RESUME)_TOKEN_THRESHOLD$/,
  /^CLAUDE_CODE_ENABLE_TOKEN_USAGE_ATTACHMENT$/,
];

/** Whether a host variable is kept out of every Claude process. */
export const isScrubbed = (name: string): boolean => {
  if (CLAUDE_SCRUBBED_VARIABLES.includes(name)) return true;
  // The credential families go whatever else they say, and so do the forge's and bws's variables.
  if (/^ANTHROPIC_|^CLAUDE_CODE_USE_|^CLAUDE_CODE_OAUTH_/.test(name) || FORGE_VARIABLES.test(name) || BWS_VARIABLES.test(name)) return true;
  if (!SCRUBBED_PATTERNS.some((pattern) => pattern.test(name))) return false;
  return !TOKEN_TUNING.some((pattern) => pattern.test(name));
};

/**
 * The directory an account with none of its own reads: the host's
 * `CLAUDE_CONFIG_DIR`, else the CLI's own default under the home directory.
 * Resolved once, when the adapter is made, so every process is handed a
 * directory explicitly and none depends on what the process environment
 * holds at the moment (the config-directory queue writes it while a helper runs).
 */
export const ambientConfigDirectory = (host: HostEnvironment): string => {
  // An empty value is unset, as the CLI reads it: never a relative `.claude` under whatever the working directory is.
  const given = (name: string): string | undefined => (host[name] === "" ? undefined : host[name]);
  return given(CLAUDE_CONFIG_DIR) ?? join(given("HOME") ?? given("USERPROFILE") ?? homedir(), ".claude");
};

/**
 * A Claude process's environment: the host's, with every scrubbed variable
 * removed, then what its spawn was `supplied` (the run's process
 * environment, #307: after the scrub, so a supplied name holding `_TOKEN`
 * reaches the process; its git configuration numbered after the host's
 * entries, #315), then `extra`, the harness's own, then the account's
 * directory, as the config directory and as the credential store, on top.
 * The directory is always given and always set, and the stripped variables
 * never are, whoever asks otherwise. Answers a fresh object: the SDK's `env`
 * option replaces the child's environment wholesale, so nothing here is
 * merged later.
 */
export const composeRunEnvironment = (
  host: HostEnvironment,
  directory: string,
  extra: Readonly<Record<string, string>> = {},
  supplied: Readonly<Record<string, string>> = {},
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(host)) {
    if (value === undefined || isScrubbed(key)) continue;
    env[key] = value;
  }
  for (const [key, value] of [...Object.entries(afterInheritedGitConfig(env, supplied)), ...Object.entries(extra)]) {
    // The stripped variables are never set, whoever asks.
    if ((CLAUDE_STRIPPED_VARIABLES as readonly string[]).includes(key)) continue;
    env[key] = value;
  }
  env[CLAUDE_CONFIG_DIR] = directory;
  env[CLAUDE_SECURESTORAGE_CONFIG_DIR] = directory;
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
  readonly timedOut?: boolean;
}

/** Runs the bundled binary with an argv and an environment; injectable, so no test spawns it. */
export type CommandRunner = (executable: string, argv: readonly string[], env: Record<string, string>, timeoutMs: number, signal?: AbortSignal) => Promise<CommandResult>;

/**
 * The real runner: no shell, stdin closed so a command that unexpectedly
 * prompts fails fast instead of hanging, killed at the timeout. Never
 * rejects: a binary that cannot be run answers a null code and its error.
 */
export const spawnCommand: CommandRunner = (executable, argv, env, timeoutMs, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted === true) { resolve({ code: null, stdout: "", stderr: "Cancelled." }); return; }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(executable, [...argv], { env, stdio: ["ignore", "pipe", "pipe"] });
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancelled);
      resolve(result);
    };
    const cancelled = () => { child.kill("SIGKILL"); finish({ code: null, stdout, stderr: "Cancelled." }); };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, stdout, stderr: `${stderr}\nTimed out after ${timeoutMs} ms.`, timedOut: true });
    }, timeoutMs);
    signal?.addEventListener("abort", cancelled, { once: true });
    // Decoded by the streams, which hold a character split across two chunks until it is whole.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => finish({ code: null, stdout, stderr: error.message }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });

export interface StatusReadOptions {
  /** The bundled binary; null when this platform has none, which reads as an error rather than a spawn of the user's own `claude`. */
  readonly executable: string | null;
  /** The account's directory, resolved: the ambient default for an account with none. */
  readonly directory: string;
  readonly hostEnv: HostEnvironment;
  readonly run?: CommandRunner;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Reads an account's sign-in state with the bundled binary's status command,
 * under the account's directory with the stripped variables absent (an
 * inherited `ANTHROPIC_API_KEY` would make a signed-out directory report
 * itself signed in, as the wrong account). Cancellation and deadlines reject;
 * other read failures carry the reason, the binary's own words first.
 */
export const readClaudeStatus = async (options: StatusReadOptions): Promise<AuthStatus> => {
  options.signal?.throwIfAborted();
  if (options.executable === null) return unreadable("The bundled Claude binary was not found for this platform.");
  const run = options.run ?? spawnCommand;
  const result = await run(options.executable, CLAUDE_STATUS_ARGV, composeRunEnvironment(options.hostEnv, options.directory), options.timeoutMs ?? 15_000, options.signal);
  options.signal?.throwIfAborted();
  if (result.timedOut === true) throw new ProbeTimeoutError(`The Claude status command did not answer within ${options.timeoutMs ?? 15_000} ms.`);
  const parsed = parseClaudeStatus(result.stdout);
  if (parsed.error === null) return parsed;
  // The binary's own words; else how it failed, when it did; else what was wrong with what it printed.
  const failed = result.code === null ? "The bundled Claude binary could not be run." : result.code !== 0 ? `The Claude binary exited with code ${result.code}.` : null;
  return { ...parsed, error: result.stderr.trim() || failed || parsed.error };
};
