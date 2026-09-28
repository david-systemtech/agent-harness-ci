import { spawn } from "node:child_process";
import { GH_MINIMUM_VERSION, GhLogin, ForgeToken, type ForgeTokenKind, type GhProbe, type GhSignedInAccount } from "@agent-harness/contracts";
import type { HostEnvironment } from "../adapters/claude/credentials.js";
import { githubTokenKind } from "./providers.js";

/**
 * The environment's own `gh` (forge spec, "Credentials"; ADR 0026, ADR
 * 0032): a Managed tools row, minimum 2.40, verified by `gh auth status`,
 * whose token a `gh` credential source reads with `gh auth token` for the
 * forge account's host and login on every operation. Until the Managed
 * tools registry (#91) exists, the ForgeService reaches `gh` through this
 * seam, which the registry replaces.
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
  /** No token, and one line saying why and what to do: `gh` missing, older than 2.40, not signed in to the host as the login, or failing. */
  | { readonly outcome: "unavailable"; readonly message: string };

/** The Managed tools seam for `gh`: #91's registry replaces it. */
export interface ManagedGh {
  /** Whether `gh` is installed, its version against the minimum, and the accounts `gh auth status` reports signed in. */
  probe(): Promise<GhProbe>;
  /** The token `gh auth token` prints for `host` and `login`, read now. */
  token(host: string, login: string): Promise<GhTokenAnswer>;
}

export interface ManagedGhOptions {
  /** The environment `gh` runs in, found on its PATH, less the token variables. Preset: this process's, copied once. */
  readonly hostEnv?: HostEnvironment;
  /** Preset `GH_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** How one run of `gh` went. */
type GhRun =
  | { readonly outcome: "ran"; readonly code: number | null; readonly stdout: string; readonly stderr: string }
  /** No `gh` on the PATH. */
  | { readonly outcome: "missing" }
  /** It did not finish: a timeout, or it could not start for another reason, in a few words. */
  | { readonly outcome: "failed"; readonly why: string };

/** More output than any of the commands run here prints; past it, the rest is dropped. */
const OUTPUT_CAP = 256 * 1024;

/** A version as `gh --version`'s first line says it: `gh version 2.63.2 (2024-12-05)`. */
const VERSION_LINE = /^gh version (\d+)\.(\d+)\.(\d+)\b/m;

const parseVersion = (stdout: string): readonly [number, number, number] | null => {
  const match = VERSION_LINE.exec(stdout);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
};

const MINIMUM = GH_MINIMUM_VERSION.split(".").map(Number) as [number, number, number];

/** Whether `version` is the minimum or later. */
const meetsMinimum = (version: readonly [number, number, number]): boolean => {
  for (let at = 0; at < 3; at += 1) if (version[at] !== MINIMUM[at]) return (version[at] ?? 0) > (MINIMUM[at] ?? 0);
  return true;
};

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

/** The `gh` on the host environment's PATH, run for real. */
export const managedGh = (options: ManagedGhOptions = {}): ManagedGh => {
  const env = ghEnvironment({ ...(options.hostEnv ?? process.env) });
  const timeoutMs = options.timeoutMs ?? GH_TIMEOUT_MS;

  const run = (args: readonly string[]): Promise<GhRun> =>
    new Promise((resolve) => {
      // A gh that is not on the PATH is reported through the error event, as ENOENT.
      const child = spawn("gh", [...args], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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

  /** `gh --version`: missing, or installed with the version it reports, null when it reports none. */
  const version = async (): Promise<{ readonly installed: false } | { readonly installed: true; readonly version: readonly [number, number, number] | null }> => {
    const answer = await run(["--version"]);
    if (answer.outcome === "missing") return { installed: false };
    return { installed: true, version: answer.outcome === "ran" && answer.code === 0 ? parseVersion(answer.stdout) : null };
  };

  const notInstalled = (host: string): string => `gh is not installed on this environment: install the GitHub CLI ${GH_MINIMUM_VERSION} or later, then run gh auth login --hostname ${host}.`;

  return {
    async probe() {
      const found = await version();
      if (!found.installed) return { installed: false, version: null, minimum: GH_MINIMUM_VERSION, meetsMinimum: false, accounts: [] };
      const status = await run(["auth", "status"]);
      return {
        installed: true,
        version: found.version === null ? null : found.version.join("."),
        minimum: GH_MINIMUM_VERSION,
        meetsMinimum: found.version !== null && meetsMinimum(found.version),
        accounts: status.outcome === "ran" ? parseGhAuthStatus(`${status.stdout}\n${status.stderr}`) : [],
      };
    },

    async token(host, login) {
      const answer = await run(["auth", "token", "--hostname", host, "--user", login]);
      if (answer.outcome === "missing") return { outcome: "unavailable", message: notInstalled(host) };
      if (answer.outcome === "failed") return { outcome: "unavailable", message: `gh on this environment did not give a token for ${login} on ${host}: ${answer.why}.` };
      const token = answer.stdout.trim();
      if (answer.code === 0 && ForgeToken.safeParse(token).success) return { outcome: "token", token };
      // Why not: a gh older than 2.40 refuses --user; otherwise it holds no token for the host and login.
      const found = await version();
      if (!found.installed) return { outcome: "unavailable", message: notInstalled(host) };
      if (found.version !== null && !meetsMinimum(found.version)) {
        return { outcome: "unavailable", message: `gh ${found.version.join(".")} on this environment is older than ${GH_MINIMUM_VERSION}, the first that reads a token per account: update gh.` };
      }
      return { outcome: "unavailable", message: `gh on this environment is not signed in to ${host} as ${login}: run gh auth login --hostname ${host} as ${login} here.` };
    },
  };
};
