import { execFile } from "node:child_process";
import type { ShellGh, ShellPlatform } from "@agent-harness/client-runtime";
import { text } from "./arguments.js";

/**
 * The shell's `gh` (forge spec, "Credentials": the attending client's
 * `gh`; ADR 0032; #419): the token this computer's `gh` holds for a host,
 * as `gh auth token --hostname <host>` prints it for the account active
 * there, which the renderer's runtime hands over once in
 * `forge.accounts.add` and keeps nowhere. It is read only when the renderer
 * asks, one host at a time.
 *
 * `gh` runs without `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` and
 * `GITHUB_ENTERPRISE_TOKEN`, so it reports the account it stores rather
 * than a variable the desktop happened to inherit, as the environment runs
 * its own `gh` (forge spec, "Credentials"). A desktop started from the
 * macOS Finder or a Linux launcher gets a short `PATH`, so the places a
 * package manager puts `gh` are looked in after it.
 */

/** What a run of `gh` came to: its exit code, and what it printed. */
export interface GhRan {
  readonly code: number;
  readonly stdout: string;
}

/** How `gh` is run: to its end, with `args` and the variables given. Rejects when it could not be run: not installed (`ENOENT`), or no answer in time. */
export interface GhProcess {
  run(args: readonly string[], env: Readonly<Record<string, string | undefined>>): Promise<GhRan>;
}

/** Ten seconds, the forge's own budget for a verification (ADR 0031), for `gh` to print a token it keeps. */
const GH_TIMEOUT_MS = 10_000;

export const NODE_GH_PROCESS: GhProcess = {
  run: (args, env) =>
    new Promise((settle, reject) => {
      execFile("gh", [...args], { env, windowsHide: true, encoding: "utf8", timeout: GH_TIMEOUT_MS }, (error, stdout) => {
        if (error === null) settle({ code: 0, stdout });
        else if (typeof error.code === "number") settle({ code: error.code, stdout });
        else if (error.killed) reject(new Error(`gh did not answer within ${String(GH_TIMEOUT_MS / 1000)} seconds.`));
        else reject(error);
      });
    }),
};

/** The variables that would make `gh` answer with a token other than the one it stores. */
const TOKEN_VARIABLES = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];

/** Where a package manager puts `gh` on each platform, beyond a launch's `PATH`: Homebrew's two prefixes on macOS, `/usr/local/bin` and Linuxbrew's on Linux. */
const GH_PLACES: Readonly<Record<ShellPlatform, readonly string[]>> = {
  darwin: ["/opt/homebrew/bin", "/usr/local/bin"],
  linux: ["/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"],
  win32: [],
};

/** A host as `gh` names one: a name or an IPv6 literal in brackets, with a port when it has one; never an option or a URL. */
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?$/;

const hostOf = (value: unknown): string => {
  const host = text(value, "A gh host");
  if (!HOST.test(host)) throw new TypeError(`gh names a host as github.com or host:port, not ${JSON.stringify(host)}.`);
  return host;
};

/** Whether `error` says the program was not found. */
const notInstalled = (error: unknown): boolean => typeof error === "object" && error !== null && (error as { readonly code?: unknown }).code === "ENOENT";

export interface GhParts {
  readonly os: ShellPlatform;
  readonly process: GhProcess;
  /** The desktop's own variables, which `gh` runs with less the token ones. */
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export const computerGh = ({ os, process, environment }: GhParts): { readonly token: (host: unknown) => ReturnType<ShellGh["token"]> } => {
  const places = GH_PLACES[os];
  const path = [...new Set([...(environment["PATH"] ?? "").split(":").filter((part) => part !== ""), ...places])].join(":");
  // Windows names its PATH as it likes and puts gh on it at install: it is left as it is.
  const env = { ...Object.fromEntries(Object.entries(environment).filter(([name]) => !TOKEN_VARIABLES.includes(name))), ...(places.length > 0 && { PATH: path }) };
  return {
    token: async (given) => {
      const host = hostOf(given);
      let ran: GhRan;
      try {
        ran = await process.run(["auth", "token", "--hostname", host], env);
      } catch (error) {
        if (notInstalled(error)) return undefined;
        throw error;
      }
      const token = ran.stdout.trim();
      return ran.code === 0 && token !== "" ? token : undefined;
    },
  };
};
