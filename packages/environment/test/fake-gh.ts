import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostEnvironment } from "../src/adapters/claude/credentials.js";
import { GH_TOKEN_VARIABLES } from "../src/forge/gh.js";

/**
 * A fake `gh` on a PATH the test sets (forge spec, "Testing Decisions";
 * #312), which the Managed tools registry finds (#373): an executable named
 * `gh` that prints a version, `gh auth status` in the text form every `gh`
 * from 2.40 prints, and a token per host and login from `gh auth token`,
 * from a state the test scripts and changes. A version before 2.40 refuses
 * `--user` as those did. Every call is recorded with its arguments and the
 * names of the token variables it saw, never a value.
 */

/** An account the fake `gh` holds. */
export interface FakeGhAccount {
  readonly host: string;
  readonly login: string;
  readonly token: string;
  /** Whether it is its host's active account; preset: the first on its host is. */
  readonly active?: boolean;
  /** The scopes `gh auth status` reports for a classic or OAuth token; preset none. */
  readonly scopes?: readonly string[];
  /** Whether its token still works; preset true. One that does not is reported as failing to log in, and `gh auth status` exits 1. */
  readonly valid?: boolean;
}

export interface FakeGhState {
  /** The version it reports; preset `2.40.0`. */
  readonly version?: string;
  readonly accounts?: readonly FakeGhAccount[];
}

/** One call as the fake `gh` saw it. */
export interface FakeGhCall {
  readonly argv: readonly string[];
  /** Which of the variables `gh` takes a token from were in its environment, by name. */
  readonly sawTokenVariables: readonly string[];
}

export interface FakeGh {
  /** The directory holding the fake `gh`: the PATH the Managed tools registry finds it on. */
  readonly bin: string;
  /** A host environment whose PATH holds the fake `gh` and nothing else, with every token variable set, as another tool might leave them. */
  readonly hostEnv: HostEnvironment;
  /** What an environment is started with to find the fake `gh` and run it from `hostEnv`: its login shell's PATH is `bin`. */
  readonly managedTools: { readonly readPath: () => Promise<string>; readonly hostEnv: HostEnvironment };
  /** Replaces what it holds and reports. */
  set(state: FakeGhState): void;
  /** Every call so far, in order. */
  calls(): FakeGhCall[];
  /** Holds token calls until released, and reports when one has reached the gate. */
  holdTokens(): { readonly started: Promise<void>; readonly release: () => void };
}

