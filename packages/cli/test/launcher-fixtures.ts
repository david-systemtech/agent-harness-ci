import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DATABASE_FILE, LAUNCHER_PROTOCOL, STAGING_DIRECTORY, type PreflightReport } from "@agent-harness/contracts/launcher";
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

/** The scripted preflight: a small Node program standing in for a version's `preflight`, which a version run with the scripted child answers `preflight` with. */
export const SCRIPTED_PREFLIGHT = new URL("./scripted-preflight.ts", import.meta.url).pathname;

/** The file in the data directory the scripted child reads its starts from. */
export const CHILD_SCRIPT_FILE = "child-script.json";
/** The file in the data directory the scripted child appends what happened to, one JSON line each. */
export const CHILD_REPORT_FILE = "child-report.jsonl";

/**
 * What the scripted child does at one start:
 * - `serve`: says `prepared`, and once committed reports `committed` with the service state it then finds, asks `versions?`, answers `idle?` (idle, unless its start says `busyFor`), and drains on `drain?` or SIGTERM
 * - `drain`: as `serve`, but drains by itself as soon as it is committed, as `environment.drain` does
 * - `crash-after-commit`: as `serve`, but exits 3 as soon as it is committed
 * - `deaf-once`: as `serve`, but passes over the first `drain?`, as a child not yet answering queries does
 * - `crash`: exits 1 at once, before `prepared`
 * - `exit-0`: exits 0 at once, before `prepared`
 * - `silent`: never says `prepared`, and stays until it is ended
 */
export type ChildBehaviour = "serve" | "drain" | "crash-after-commit" | "deaf-once" | "crash" | "exit-0" | "silent";

/** A start that does more than its behaviour (preset `serve`) says. */
export interface ScriptedStart {
  readonly behaviour?: ChildBehaviour;
  /** Written to the database before anything else, even the `started` report, and the database left open, as a version's migrations write and a crash leaves them. */
  readonly writes?: readonly string[];
  /** The version it says `prepared` for, in place of its own. */
  readonly preparedAs?: string;
  /** Puts a folder in the service state's place before it says `prepared`, so the launcher can no longer write the state. */
  readonly spoilsState?: true;
  /**
   * Once committed, asks `switch?` for this update in place of `versions?`,
   * as an environment does once its drain has ended. It reports `switching`
   * with the pending-update record it then finds in the service state, and
   * after either answer closes its channel and exits 0, unless it `lingers`,
   * staying until it is ended.
   */
  readonly switchTo?: { readonly updateId: string; readonly version: string; readonly lingers?: true };
  /**
   * Once committed, asks `install?` for this version and staged folder in
   * place of `versions?`, as an environment does once it has staged an
   * update. It reports `install-answered` with the answer and what it then
   * finds: whether the version's sentinel is in the versions directory and
   * whether the staged folder is still there. It goes on serving.
   */
  readonly install?: { readonly version: string; readonly staged: string };
  /** How many of the launcher's `idle?` it answers busy with a run running before it answers idle. Preset: none. */
  readonly busyFor?: number;
  /**
   * Before it says `prepared`, says its OS keychain read waits on the person
   * (`credential-access` `waiting`) and reports `credential-waiting`; once
   * the test writes `CREDENTIAL_ANSWER_FILE` it says how the person answered:
   * `answered` goes on to `prepared`, `refused` exits 1, as a start whose
   * signing key cannot be read does.
   */
  readonly credential?: "answered" | "refused";
}

/** The file in the data directory a scripted child waiting on its stored key (`credential`) waits for: the person answering the OS's prompt. */
export const CREDENTIAL_ANSWER_FILE = "credential-answer";

export type ChildStart = ChildBehaviour | ScriptedStart;

/** One line of the scripted child's report: which start, as which process, of which version, and what happened. Each start reports `started` first, with the names in the data directory as it found them. */
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
 * What the scripted preflight does (preset `pass`):
 * - `pass`: prints a report for its version and the launcher protocol its package declares, and exits 0
 * - `fail`: says on standard error that node-pty did not load, and exits 1
 * - `hang`: says it is loading SQLite, and never exits
 */
export type PreflightBehaviour = "pass" | "fail" | "hang";

/** The scripted preflight's script, in its version's folder. */
export interface ScriptedPreflight {
  readonly behaviour?: PreflightBehaviour;
  /** Parts its report gives in place of its own. */
  readonly reports?: Partial<PreflightReport>;
  /** The file each run appends one JSON line to: its version, arguments and pid. */
  readonly runs?: string;
}

/** The scripted preflight's script's file in a version's folder. */
export const PREFLIGHT_SCRIPT_FILE = "preflight-script.json";
/** The file in the data directory staged versions' preflights report their runs to (`stageVersion`). */
export const PREFLIGHT_RUNS_FILE = "preflight-runs.jsonl";

/** What a version declares of itself beyond its version, and how its scripted preflight behaves. */
export interface VersionLayout {
  /** The launcher protocol its CLI's package declares. Preset: this build's. */
  readonly launcherProtocol?: number;
  /** Its scripted preflight's script, when it runs the scripted child. */
  readonly preflight?: ScriptedPreflight;
}

/**
 * Lays out `version` in `folder` as a release's server artefact unpacks,
 * with `entry` (a TypeScript file) as its CLI: the version's Node runtime is
 * a shell script running this Node with tsx and the workspace's source
 * condition, so it runs on POSIX only. A version run with the scripted child
 * answers `preflight` with the scripted preflight. It writes no sentinel.
 */
