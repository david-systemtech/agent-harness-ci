/**
 * Test helpers for the service verbs: a command runner that records what it
 * is asked to run and answers from a script, an install context rooted in a temporary
 * home, a release's unpacked artefact to install from, and a listing of every
 * path under a directory. Test-only: not under `src/`, so never built or shipped.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { VERSION_CLI_ENTRY } from "../src/launch/versions.js";
import type { CommandResult, CommandRunner } from "../src/service/runner.js";
import type { InstallContext } from "../src/service/spec.js";
import { layOutVersion } from "./launcher-fixtures.js";

/** Answers one command, or leaves it to the preset: exit 0, no output. */
export type Answer = (command: string, args: readonly string[]) => Partial<CommandResult> | undefined;

/** A runner that records each command as one space-joined line and answers it from `answer`. */
export const stubRunner = (answer: Answer = () => undefined) => {
  const calls: string[] = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push([command, ...args].join(" "));
    return { code: 0, stdout: "", stderr: "", ...answer(command, args) };
  };
  return { runner, calls };
};

/** A temporary directory the returned cleanup removes. */
export const makeTempDir = (): { path: string; remove: () => void } => {
  const path = mkdtempSync(join(tmpdir(), "agent-harness-service-"));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
};

/** An install context on `platform` whose home is `home`, user `david`, uid 501. */
export const installContextAt = (
  platform: NodeJS.Platform,
  home: string,
  env: Record<string, string | undefined> = {},
): InstallContext => ({ platform, env, homedir: home, uid: 501, username: "david" });

/** Every file and directory under `root`, relative to it, sorted. */
export const tree = (root: string): string[] =>
  (readdirSync(root, { recursive: true }) as string[]).map((path) => relative(root, join(root, path))).sort();

/** Every path under `root` with its content, or `<dir>` for a folder: equal snapshots mean a byte-for-byte equal tree. */
export const snapshot = (root: string): Record<string, string> =>
  Object.fromEntries(
    tree(root).map((path) => {
      const full = join(root, path);
      return [path, statSync(full).isDirectory() ? "<dir>" : readFileSync(full, "base64")];
    }),
  );

/**
 * `version` unpacked in `home`'s `bundle` folder, outside any data directory,
 * as a desktop carries its bundled artefact; answers the real path of its CLI
 * entry, the running CLI's as `service install` reads it.
 */
export const bundledVersion = (home: string, version = "0.5.0"): string => {
  const root = join(home, "bundle", version);
  layOutVersion(root, version);
  return join(root, ...VERSION_CLI_ENTRY);
};