/** The fake `gh`'s program, run by the node running the tests. */
const PROGRAM = String.raw`
import { appendFileSync, existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(readFileSync(join(here, "state.json"), "utf8"));
const argv = process.argv.slice(2);
const TOKEN_VARIABLES = ${JSON.stringify(GH_TOKEN_VARIABLES)};
appendFileSync(join(here, "calls.jsonl"), JSON.stringify({ argv, sawTokenVariables: TOKEN_VARIABLES.filter((name) => process.env[name] !== undefined) }) + "\n");

// A test can hold a real token process while another client call or probe runs.
const gate = join(here, "hold-token");
if (argv[0] === "auth" && argv[1] === "token" && existsSync(gate)) {
  await new Promise((resolve) => {
    const changed = () => {
      if (!existsSync(gate)) { watcher.close(); resolve(); }
    };
    const watcher = watch(here, changed);
    writeFileSync(join(here, "token-started"), "");
    changed();
  });
}

const version = state.version ?? "2.40.0";
const [major, minor] = version.split(".").map(Number);
const multiAccount = major > 2 || (major === 2 && minor >= 40);
const accounts = state.accounts ?? [];
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const activeOn = (host) => accounts.find((a) => a.host === host && a.active === true) ?? accounts.find((a) => a.host === host);
const exit = (stream, text, code) => {
  stream.write(text);
  process.exit(code);
};

if (argv[0] === "--version") exit(process.stdout, "gh version " + version + " (2026-01-01)\nhttps://github.com/cli/cli/releases/tag/v" + version + "\n", 0);

if (argv[0] === "auth" && argv[1] === "token") {
  const user = flag("--user");
  if (user !== undefined && !multiAccount) exit(process.stderr, "unknown flag: --user\n\nUsage:  gh auth token [flags]\n", 1);
  const host = flag("--hostname") ?? "github.com";
  const account = user === undefined ? activeOn(host) : accounts.find((a) => a.host === host && a.login === user);
  if (account === undefined) exit(process.stderr, "no oauth token found for " + host + (user === undefined ? "" : " account " + user) + "\n", 1);
  exit(process.stdout, account.token + "\n", 0);
}

if (argv[0] === "auth" && argv[1] === "status") {
  if (accounts.length === 0) exit(process.stderr, "You are not logged into any GitHub hosts. To log in, run: gh auth login\n", 1);
  const masked = (token) => {
    const at = token.lastIndexOf("_");
    const prefix = at === -1 ? "" : token.slice(0, at + 1);
    return prefix + "*".repeat(token.length - prefix.length);
  };
  const entry = (account, active) => {
    const { host, login } = account;
    if (account.valid === false) {
      return "  X Failed to log in to " + host + " account " + login + " (keyring)\n  - Active account: " + active + "\n  - The token in keyring is invalid.\n" +
        "  - To re-authenticate, run: gh auth login -h " + host + "\n  - To forget about this account, run: gh auth logout -h " + host + " -u " + login + "\n";
    }
    let text = "  ✓ Logged in to " + host + " account " + login + " (keyring)\n  - Active account: " + active + "\n  - Git operations protocol: https\n  - Token: " + masked(account.token) + "\n";
    if (account.token.startsWith("ghp_") || account.token.startsWith("gho_")) {
      const scopes = account.scopes ?? [];
      text += "  - Token scopes: " + (scopes.length === 0 ? "none" : scopes.map((scope) => "'" + scope + "'").join(", ")) + "\n";
    }
    return text;
  };
  const hosts = [...new Set(accounts.map((a) => a.host))];
  const text = hosts
    .map((host) => {
      const active = activeOn(host);
      const ordered = [active, ...accounts.filter((a) => a.host === host && a !== active)];
      return host + "\n" + ordered.map((account) => entry(account, account === active)).join("\n");
    })
    .join("\n");
  const failing = accounts.some((a) => a.valid === false);
  exit(failing ? process.stderr : process.stdout, text, failing ? 1 : 0);
}

exit(process.stderr, "unknown command " + argv.join(" ") + "\n", 1);
`;

/** Puts a fake `gh` holding `state` in `directory`, the only thing on the PATH its host environment names. */
export const installFakeGh = (directory: string, state: FakeGhState = {}): FakeGh => {
  const bin = join(directory, "bin");
  mkdirSync(bin, { recursive: true });
  const program = join(directory, "fake-gh.mjs");
  writeFileSync(program, PROGRAM);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nexec '${process.execPath}' '${program}' "$@"\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const set = (next: FakeGhState): void => writeFileSync(join(directory, "state.json"), JSON.stringify(next));
  set(state);
  writeFileSync(join(directory, "calls.jsonl"), "");
  const hostEnv: HostEnvironment = { PATH: bin, HOME: directory, ...Object.fromEntries(GH_TOKEN_VARIABLES.map((name) => [name, "stray-token"])) };
  return {
    bin,
    hostEnv,
    managedTools: { readPath: async () => bin, hostEnv },
    set,
    holdTokens() {
      const gate = join(directory, "hold-token");
      const marker = join(directory, "token-started");
      rmSync(marker, { force: true });
      writeFileSync(gate, "");
      let watcher: ReturnType<typeof watch>;
      const started = new Promise<void>((resolve) => {
        const changed = () => {
          if (existsSync(marker)) {
            watcher.close();
            resolve();
          }
        };
        watcher = watch(directory, changed);
        changed();
      });
      return {
        started,
        release: () => {
          watcher.close();
          rmSync(gate, { force: true });
        },
      };
    },
    calls: () =>
      readFileSync(join(directory, "calls.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as FakeGhCall),
  };
};
