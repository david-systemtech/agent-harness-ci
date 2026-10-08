import { spawn } from "node:child_process";
import { GH_MINIMUM_VERSION, GhLogin, ForgeToken, compareToolVersions, type ForgeTokenKind, type GhProbe, type GhSignedInAccount, type ManagedToolRow } from "@agent-harness/contracts";
import type { HostEnvironment } from "../adapters/claude/credentials.js";
import { GH_MISSING, GH_OLD, ghLoginCommand, ghSignedOut } from "./lines.js";
import { githubTokenKind } from "./providers.js";

/**
 * The environment's own `gh` (forge spec, "Credentials"; ADR 0026, ADR
 * 0032): a Managed tools row, minimum 2.40, verified by `gh auth status`,
 * whose token a `gh` credential source reads with `gh auth token` for the
 * forge account's host and login on every operation. Whether it is
 * installed, where and which version is the Managed tools registry's `gh`
 * row (#373); this runs the `gh` the row found.
 *
 * `gh` runs without the variables it reads a token from before its own
 * store (`GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` and
 * `GITHUB_ENTERPRISE_TOKEN`), so it answers for the accounts it stores and
 * never for a token some other tool exported; with prompts and the update
 * notice off, so it never waits on a person or prints anything else.
 */

/** The variables `gh` takes a token from ahead of its own store: none of them reaches it. */
export const GH_TOKEN_VARIABLES = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] as const;

/** How long one `gh` call may take (ADR 0031's budget): `gh auth status` asks each host's API about each account. */
export const GH_TIMEOUT_MS = 10_000;

/** What `gh` answered for a host and login's token. */
export type GhTokenAnswer =
  /** The token `gh` holds for them. */
  | { readonly outcome: "token"; readonly token: string }
  /**
   * No token: one plain line saying why (setup-copy.md §5.6), `gh` missing,
   * older than 2.40, not signed in to the host as the login, or failing; and
   * the raw facts behind it, its version, the command that signs it in or
   * what it said.
   */
  | { readonly outcome: "unavailable"; readonly message: string; readonly details: readonly string[] };

/** The forge's view of the environment's `gh`, over the Managed tools registry's row. */
export interface ManagedGh {
  /** Whether `gh` is installed, its version against the minimum, and the accounts `gh auth status` reports signed in. */
  probe(): Promise<GhProbe>;
  /** The token `gh auth token` prints for `host` and `login`, read now. */
  token(host: string, login: string): Promise<GhTokenAnswer>;
}

