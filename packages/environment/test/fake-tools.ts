import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ManagedToolName } from "@agent-harness/contracts";
import type { PackageOwnerLookup } from "../src/managed-tools/package-owner.js";

/**
 * Fake managed tools on a PATH the test sets (key-managers spec, "Testing
 * Decisions"; #373): each an executable shell script that answers
 * `--version` as the test says, prints nothing, or hangs, answers a
 * subcommand the test scripts (`claude doctor`, #374) as it says, and
 * records every call's arguments; placed in the PATH's directory, or
 * elsewhere and linked into it, as a Homebrew Cellar or `node_modules`
 * would place it. The PATH is the one the environment's scripted read of
 * the login shell answers.
 */

export interface FakeTool {
  /** Where the script is. */
  readonly file: string;
  /** Where the PATH finds it: the file itself, or the link to it (`file` when neither is on the PATH). */
  readonly onPath: string;
  /** The argument lists it was called with, in order. */
  calls(): string[][];
}

/** How the fake answers a subcommand the test scripts. */
export interface FakeToolAnswer {
  /** What it prints on standard output; preset nothing. */
  readonly stdout?: string;
  /** What it prints on standard error; preset nothing. */
  readonly stderr?: string;
  /** How it exits; preset 0. */
  readonly exitCode?: number;
  /** Never answers. */
  readonly hang?: boolean;
}

export interface FakeToolOptions {
  /** What `--version` prints; preset `<name> version 1.0.0`. */
  readonly output?: string;
  /** How `--version` exits; preset 0. */
  readonly exitCode?: number;
  /** Never answers `--version`: it sleeps, by the absolute path, since the fake PATH holds no `sleep`. */
  readonly hang?: boolean;
  /** How it answers a call whose first argument is the key (`doctor`); any other call is answered as `--version` is. */
  readonly answers?: Readonly<Record<string, FakeToolAnswer>>;
  /** Where the script is, relative to the fake PATH's root; preset `bin/<name>`, on the PATH itself. */
  readonly at?: string;
  /** The directory, relative to the root, whose `<name>` links to a script placed elsewhere; preset `bin`; null for no link. */
  readonly link?: string | null;
}

export interface FakeToolPath {
  /** The PATH the scripted login shell answers: `bin` under the root, then any other directory added. */
  path(): string;
  /** The root directory the tools and their links live under. */
  readonly root: string;
  /** Puts a fake `name` on the PATH. */
  install(name: ManagedToolName | string, options?: FakeToolOptions): FakeTool;
  /** Adds a directory to the end of the PATH. */
  append(directory: string): void;
}

/** `text` as one single-quoted word of the shell. */
const quoted = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/** The shell that prints `text` and a line end, redirected by `redirect`; nothing when there is no text. */
const printed = (text: string | undefined, redirect: string): string => (text === undefined ? "" : `printf '%s\\n' ${quoted(text)}${redirect}; `);

/** A PATH under `root` with nothing on it yet. */
export const fakeToolPath = (root: string): FakeToolPath => {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const extra: string[] = [];
  return {
    root,
    path: () => [bin, ...extra].join(":"),
    append: (directory) => void extra.push(directory),
    install(name, options = {}) {
      const file = join(root, options.at ?? join("bin", name));
      mkdirSync(dirname(file), { recursive: true });
      const calls = `${file}.calls`;
      const answer = options.hang === true ? "exec /bin/sleep 3600" : `${printed(options.output ?? `${name} version 1.0.0`, "")}exit ${options.exitCode ?? 0}`;
      const scripted = Object.entries(options.answers ?? {}).map(([first, { stdout, stderr, exitCode, hang }]) =>
        hang === true ? `  ${quoted(first)}) exec /bin/sleep 3600 ;;\n` : `  ${quoted(first)}) ${printed(stdout, "")}${printed(stderr, " >&2")}exit ${exitCode ?? 0} ;;\n`,
      );
      const dispatch = scripted.length === 0 ? "" : `case "$1" in\n${scripted.join("")}esac\n`;
      writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n${dispatch}${answer}\n`);
      chmodSync(file, 0o755);
      writeFileSync(calls, "");
      const link = options.link === undefined ? "bin" : options.link;
      const onPath = link === null ? file : join(root, link, name);
      if (onPath !== file) {
        if (existsSync(onPath)) throw new Error(`${onPath} is already on the fake PATH.`);
        mkdirSync(dirname(onPath), { recursive: true });
        symlinkSync(file, onPath);
      }
      return {
        file,
        onPath,
        calls: () =>
          readFileSync(calls, "utf8")
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => line.split(" ")),
      };
    },
  };
};

/** Scripted package-owner answers: the realpaths the test names are owned by the package it names; any other file by none. */
export const scriptedPackageOwners = (owned: Readonly<Record<string, { readonly manager: "dpkg" | "rpm"; readonly package: string } | "unknown">> = {}): PackageOwnerLookup & { readonly asked: string[] } => {
  const asked: string[] = [];
  const lookup = async (realpath: string) => {
    asked.push(realpath);
    const answer = owned[realpath];
    if (answer === undefined) return { kind: "none" } as const;
    if (answer === "unknown") return { kind: "unknown", why: "the package manager did not answer" } as const;
    return { kind: "owned", ...answer } as const;
  };
  return Object.assign(lookup, { asked });
};
