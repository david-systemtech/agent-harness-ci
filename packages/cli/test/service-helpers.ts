/**
 * Test helpers for the service verbs: a command runner that records what it
 * is asked to run and answers from a script, a host rooted in a temporary
 * home, and a listing of every path under a directory. Test-only: not under
 * `src/`, so never built or shipped.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { CommandResult, CommandRunner } from "../src/service/runner.js";
import type { ServiceHost } from "../src/service/spec.js";

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

/** A host on `platform` whose home is `home`, user `david`, uid 501. */
export const hostAt = (
  platform: NodeJS.Platform,
  home: string,
  env: Record<string, string | undefined> = {},
): ServiceHost => ({ platform, env, homedir: home, uid: 501, username: "david" });

/** Every file and directory under `root`, relative to it, sorted. */
export const tree = (root: string): string[] =>
  (readdirSync(root, { recursive: true }) as string[]).map((path) => relative(root, join(root, path))).sort();