export interface ManagedGhOptions {
  /** The Managed tools registry's `gh` row, once any probe under way has ended. */
  readonly row: () => Promise<ManagedToolRow>;
  /** The environment `gh` runs in, less the token variables. Preset: this process's, copied once. */
  readonly hostEnv?: HostEnvironment;
  /** Preset `GH_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** How one run of `gh` went. */
type GhRun =
  | { readonly outcome: "ran"; readonly code: number | null; readonly stdout: string; readonly stderr: string }
  /** No `gh` where the row found it. */
  | { readonly outcome: "missing" }
  /** It did not finish: a timeout, or it could not start for another reason, in a few words. */
  | { readonly outcome: "failed"; readonly why: string };

/** More output than any of the commands run here prints; past it, the rest is dropped. */
const OUTPUT_CAP = 256 * 1024;

/** Whether `version` is the minimum or later. */
const meetsMinimum = (version: string): boolean => compareToolVersions(version, GH_MINIMUM_VERSION) >= 0;

/** `'gist', 'read:org', 'repo'` as `gh` lists scopes; `none` for none. */
const scopesOf = (listed: string): string[] =>
  listed.trim() === "none"
    ? []
    : listed
        .split(",")
        .map((scope) => scope.trim().replace(/^'(.*)'$/, "$1"))
        .filter((scope) => scope !== "");

/** An account line: `✓ Logged in to github.com account david (keyring)`, or before 2.40 `... github.com as david (...)`. */
const LOGGED_IN = /^\s+\S+ Logged in to (\S+) (?:account|as) (\S+) \(/;
/** An account `gh` holds but could not use: its token invalid, or its host timing out. */
const NOT_USABLE = /^\s+\S+ (?:Failed to log in|Timeout trying to log in) to /;
const ACTIVE = /^\s+- Active account: (true|false)\s*$/;
const TOKEN = /^\s+- Token: (\S+)/;
const SCOPES = /^\s+- Token scopes: (.*)$/;

/**
 * The accounts `gh auth status` reports signed in with a usable token, in
 * its order: the text form every `gh` from 2.40 prints (on standard output,
 * or on standard error when an account has a problem), whose account lines
 * name the host and login and whose detail lines follow. An account before
 * 2.40's multi-account support is its host's active one.
 */
export const parseGhAuthStatus = (text: string): GhSignedInAccount[] => {
  const accounts: GhSignedInAccount[] = [];
  let current: { host: string; login: string; active: boolean; tokenKind: ForgeTokenKind; scopes: string[] | null } | null = null;
  const close = (): void => {
    if (current !== null && GhLogin.safeParse(current.login).success) accounts.push({ ...current });
    current = null;
  };
  for (const line of text.split(/\r?\n/)) {
    const account = LOGGED_IN.exec(line);
    if (account !== null) {
      close();
      current = { host: account[1] ?? "", login: account[2] ?? "", active: true, tokenKind: "unknown", scopes: null };
      continue;
    }
    if (NOT_USABLE.test(line) || !/^\s/.test(line)) {
      close();
      continue;
    }
    if (current === null) continue;
    const active = ACTIVE.exec(line);
    if (active !== null) current.active = active[1] === "true";
    const token = TOKEN.exec(line);
    if (token !== null) current.tokenKind = githubTokenKind(token[1] ?? "");
    const scopes = SCOPES.exec(line);
    if (scopes !== null) current.scopes = scopesOf(scopes[1] ?? "");
  }
  close();
  return accounts;
};

/** The environment `gh` runs in: the host's, without the token variables, never prompting or checking for updates. */
const ghEnvironment = (hostEnv: HostEnvironment): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(hostEnv)) {
    if (value !== undefined && !(GH_TOKEN_VARIABLES as readonly string[]).includes(name.toUpperCase())) env[name] = value;
  }
  return { ...env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" };
};

/** The `gh` the Managed tools registry's row found, run for real. */
export const managedGh = (options: ManagedGhOptions): ManagedGh => {
  const env = ghEnvironment({ ...(options.hostEnv ?? process.env) });
  const timeoutMs = options.timeoutMs ?? GH_TIMEOUT_MS;

  const run = (file: string, args: readonly string[]): Promise<GhRun> =>
    new Promise((resolve) => {
      // A gh that is gone since the row found it is reported through the error event, as ENOENT.
      const child = spawn(file, [...args], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const out: string[] = [];
      const err: string[] = [];
      let size = 0;
      const collect = (into: string[]) => (chunk: Buffer) => {
        if (size >= OUTPUT_CAP) return;
        size += chunk.length;
        into.push(chunk.toString("utf8"));
      };
      child.stdout.on("data", collect(out));
      child.stderr.on("data", collect(err));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ outcome: "failed", why: `no answer within ${timeoutMs / 1000} s` });
      }, timeoutMs);
      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        resolve(error.code === "ENOENT" ? { outcome: "missing" } : { outcome: "failed", why: `it could not be started (${error.code ?? "error"})` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ outcome: "ran", code, stdout: out.join(""), stderr: err.join("") });
      });
    });

  const notInstalled = (host: string, login: string): GhTokenAnswer => ({
    outcome: "unavailable",
    message: GH_MISSING,
    details: [`Needs gh ${GH_MINIMUM_VERSION} or later, then ${ghLoginCommand(host, login)}`],
  });

  /** The row, or null when the registry has none to give: it never probed, the environment closing first. */
  const rowNow = async (): Promise<ManagedToolRow | null> => {
    try {
      return await options.row();
    } catch (error) {
      console.error("The Managed tools registry gave no gh row:", error);
      return null;
    }
  };

  return {
    async probe() {
      const row = await rowNow();
      if (row === null || row.path === null) return { installed: false, version: null, minimum: GH_MINIMUM_VERSION, meetsMinimum: false, accounts: [] };
      const status = await run(row.path, ["auth", "status"]);
      return {
        installed: true,
        version: row.version,
        minimum: GH_MINIMUM_VERSION,
        meetsMinimum: row.version !== null && meetsMinimum(row.version),
        accounts: status.outcome === "ran" ? parseGhAuthStatus(`${status.stdout}\n${status.stderr}`) : [],
      };
    },

    async token(host, login) {
      const row = await rowNow();
      if (row === null) return { outcome: "unavailable", message: "agent-harness has not looked for the gh tool yet. Choose Check again.", details: ["The Managed tools registry has not probed gh."] };
      if (row.path === null) return notInstalled(host, login);
      const answer = await run(row.path, ["auth", "token", "--hostname", host, "--user", login]);
      if (answer.outcome === "missing") return notInstalled(host, login);
      if (answer.outcome === "failed") return { outcome: "unavailable", message: `The gh tool did not give a token for ${login} on ${host}.`, details: [`gh auth token: ${answer.why}`] };
      const token = answer.stdout.trim();
      if (answer.code === 0 && ForgeToken.safeParse(token).success) return { outcome: "token", token };
      // Why not: a gh older than 2.40 refuses --user; otherwise it holds no token for the host and login.
      if (row.version !== null && !meetsMinimum(row.version)) {
        return { outcome: "unavailable", message: GH_OLD, details: [`gh ${row.version} is older than ${GH_MINIMUM_VERSION}, the first that gives a token per account.`] };
      }
      return { outcome: "unavailable", message: ghSignedOut(host), details: [ghLoginCommand(host, login)] };
    },
  };
};
