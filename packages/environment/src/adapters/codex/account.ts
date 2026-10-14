import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountIdentity, AuthStatus, SignInFallback } from "@agent-harness/contracts";
import type { ProbeResult, SignInProgram } from "../../accounts/signin-seam.js";
import type { AccountRef, ModelCatalogue, UsageReading } from "../../adapter/contract.js";
import { isScrubbed, type HostEnvironment } from "../claude/credentials.js";
import { CODEX_HOME, CODEX_PROVIDER, CODEX_TOOL, CODEX_WORKER_HOME } from "./constants.js";
import { readCodexUsage } from "./usage.js";

/**
 * Codex accounts (#2169; ADR 0018): an account of the provider `codex` is
 * one `CODEX_HOME` directory, the machine's own `~/.codex` adopted in place
 * or an owned one under the data directory signed in by `codex login
 * --device-auth`. Sessions do not run on Codex yet (the adapter is #2170):
 * this is the account half the account service reads, its status from the
 * directory's `auth.json` without running anything, its identity from the
 * login's id token, and the sign-in program the director drives.
 *
 * `auth.json` (codex-rs `login/src/auth`): `{ OPENAI_API_KEY, tokens: {
 * id_token, access_token, refresh_token, account_id }, last_refresh }`. The
 * id token's claims carry `email` and, under
 * `https://api.openai.com/auth`, `chatgpt_plan_type`. The CLI refreshes the
 * access token itself with the refresh token, so a lapsed access token is
 * not a lapsed login; one with no refresh token left is.
 */

/** The file a signed-in Codex home holds. */
export const CODEX_AUTH_FILE = "auth.json";

/** Starts a sign-in by the device flow: a link and a one-time code, nothing pasted back, the CLI polls and exits 0. */
export const CODEX_LOGIN_ARGV = ["login", "--device-auth"] as const;
export const CODEX_LOGIN_HELP_ARGV = ["login", "--help"] as const;

/** What the account service reads a provider through: a session adapter is one, and so is an account-only provider such as Codex's. */
export interface CodexAccountProvider {
  readonly descriptor: { readonly provider: string; readonly displayName: string };
  status(account: AccountRef, signal?: AbortSignal): Promise<AuthStatus>;
  observeIdentity(directory: string): Promise<AccountIdentity | null>;
  ambientDirectory(): string;
  models(account: AccountRef, signal?: AbortSignal): Promise<ModelCatalogue>;
  /** The plan usage the CLI's newest rate-limit reading in the home says (`usage.ts`). */
  usage(account: AccountRef): Promise<UsageReading>;
}

/** The machine's own Codex home: `CODEX_HOME` when set and not empty, else `.codex` in the home directory, on every platform. */
export const ambientCodexHome = (host: HostEnvironment): string => {
  const given = (name: string): string | undefined => (host[name] === "" ? undefined : host[name]);
  return given(CODEX_HOME) ?? join(given("HOME") ?? given("USERPROFILE") ?? homedir(), ".codex");
};

interface CodexAuthFile {
  readonly OPENAI_API_KEY?: unknown;
  readonly tokens?: { readonly id_token?: unknown; readonly access_token?: unknown; readonly refresh_token?: unknown } | null;
}