export const layOutVersion = (folder: string, version: string, entry: string = SCRIPTED_CHILD, layout: VersionLayout = {}): void => {
  const [node, main] = versionCommand(folder, "linux");
  mkdirSync(dirname(node), { recursive: true });
  writeFileSync(node, `#!/bin/sh\nexec ${[process.execPath, "--conditions=@agent-harness/source", "--import", tsx].map(shellWord).join(" ")} "$@"\n`);
  chmodSync(node, 0o755);
  mkdirSync(dirname(main), { recursive: true });
  const program = JSON.stringify(pathToFileURL(entry).href);
  writeFileSync(
    main,
    entry === SCRIPTED_CHILD
      ? `await import(process.argv[2] === "preflight" ? ${JSON.stringify(pathToFileURL(SCRIPTED_PREFLIGHT).href)} : ${program});\n`
      : `import ${program};\n`,
  );
  const launcherProtocol = layout.launcherProtocol ?? LAUNCHER_PROTOCOL;
  writeFileSync(join(dirname(main), "..", "package.json"), `${JSON.stringify({ type: "module", version, launcherProtocol })}\n`);
  if (layout.preflight !== undefined) writeFileSync(join(folder, PREFLIGHT_SCRIPT_FILE), JSON.stringify(layout.preflight));
};

/** The folder the environment stages `version` in, in `dataDir`'s staging area. */
export const stagedFolder = (dataDir: string, version: string): string => join(dataDir, STAGING_DIRECTORY, version);

/**
 * Stages `version` in `dataDir`'s staging area as the environment unpacks
 * it, laid out as the launcher runs it (`layOutVersion`), its scripted
 * preflight behaving as `preflight` says and reporting its runs to the data
 * directory's preflight runs file. Answers its folder.
 */
export const stageVersion = (dataDir: string, version: string, layout: VersionLayout = {}): string => {
  const folder = stagedFolder(dataDir, version);
  layOutVersion(folder, version, SCRIPTED_CHILD, { ...layout, preflight: { runs: join(dataDir, PREFLIGHT_RUNS_FILE), ...layout.preflight } });
  return folder;
};

/** The runs the staged versions' preflights in `dataDir` reported, in order. */
export const preflightRuns = (dataDir: string): { readonly version: string; readonly args: readonly string[]; readonly pid: number }[] => {
  const path = join(dataDir, PREFLIGHT_RUNS_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { version: string; args: string[]; pid: number });
};

/** Installs `version` complete in `dataDir`'s versions directory, laid out as the launcher runs it (`layOutVersion`), its sentinel written last. */
export const installVersion = (dataDir: string, version: string, entry: string = SCRIPTED_CHILD): void => {
  const folder = versionDirectory(dataDir, version);
  layOutVersion(folder, version, entry);
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

/** The database's files in the data directory: the main file, and the WAL and shm files SQLite keeps beside it in WAL mode. */
export const DATABASE_FILES = [DATABASE_FILE, `${DATABASE_FILE}-wal`, `${DATABASE_FILE}-shm`] as const;

/**
 * Appends `values` to the database in `dataDir` (a real SQLite database in
 * WAL mode, created if missing) from a process of its own. `leave` says how
 * that process ends: `closed` closes the database, which checkpoints and
 * removes its WAL and shm files; `open` exits without closing it, as a
 * process that crashed or was killed does, leaving both beside the database.
 */
export const writeDatabase = (dataDir: string, values: readonly string[], leave: "closed" | "open"): void => {
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const [path, values, leave] = process.argv.slice(1);
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS lines (value TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO lines (value) VALUES (?)");
    for (const value of JSON.parse(values)) insert.run(value);
    if (leave === "closed") db.close();
    process.exit(0);
  `;
  execFileSync(process.execPath, ["--no-warnings", "-e", script, join(dataDir, DATABASE_FILE), JSON.stringify(values), leave], { stdio: "pipe" });
};

/** The values the database in `dataDir` holds, read from a process of its own, which checkpoints the database as it closes it. */
export const readDatabase = (dataDir: string): string[] => {
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    process.stdout.write(JSON.stringify(db.prepare("SELECT value FROM lines ORDER BY rowid").all().map((row) => row.value)));
    db.close();
  `;
  return JSON.parse(execFileSync(process.execPath, ["--no-warnings", "-e", script, join(dataDir, DATABASE_FILE)], { encoding: "utf8" })) as string[];
};

/** The database's files in `dir` (the data directory or a snapshot's folder), by name, those that are there. */
export const databaseFilesIn = (dir: string): Record<string, Buffer> =>
  Object.fromEntries(DATABASE_FILES.filter((name) => existsSync(join(dir, name))).map((name) => [name, readFileSync(join(dir, name))]));

/** Waits until `check` holds, polling, and fails with `what` after `timeoutMs`, preset fifteen seconds (a loaded runner spawns slowly). */
export const until = async (what: string, check: () => boolean, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
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
  /** Runs the earliest-asked pending wait of `ms`, moving the clock on by it, whatever was asked before it; throws when none is pending. */
  run(ms: number): void;
}

export const fakeTimer = (start = Date.parse("2026-09-28T12:00:00.000Z")): FakeTimer => {
  let now = start;
  const waits: { readonly ms: number; readonly run: () => void; done: boolean }[] = [];
  const live = () => waits.filter((wait) => !wait.done);
  const runWait = (wait: (typeof waits)[number] | undefined, missing: string) => {
    if (wait === undefined) throw new Error(missing);
    wait.done = true;
    now += wait.ms;
    wait.run();
  };
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
    runNext: () => runWait(live()[0], "No wait is pending."),
    run: (ms) =>
      runWait(
        live().find((wait) => wait.ms === ms),
        `No wait of ${ms} ms is pending.`,
      ),
  };
};
