import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { LauncherTimer } from "../src/launch/launcher.js";
import { VERSION_SENTINEL, versionCommand, versionDirectory } from "../src/launch/versions.js";

/**
 * What the launcher's tests run against (launcher-update spec, "Testing
 * Decisions"): versions laid out in a temporary data directory whose program
 * is the scripted child, or any TypeScript entry, and a timer the test
 * drives by hand.
 */

/** The scripted child: a small Node program standing in for `serve`. */
export const SCRIPTED_CHILD = new URL("./scripted-child.ts", import.meta.url).pathname;

/** The file in the data directory the scripted child reads its starts from. */
export const CHILD_SCRIPT_FILE = "child-script.json";
/** The file in the data directory the scripted child appends what happened to, one JSON line each. */
export const CHILD_REPORT_FILE = "child-report.jsonl";

/**
 * What the scripted child does at one start:
 * - `serve`: says `prepared`, and once committed reports `committed`, asks `versions?`, answers `idle?`, and drains on `drain?` or SIGTERM
 * - `drain`: as `serve`, but drains by itself as soon as it is committed, as `environment.drain` does
 * - `crash-after-commit`: as `serve`, but exits 3 as soon as it is committed
 * - `deaf-once`: as `serve`, but passes over the first `drain?`, as a child not yet answering queries does
 * - `crash`: exits 1 at once, before `prepared`
 * - `exit-0`: exits 0 at once, before `prepared`
 * - `silent`: never says `prepared`, and stays until it is ended
 */
export type ChildStart = "serve" | "drain" | "crash-after-commit" | "deaf-once" | "crash" | "exit-0" | "silent";

/** One line of the scripted child's report: which start, as which process, of which version, and what happened. */
export interface ChildEvent {
  readonly start: number;
  readonly pid: number;
  readonly version: string;
  readonly event: string;
  readonly [detail: string]: unknown;
}

const tsx = createRequire(import.meta.url).resolve("tsx");

/** `text` as one word to a POSIX shell. */
const shellWord = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * Installs `version` complete in `dataDir`'s versions directory, laid out as
 * the launcher runs it, with `entry` (a TypeScript file) as its CLI: the
 * version's Node runtime is a shell script running this Node with tsx and the
 * workspace's source condition, so it runs on POSIX only.
 */
export const installVersion = (dataDir: string, version: string, entry: string = SCRIPTED_CHILD): void => {
  const folder = versionDirectory(dataDir, version);
  const [node, main] = versionCommand(folder, "linux");
  mkdirSync(dirname(node), { recursive: true });
  writeFileSync(node, `#!/bin/sh\nexec ${[process.execPath, "--conditions=@agent-harness/source", "--import", tsx].map(shellWord).join(" ")} "$@"\n`);
  chmodSync(node, 0o755);
  mkdirSync(dirname(main), { recursive: true });
  writeFileSync(main, `import ${JSON.stringify(pathToFileURL(entry).href)};\n`);
  writeFileSync(join(dirname(main), "..", "package.json"), `${JSON.stringify({ type: "module", version })}\n`);
  writeFileSync(join(folder, VERSION_SENTINEL), "");
};

/** Tells the scripted child what to do at each start in `dataDir`, in order; past the last it serves. */
export const scriptChild = (dataDir: string, starts: readonly ChildStart[]): void =>
  writeFileSync(join(dataDir, CHILD_SCRIPT_FILE), JSON.stringify(starts));

/** Everything the scripted children in `dataDir` reported, in order. */
export const childReport = (dataDir: string): ChildEvent[] => {
  const path = join(dataDir, CHILD_REPORT_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as ChildEvent);
};

/** Waits until `check` holds, polling, and fails with `what` after fifteen seconds (a loaded runner spawns slowly). */
export const until = async (what: string, check: () => boolean): Promise<void> => {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting until ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** A timer the test drives: time moves only when the test says, and a wait runs only when the test runs it. */
export interface FakeTimer extends LauncherTimer {
  /** The waits scheduled and neither run nor cancelled, in milliseconds, in the order they were asked for. */
  pending(): number[];
  /** Moves the clock on by `ms` without running anything. */
  advance(ms: number): void;
  /** Runs the earliest-asked pending wait, moving the clock on by its length; throws when none is pending. */
  runNext(): void;
}

export const fakeTimer = (start = Date.parse("2026-09-28T12:00:00.000Z")): FakeTimer => {
  let now = start;
  const waits: { readonly ms: number; readonly run: () => void; done: boolean }[] = [];
  const live = () => waits.filter((wait) => !wait.done);
  return {
    now: () => now,
    after(ms, run) {
      const wait = { ms, run, done: false };
      waits.push(wait);
      return () => void (wait.done = true);
    },
    pending: () => live().map((wait) => wait.ms),
    advance(ms) {
      now += ms;
    },
    runNext() {
      const wait = live()[0];
      if (wait === undefined) throw new Error("No wait is pending.");
      wait.done = true;
      now += wait.ms;
      wait.run();
    },
  };
};