/** A JWT's claims, unverified (the CLI wrote it; nothing here trusts it beyond naming the login); null when it is not one. */
export const jwtClaims = (token: unknown): Record<string, unknown> | null => {
  if (typeof token !== "string") return null;
  const part = token.split(".")[1];
  if (part === undefined) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return typeof claims === "object" && claims !== null && !Array.isArray(claims) ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

const SIGNED_OUT: AuthStatus = { signedIn: false, authMethod: null, email: null, orgName: null, subscriptionType: null, error: null };

/** Reads a Codex home's `auth.json`: absent is signed out, unparseable is unreadable (`error`), tokens are a ChatGPT login, a key an API-key one. */
export const readCodexStatus = async (directory: string, now: () => number = Date.now): Promise<AuthStatus> => {
  let raw: string;
  try {
    raw = await readFile(join(directory, CODEX_AUTH_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return SIGNED_OUT;
    return { ...SIGNED_OUT, error: `The Codex sign-in file could not be read: ${(error as Error).message}` };
  }
  let auth: CodexAuthFile;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    auth = parsed as CodexAuthFile;
  } catch {
    return { ...SIGNED_OUT, error: `The Codex sign-in file ${join(directory, CODEX_AUTH_FILE)} is not JSON.` };
  }
  const tokens = auth.tokens ?? null;
  if (tokens !== null && typeof tokens === "object" && (text(tokens.access_token) !== null || text(tokens.refresh_token) !== null)) {
    const claims = jwtClaims(tokens.id_token);
    const plan = claims?.["https://api.openai.com/auth"];
    const planType = typeof plan === "object" && plan !== null ? text((plan as Record<string, unknown>)["chatgpt_plan_type"]) : null;
    const access = jwtClaims(tokens.access_token);
    const lapsed = text(tokens.refresh_token) === null && typeof access?.["exp"] === "number" && access["exp"] * 1000 <= now();
    return {
      signedIn: !lapsed,
      authMethod: "ChatGPT",
      email: text(claims?.["email"]),
      orgName: null,
      subscriptionType: planType,
      error: null,
      ...(lapsed && { expired: true }),
    };
  }
  if (text(auth.OPENAI_API_KEY) !== null) return { signedIn: true, authMethod: "API key", email: null, orgName: null, subscriptionType: null, error: null };
  return SIGNED_OUT;
};

/**
 * The models a Codex login offers, as the CLI's picker lists them; not read
 * live, so the catalogue says so. Checked again for #2224 (2026-10-14): the
 * `codex` CLI has no listing command and no `codex models`; its models are
 * listed only inside the interactive TUI (`/model`) and over `codex
 * app-server`'s JSON-RPC `model/list`, which needs a running app-server
 * session the account provider does not hold. Read it live when the Codex
 * adapter (#2170), which drives the app-server, serves sessions.
 */
export const CODEX_MODELS: ModelCatalogue = {
  live: false,
  models: [
    { id: "gpt-5-codex", family: "gpt-5-codex", tier: 2, efforts: ["low", "medium", "high"], label: "GPT-5 Codex" },
    { id: "gpt-5", family: "gpt-5", tier: 1, efforts: ["minimal", "low", "medium", "high"], label: "GPT-5" },
  ],
};

export interface CodexAccountOptions {
  /** The host's environment, for the machine's own Codex home; preset: this process's. */
  readonly hostEnv?: HostEnvironment;
  /** The clock a lapsed access token is judged by; preset `Date.now`. */
  readonly now?: () => number;
}

/** The Codex account provider the account service reads (status, identity, models, the machine's own directory). */
export const createCodexAccountProvider = (options: CodexAccountOptions = {}): CodexAccountProvider => {
  const hostEnv: HostEnvironment = { ...(options.hostEnv ?? process.env) };
  const now = options.now ?? Date.now;
  const ambient = ambientCodexHome(hostEnv);
  const directoryOf = (account: AccountRef): string => account.directory ?? ambient;
  return {
    descriptor: { provider: CODEX_PROVIDER, displayName: "Codex" },
    status: (account) => readCodexStatus(directoryOf(account), now),
    async observeIdentity(directory) {
      const status = await readCodexStatus(directory, now);
      return status.email === null ? null : { provider: CODEX_PROVIDER, email: status.email, organisation: null };
    },
    ambientDirectory: () => ambient,
    models: async () => CODEX_MODELS,
    async usage(account) {
      const directory = directoryOf(account);
      const status = await readCodexStatus(directory, now);
      const identity = { provider: CODEX_PROVIDER, email: status.email ?? account.label ?? account.id, organisation: null };
      return readCodexUsage(directory, identity, now);
    },
  };
};

/** Strips terminal colour and cursor sequences, which the CLI's device-flow lines carry. */
// eslint-disable-next-line no-control-regex -- the escape that starts each colour sequence is what is being removed.
const plain = (output: string): string => output.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");

/** The device page the CLI prints, once a whole URL has arrived. */
export const codexVerificationUrl = (output: string): string | null => {
  const url = /(https:\/\/\S+)\s/.exec(plain(output))?.[1];
  return url !== undefined && URL.canParse(url) ? url : null;
};

/** The one-time code the CLI prints for the device page (`ABCD-EFGHI`), once it has. */
export const codexUserCode = (output: string): string | null => /(?:^|\s)([A-Z0-9]{4,}-[A-Z0-9]{4,})(?=\s)/.exec(plain(output))?.[1] ?? null;

/** Whether `codex login --help` says the executable runs the device flow. */
export const runsCodexLogin = (result: ProbeResult): boolean => result.code === 0 && /--device-auth\b/.test(result.stdout);

const posixQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
const powershellQuote = (value: string): string => `'${value.replace(/['‘’‚‛]/g, "$&$&")}'`;

export const codexFallback = (directory: string, executable: string): SignInFallback => {
  const login = CODEX_LOGIN_ARGV.join(" ");
  return {
    posix: `${CODEX_HOME}=${posixQuote(directory)} ${/^[A-Za-z0-9_./:@%+=,-]+$/.test(executable) ? executable : posixQuote(executable)} ${login}`,
    powershell: `$env:${CODEX_HOME} = ${powershellQuote(directory)}; & ${powershellQuote(executable)} ${login}`,
  };
};

/** A Codex sign-in's environment: the host's, scrubbed as a Claude process's is, without an API key, with the account's home. */
export const codexSignInEnvironment = (host: HostEnvironment, directory: string): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(host)) {
    if (value === undefined || isScrubbed(key) || key === "OPENAI_API_KEY" || key === CODEX_HOME || key === CODEX_WORKER_HOME) continue;
    env[key] = value;
  }
  env[CODEX_HOME] = directory;
  return env;
};

export interface CodexSignInOptions {
  readonly hostEnv?: HostEnvironment;
  /** The managed tool `codex`'s path (ADR 0026), the registry's row; null when it is not installed. */
  readonly managedTool: () => string | null | Promise<string | null>;
}

/** The sign-in program the director drives for Codex accounts: the managed tool's `codex login --device-auth`. */
export const codexSignInProgram = (options: CodexSignInOptions): SignInProgram => {
  const hostEnv: HostEnvironment = { ...(options.hostEnv ?? process.env) };
  return {
    bundled: null,
    managedTool: options.managedTool,
    argv: CODEX_LOGIN_ARGV,
    probeArgv: CODEX_LOGIN_HELP_ARGV,
    runsSignIn: runsCodexLogin,
    env: (directory) => codexSignInEnvironment(hostEnv, directory),
    verificationUrl: codexVerificationUrl,
    userCode: codexUserCode,
    fallback: codexFallback,
    toolName: CODEX_TOOL,
  };
};
