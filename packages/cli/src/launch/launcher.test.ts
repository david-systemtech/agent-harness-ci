import type { ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOOTSTRAP_GRANT_FILE, BootstrapGrant, DISCOVERY_PATH } from "@agent-harness/contracts";
import { LAUNCHER_PROTOCOL, type InstallAnswer } from "@agent-harness/contracts/launcher";
import { HARNESS_VERSION } from "@agent-harness/environment";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  childReport,
  CREDENTIAL_ANSWER_FILE,
  databaseFilesIn,
  fakeTimer,
  installVersion,
  layOutVersion,
  preflightRuns,
  readDatabase,
  scriptChild,
  stagedFolder,
  stageVersion,
  until,
  writeDatabase,
  type ChildEvent,
  type ChildStart,
  type FakeTimer,
  type ScriptedStart,
  type VersionLayout,
} from "../../test/launcher-fixtures.js";
import { CREDENTIAL_WAIT_MS, DRAIN_ASK_INTERVAL_MS, RELAUNCH_EXIT_CODE, startLauncher, TRIAL_DEADLINE_MS, type Launcher, type TrialFailure } from "./launcher.js";
import { hasSnapshot, RESTORE_MARKER_FILE, snapshotDirectory, takeSnapshot } from "./snapshot.js";
import { readServiceState, SERVICE_STATE_FILE, writeServiceState, type ServiceState } from "./state.js";
import { completeVersions } from "./versions.js";

/**
 * The launcher (launcher-update spec, "Versions and the launcher"; #337)
 * against a temporary data directory and the scripted child standing in for
 * `serve`, on a timer the test drives: it reads the service state, runs the
 * active version's `serve` with an IPC channel, commits its `prepared`,
 * restarts it when it exits, and stops only when the service manager says,
 * after draining it. Each step is one line of the service log.
 */

// The scripted versions' Node runtime is a shell script (see installVersion).
const posix = process.platform !== "win32";
const runningAsRoot = process.geteuid?.() === 0;

let cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

const dataDirectory = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agent-harness-launch-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const state = (activeVersion: string): ServiceState => ({
  activeVersion,
  previousVersion: null,
  launcherVersion: activeVersion,
  pendingUpdate: null,
  watchDeadline: null,
  watchedUpdateId: null,
  stagedVersion: null,
  failedHandover: null,
});

/** The service state in `dataDir` now. */
const stateIn = (dataDir: string): ServiceState | undefined => {
  const read = readServiceState(dataDir);
  return "state" in read ? read.state : undefined;
};

interface Running {
  readonly dataDir: string;
  readonly launcher: Launcher;
  readonly timer: FakeTimer;
  /** The service log's lines so far, each without its time. */
  log(): string[];
  /** The service log's lines so far, as written. */
  readonly lines: string[];
  report(): ChildEvent[];
  /** Waits until the scripted children have reported `count` events matching `event`, then answers them. */
  events(event: string, count?: number): Promise<ChildEvent[]>;
  /**
   * The service manager's stop, with each next `drain?` run a second after
   * the last, as the launcher's own timer runs it: a real serve just
   * committed hears no query before its wire opens, so the one asked at the
   * stop may go unheard, and on the test's timer alone the stop would wait
   * for good (#877).
   */
  stop(): Promise<number>;
}

/**
 * A launcher on `dataDir` (preset: a fresh one with 0.5.0 installed and
 * active), logging to memory, on a fake timer, finding `freeBytes` free on
 * the disk (preset: a terabyte). It is the launcher of `version`, preset the
 * version the service state names the launcher's, as the launcher entry
 * starts it.
 */
const launch = (
  options: {
    dataDir?: string;
    port?: number;
    freeBytes?: (dataDir: string) => number;
    version?: string;
    endChild?: (child: ChildProcess) => void;
    platform?: NodeJS.Platform;
  } = {},
): Running => {
  const dataDir = options.dataDir ?? dataDirectory();
  if (options.dataDir === undefined) {
    installVersion(dataDir, "0.5.0");
    writeServiceState(dataDir, state("0.5.0"));
  }
  const timer = fakeTimer();
  const lines: string[] = [];
  const version = options.version ?? stateIn(dataDir)?.launcherVersion;
  const launcher = startLauncher({
    dataDir,
    port: options.port,
    log: (line) => lines.push(line),
    timer,
    freeBytes: options.freeBytes ?? (() => 2 ** 40),
    ...(version === undefined ? {} : { version }),
    endChild: options.endChild,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  });
  const stop = async (): Promise<number> => {
    const nextAsk = setInterval(() => {
      if (timer.pending().includes(DRAIN_ASK_INTERVAL_MS)) timer.run(DRAIN_ASK_INTERVAL_MS);
    }, DRAIN_ASK_INTERVAL_MS);
    try {
      return await launcher.stop();
    } finally {
      clearInterval(nextAsk);
    }
  };
  cleanups.push(async () => {
    await stop();
    // A child still there after the test (one it never let go) is ended, so no process outlives the file.
    for (const { pid } of childReport(dataDir)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });
  const report = () => childReport(dataDir);
  return {
    dataDir,
    launcher,
    timer,
    lines,
    log: () => lines.map((line) => line.replace(/^\S+ /, "")),
    report,
    async events(event, count = 1) {
      const matching = () => report().filter((line) => line.event === event);
      await until(`${count} ${event} event(s)`, () => matching().length >= count);
      return matching();
    },
    stop,
  };
};

/** Waits until the launcher has scheduled a restart. */
const restartScheduled = (running: Running) => until("a restart is scheduled", () => running.timer.pending().length > 0);

describe.runIf(posix)("the launcher", () => {
  it("spawns the active version's serve on the data directory and port with an IPC channel, and answers its prepared with committed", async () => {
    const running = launch({ port: 7433 });
    const [committed] = await running.events("heard");
    expect(committed?.message).toEqual({ type: "committed" });
    const [started] = await running.events("started");
    expect(started).toMatchObject({ version: "0.5.0", args: ["serve", "--data-dir", running.dataDir, "--port", "7433"] });
    await until("the commit is logged", () => running.log().length >= 2);
    expect(running.log()).toEqual([`launcher: spawned 0.5.0 as pid ${started?.pid}`, "launcher: 0.5.0 committed"]);
    expect(running.lines[0]).toMatch(/^2026-09-28T12:00:00\.000Z launcher: spawned/);
  });

  it("passes no port when it was given none, so serve takes its own", async () => {
    const running = launch();
    const [started] = await running.events("started");
    expect(started?.args).toEqual(["serve", "--data-dir", running.dataDir]);
  });

  it("answers versions? with the versions complete in the versions directory, its own version and the launcher protocol, past a message it does not know", async () => {
    const dataDir = dataDirectory();
    for (const version of ["0.4.2", "0.5.0", "0.6.0-beta.1"]) installVersion(dataDir, version);
    rmSync(join(dataDir, "versions", "0.6.0-beta.1", ".complete"));
    writeServiceState(dataDir, state("0.5.0"));
    const running = launch({ dataDir });
    await until("the versions answer is heard", () => running.report().some((line) => (line["message"] as { type?: string } | undefined)?.type === "versions"));
    const answer = running.report().find((line) => (line["message"] as { type?: string } | undefined)?.type === "versions");
    expect(answer?.["message"]).toEqual({
      type: "versions",
      id: 1,
      installed: ["0.4.2", "0.5.0"],
      // Its own version: the version it runs from, as the launcher entry starts it.
      launcherVersion: "0.5.0",
      launcherProtocol: LAUNCHER_PROTOCOL,
    });
  });

  describe("with no service state it can use", () => {
    const refusals: [string, (dataDir: string) => void, RegExp][] = [
      ["missing", () => undefined, /^launcher: starts nothing: there is no service state at .*service-state\.json$/],
      [
        "unreadable",
        (dataDir) => {
          // A directory where the file should be cannot be read as one.
          rmSync(join(dataDir, SERVICE_STATE_FILE));
          mkdirSync(join(dataDir, SERVICE_STATE_FILE));
        },
        /^launcher: starts nothing: the service state at .* could not be read: /,
      ],
      [
        "invalid",
        (dataDir) => writeFileSync(join(dataDir, SERVICE_STATE_FILE), JSON.stringify({ ...state("0.5.0"), activeVersion: "../0.5.0" })),
        /^launcher: starts nothing: the service state at .*service-state\.json is not valid: activeVersion is not a version$/,
      ],
    ];

    for (const [kind, spoil, line] of refusals) {
      it(`starts no child when the state is ${kind}, says why in the service log, and stays until it is stopped`, async () => {
        const dataDir = dataDirectory();
        installVersion(dataDir, "0.5.0");
        if (kind !== "missing") writeServiceState(dataDir, state("0.5.0"));
        spoil(dataDir);
        const running = launch({ dataDir });
        expect(running.log()).toEqual([expect.stringMatching(line)]);
        let stopped = false;
        void running.launcher.stopped.then(() => (stopped = true));
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(stopped).toBe(false);
        expect(running.report()).toEqual([]);
        expect(running.timer.pending()).toEqual([]);
        await running.launcher.stop();
        expect(running.log().at(-1)).toBe("launcher: stopping: no child is running");
      });
    }

    it("starts no child when the active version is not complete in the versions directory, and says so", async () => {
      const dataDir = dataDirectory();
      installVersion(dataDir, "0.5.0");
      rmSync(join(dataDir, "versions", "0.5.0", ".complete"));
      writeServiceState(dataDir, state("0.5.0"));
      const running = launch({ dataDir });
      expect(running.log()).toEqual([`launcher: starts nothing: the active version 0.5.0 is not complete in ${join(dataDir, "versions")}`]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(running.report()).toEqual([]);
    });
  });

  describe("when the child exits unexpectedly", () => {
    it("restarts it after 5 seconds, then 10, doubling up to 5 minutes, on its timer", async () => {
      const dataDir = dataDirectory();
      installVersion(dataDir, "0.5.0");
      writeServiceState(dataDir, state("0.5.0"));
      scriptChild(dataDir, Array.from({ length: 9 }, () => "crash"));
      const running = launch({ dataDir });
      const waits: number[] = [];
      for (let start = 1; start <= 9; start++) {
        await restartScheduled(running);
        waits.push(...running.timer.pending());
        expect(running.report().filter((line) => line.event === "started")).toHaveLength(start);
        running.timer.runNext();
      }
      expect(waits).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
      // The tenth start serves, since the script has run out.
      await running.events("started", 10);
      await until("the tenth start commits", () => running.log().at(-1) === "launcher: 0.5.0 committed");
      const pids = running.report().filter((line) => line.event === "started").map((line) => line.pid);
      expect(running.log().slice(0, 7)).toEqual([
        `launcher: spawned 0.5.0 as pid ${pids[0]}`,
        "launcher: 0.5.0 exited with code 1",
        "launcher: restarting 0.5.0 in 5 s",
        `launcher: spawned 0.5.0 as pid ${pids[1]}`,
        "launcher: 0.5.0 exited with code 1",
        "launcher: restarting 0.5.0 in 10 s",
        `launcher: spawned 0.5.0 as pid ${pids[2]}`,
      ]);
      expect(running.log()).toContain("launcher: restarting 0.5.0 in 300 s");
    });

    it("counts a version whose runtime cannot be spawned as one that exited, and says why", async () => {
      const dataDir = dataDirectory();
      installVersion(dataDir, "0.5.0");
      rmSync(join(dataDir, "versions", "0.5.0", "node"), { recursive: true });
      writeServiceState(dataDir, state("0.5.0"));
      const running = launch({ dataDir });
      await restartScheduled(running);
      expect(running.timer.pending()).toEqual([5_000]);
      expect(running.log()).toEqual([
        `launcher: 0.5.0 could not be spawned: spawn ${join(dataDir, "versions", "0.5.0", "node", "bin", "node")} ENOENT`,
        "launcher: restarting 0.5.0 in 5 s",
      ]);
    });

    it("counts a child that crashed after its commit, one killed by a signal, and one that exited 0 before committing as unexpected", async () => {
      const dataDir = dataDirectory();
      installVersion(dataDir, "0.5.0");
      writeServiceState(dataDir, state("0.5.0"));
      scriptChild(dataDir, ["crash-after-commit", "silent", "exit-0"]);
      const running = launch({ dataDir });
      await restartScheduled(running);
      expect(running.timer.pending()).toEqual([5_000]);
      expect(running.log().slice(1)).toEqual(["launcher: 0.5.0 committed", "launcher: 0.5.0 exited with code 3", "launcher: restarting 0.5.0 in 5 s"]);
      running.timer.runNext();
      const [, silent] = await running.events("started", 2);
      process.kill(silent?.pid ?? 0, "SIGKILL");
      await restartScheduled(running);
      expect(running.timer.pending()).toEqual([10_000]);
      expect(running.log().slice(-2)).toEqual(["launcher: 0.5.0 was ended by SIGKILL", "launcher: restarting 0.5.0 in 10 s"]);
      running.timer.runNext();
      await running.events("started", 3);
      await restartScheduled(running);
      expect(running.timer.pending()).toEqual([20_000]);
      expect(running.log().slice(-2)).toEqual(["launcher: 0.5.0 exited with code 0", "launcher: restarting 0.5.0 in 20 s"]);
    });

    it("waits 5 seconds again once a child had run for 5 minutes before it exited", async () => {
      const dataDir = dataDirectory();
      installVersion(dataDir, "0.5.0");
      writeServiceState(dataDir, state("0.5.0"));
      scriptChild(dataDir, ["crash", "crash", "crash-after-commit"]);
      const running = launch({ dataDir });
      await restartScheduled(running);
      running.timer.runNext();
      await running.events("started", 2);
      await restartScheduled(running);
      expect(running.timer.pending()).toEqual([10_000]);
      // The third start runs for five minutes before it crashes: the clock moves as soon as it is spawned.
      running.timer.runNext();
      running.timer.advance(300_000);
      await restartScheduled(running);
      expect(running.timer.pending()).toEqual([5_000]);
    });
  });

  describe("when the child drains without being asked", () => {
    it("restarts it at once after it drained itself, as environment.drain does", async () => {
      const dataDir = dataDirectory();
      installVersion(dataDir, "0.5.0");
      writeServiceState(dataDir, state("0.5.0"));
      scriptChild(dataDir, ["drain"]);
      const running = launch({ dataDir });
      const [first, second] = await running.events("started", 2);
      await until("the second start commits", () => running.log().length >= 6);
      expect(running.timer.pending()).toEqual([]);
      expect(running.log()).toEqual([
        `launcher: spawned 0.5.0 as pid ${first?.pid}`,
        "launcher: 0.5.0 committed",
        "launcher: 0.5.0 exited with code 0",
        "launcher: restarting 0.5.0 now: it drained",
        `launcher: spawned 0.5.0 as pid ${second?.pid}`,
        "launcher: 0.5.0 committed",
      ]);
    });

    it("restarts it at once after a signal to the child drained it", async () => {
      const running = launch();
      // Signalled once it has heard its commit, as serve takes a signal as a drain only once it serves.
      const [first] = await running.events("committed");
      process.kill(first?.pid ?? 0, "SIGTERM");
      const [, second] = await running.events("started", 2);
      expect(second?.pid).not.toBe(first?.pid);
      expect(running.timer.pending()).toEqual([]);
      expect(await running.events("drained")).toMatchObject([{ pid: first?.pid, trigger: "signal" }]);
      expect(running.log()).toContain("launcher: restarting 0.5.0 now: it drained");
    });

    it("clears the doubling: a crash after a drained restart waits 5 seconds", async () => {
      const dataDir = dataDirectory();
      installVersion(dataDir, "0.5.0");
      writeServiceState(dataDir, state("0.5.0"));
      scriptChild(dataDir, ["crash", "drain", "crash"]);
      const running = launch({ dataDir });
      await restartScheduled(running);
      running.timer.runNext();
      await running.events("started", 3);
      await restartScheduled(running);
      expect(running.timer.pending()).toEqual([5_000]);
    });
  });

  describe("on the service manager's stop", () => {
    it("sends drain?, waits for the child's channel to close, and then settles, restarting nothing", async () => {
      const running = launch();
      await until("the child serves", () => running.report().some((line) => (line["message"] as { type?: string } | undefined)?.type === "versions"));
      let stopped = false;
      const stopping = running.launcher.stop().then(() => (stopped = true));
      expect(running.log().at(-1)).toBe("launcher: stopping: draining 0.5.0");
      expect(stopped).toBe(false);
      await stopping;
      expect((await running.events("drained"))[0]).toMatchObject({ trigger: "launcher" });
      expect(running.report().filter((line) => line.event === "heard").map((line) => (line["message"] as { type: string }).type)).toEqual([
        "committed",
        "versions",
        "drain?",
      ]);
      await until("the child's exit is logged", () => running.log().at(-1) === "launcher: 0.5.0 exited with code 0");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(running.report().filter((line) => line.event === "started")).toHaveLength(1);
      expect(running.timer.pending()).toEqual([]);
    });

    it("asks again each second until the child answers, since a child just committed may not answer queries yet", async () => {
      const dataDir = dataDirectory();
      installVersion(dataDir, "0.5.0");
      writeServiceState(dataDir, state("0.5.0"));
      scriptChild(dataDir, ["deaf-once"]);
      const running = launch({ dataDir });
      await until("the child commits", () => running.log().includes("launcher: 0.5.0 committed"));
      const stopping = running.launcher.stop();
      await until("the first drain? is heard", () => running.report().some((line) => (line["message"] as { type?: string } | undefined)?.type === "drain?"));
      expect(running.timer.pending()).toEqual([1_000]);
      running.timer.runNext();
      await stopping;
      expect(running.report().filter((line) => (line["message"] as { type?: string } | undefined)?.type === "drain?")).toHaveLength(2);
      expect(running.timer.pending()).toEqual([]);
    });

    it("ends a child that has not committed, which has nothing to drain", async () => {
      const dataDir = dataDirectory();
      installVersion(dataDir, "0.5.0");
      writeServiceState(dataDir, state("0.5.0"));
      scriptChild(dataDir, ["silent"]);
      const running = launch({ dataDir });
      await running.events("started");
      await running.launcher.stop();
      expect(running.log()).toContain("launcher: stopping: 0.5.0 has not committed, so it is ended");
      expect(running.timer.pending()).toEqual([]);
    });

    it("cancels a restart it was waiting to make, and settles at once", async () => {
      const dataDir = dataDirectory();
      installVersion(dataDir, "0.5.0");
      writeServiceState(dataDir, state("0.5.0"));
      scriptChild(dataDir, ["crash"]);
      const running = launch({ dataDir });
      await restartScheduled(running);
      await running.launcher.stop();
      expect(running.timer.pending()).toEqual([]);
      expect(running.log().at(-1)).toBe("launcher: stopping: no child is running");
      expect(running.report().filter((line) => line.event === "started")).toHaveLength(1);
    });

    it("is one stop however often it is asked", async () => {
      const running = launch();
      await until("the child commits", () => running.log().includes("launcher: 0.5.0 committed"));
      await Promise.all([running.launcher.stop(), running.launcher.stop()]);
      expect(running.log().filter((line) => line.startsWith("launcher: stopping"))).toEqual(["launcher: stopping: draining 0.5.0"]);
    });
  });
});

describe.runIf(posix)("the launcher's end, a stop that does not drain (#1712)", () => {
  /** Ends a child as the launcher's preset does, and records that it was asked to. */
  const recordingEnd = () => {
    const ended: number[] = [];
    return { ended, endChild: (child: ChildProcess) => void (ended.push(child.pid ?? -1), child.kill("SIGKILL")) };
  };

  it("ends a committed child at once, asking it nothing, and settles with 0, restarting nothing", async () => {
    const end = recordingEnd();
    const running = launch({ endChild: end.endChild });
    await until("the child commits", () => running.log().includes("launcher: 0.5.0 committed"));
    expect(await running.launcher.end()).toBe(0);
    expect(end.ended).toHaveLength(1);
    expect(running.log()).toContain("launcher: stopping: 0.5.0 is ended at once, without a drain");
    expect(running.report().some((line) => (line["message"] as { type?: string } | undefined)?.type === "drain?")).toBe(false);
    expect(running.report().filter((line) => line.event === "drained")).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(running.report().filter((line) => line.event === "started")).toHaveLength(1);
    expect(running.timer.pending()).toEqual([]);
  });

  it("ends at once a child that a stop is still draining", async () => {
    const dataDir = dataDirectory();
    installVersion(dataDir, "0.5.0");
    writeServiceState(dataDir, state("0.5.0"));
    scriptChild(dataDir, ["deaf-once"]);
    const end = recordingEnd();
    const running = launch({ dataDir, endChild: end.endChild });
    await until("the child commits", () => running.log().includes("launcher: 0.5.0 committed"));
    const stopping = running.launcher.stop();
    await until("the first drain? is heard", () => running.report().some((line) => (line["message"] as { type?: string } | undefined)?.type === "drain?"));
    expect(await running.launcher.end()).toBe(0);
    expect(await stopping).toBe(0);
    expect(end.ended).toHaveLength(1);
    expect(running.log().filter((line) => line.startsWith("launcher: stopping"))).toEqual([
      "launcher: stopping: draining 0.5.0",
      "launcher: stopping: 0.5.0 is ended at once, without a drain",
    ]);
  });
});

const updateId = "7d0f2b1e-2c55-4a8e-9f0b-3a1c5d7e9b20";
/** The update the tests below switch for: 0.4.0 to 0.5.0. */
const update = { updateId, fromVersion: "0.4.0", toVersion: "0.5.0" } as const;

/** A start of 0.4.0 that asks to switch to `version` (preset 0.5.0) for the update once it is committed. */
const switching = (switchTo: Partial<NonNullable<ScriptedStart["switchTo"]>> = {}): ChildStart => ({ switchTo: { updateId, version: "0.5.0", ...switchTo } });

/** A data directory running 0.4.0 with 0.5.0 installed beside it, a database 0.4.0 wrote and closed, and `starts` scripted. */
const beforeAnUpdate = (starts: readonly ChildStart[]): string => {
  const dataDir = dataDirectory();
  installVersion(dataDir, "0.4.0");
  installVersion(dataDir, "0.5.0");
  writeServiceState(dataDir, state("0.4.0"));
  writeDatabase(dataDir, ["before the update"], "closed");
  scriptChild(dataDir, starts);
  return dataDir;
};

/** What a child heard, by the type of each message. */
const heardBy = (running: Running, start: number): string[] =>
  running
    .report()
    .filter((line) => line.start === start && line.event === "heard")
    .map((line) => (line["message"] as { type: string }).type);

describe.runIf(posix)("the launcher switching versions for an update", () => {
  it("answers switch? for an installed version by writing the pending-update record, and only then switching", async () => {
    const running = launch({ dataDir: beforeAnUpdate([switching()]) });
    const [heard] = await running.events("switching");
    expect(heard).toMatchObject({ version: "0.4.0", pendingUpdate: update });
    expect(running.log()).toContain(`launcher: switching from 0.4.0 to 0.5.0 for update ${updateId}`);
  });

  describe("refusing a switch", () => {
    it("refuses a version that is not installed, or not complete, not-installed, writing nothing, and the child it refused restarts", async () => {
      for (const [version, spoil] of [["0.6.0", () => undefined], ["0.5.0", (dataDir: string) => rmSync(join(dataDir, "versions", "0.5.0", ".complete"))]] as const) {
        const dataDir = beforeAnUpdate([switching({ version })]);
        spoil(dataDir);
        const running = launch({ dataDir });
        await until("the refusal is heard", () => heardBy(running, 0).includes("refused"));
        expect(running.report().find((line) => (line["message"] as { type?: string } | undefined)?.type === "refused")?.["message"]).toEqual({
          type: "refused",
          id: 2,
          reason: "not-installed",
        });
        expect(stateIn(dataDir)).toEqual(state("0.4.0"));
        expect(running.log()).toContain(`launcher: refuses switch? to ${version} for update ${updateId}: not-installed, as ${version} is not complete in ${join(dataDir, "versions")}`);
        // The refused environment closes, as one does after appending its failed update, and the same version is back at once.
        const [, again] = await running.events("started", 2);
        expect(again).toMatchObject({ version: "0.4.0" });
        expect(hasSnapshot(dataDir, updateId)).toBe(false);
      }
    });

    it("refuses disk, before the child is told to go, with less free space than the database's size plus 256 MiB", async () => {
      const dataDir = beforeAnUpdate([switching()]);
      const needed = statSync(join(dataDir, "environment.db")).size + 256 * 1024 * 1024;
      const refused = launch({ dataDir, freeBytes: () => needed - 1 });
      await until("the refusal is heard", () => heardBy(refused, 0).includes("refused"));
      expect(refused.report().filter((line) => line.event === "heard").at(-1)?.["message"]).toEqual({ type: "refused", id: 2, reason: "disk" });
      expect(refused.log()).toContain(`launcher: refuses switch? to 0.5.0 for update ${updateId}: disk, as ${needed - 1} bytes are free and a snapshot needs ${needed}`);
      expect(stateIn(dataDir)).toEqual(state("0.4.0"));
      await refused.launcher.stop();

      const room = launch({ dataDir: beforeAnUpdate([switching()]), freeBytes: () => needed });
      await room.events("switching");
    });

    it("refuses io when the free space cannot be read or the pending-update record cannot be written, and writes nothing", async () => {
      const unread = beforeAnUpdate([switching()]);
      const running = launch({
        dataDir: unread,
        freeBytes: () => {
          throw new Error("statfs failed");
        },
      });
      await until("the refusal is heard", () => heardBy(running, 0).includes("refused"));
      expect(running.report().filter((line) => line.event === "heard").at(-1)?.["message"]).toEqual({ type: "refused", id: 2, reason: "io" });
      expect(running.log()).toContain(`launcher: refuses switch? to 0.5.0 for update ${updateId}: io, as statfs failed`);
      expect(stateIn(unread)).toEqual(state("0.4.0"));

      const unwritable = beforeAnUpdate([switching()]);
      const spoiled = launch({
        dataDir: unwritable,
        // The free space is read last before the record is written: a folder in the state's place takes no rename.
        freeBytes: () => {
          rmSync(join(unwritable, SERVICE_STATE_FILE));
          mkdirSync(join(unwritable, SERVICE_STATE_FILE, "in-the-way"), { recursive: true });
          return 2 ** 40;
        },
      });
      await until("the refusal is heard", () => heardBy(spoiled, 0).includes("refused"));
      expect(spoiled.report().filter((line) => line.event === "heard").at(-1)?.["message"]).toEqual({ type: "refused", id: 2, reason: "io" });
      expect(spoiled.report().some((line) => line.event === "switching")).toBe(false);
    });
  });

  it("waits for the child to exit after switching, and ends it at the drain cap plus a minute", async () => {
    const running = launch({ dataDir: beforeAnUpdate([switching({ lingers: true })]) });
    await running.events("switching");
    await until("the switch is logged", () => running.log().some((line) => line.includes("switching from")));
    expect(running.timer.pending()).toEqual([31 * 60_000]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(running.report().filter((line) => line.event === "started")).toHaveLength(1);
    expect(hasSnapshot(running.dataDir, updateId)).toBe(false);

    running.timer.runNext();

    const [, trial] = await running.events("started", 2);
    expect(trial).toMatchObject({ version: "0.5.0" });
    expect(running.log()).toContain("launcher: 0.4.0 has not exited 31 minutes after switching, so it is ended");
    expect(running.log()).toContain("launcher: 0.4.0 was ended by SIGKILL");
  });

  it("snapshots the database once the child has exited, starts the target as a trial, and commits its prepared durably before answering committed", async () => {
    const dataDir = beforeAnUpdate([switching()]);
    const before = databaseFilesIn(dataDir);
    const running = launch({ dataDir });
    const [, trial] = await running.events("started", 2);
    expect(trial).toMatchObject({ version: "0.5.0", dataFiles: expect.arrayContaining(["snapshots"]) });
    expect(databaseFilesIn(snapshotDirectory(dataDir, updateId))).toEqual(before);

    const [, committed] = await running.events("committed", 2);
    expect(committed).toMatchObject({ version: "0.5.0" });
    expect(committed?.["state"]).toEqual({
      activeVersion: "0.5.0",
      previousVersion: "0.4.0",
      launcherVersion: "0.4.0",
      pendingUpdate: null,
      watchDeadline: "2026-09-28T12:10:00.000Z",
      watchedUpdateId: updateId,
      stagedVersion: null,
      failedHandover: null,
    });
    await until("the commit is logged", () => running.log().length >= 7);
    expect(running.log()).toEqual([
      `launcher: spawned 0.4.0 as pid ${running.report()[0]?.pid}`,
      "launcher: 0.4.0 committed",
      `launcher: switching from 0.4.0 to 0.5.0 for update ${updateId}`,
      "launcher: 0.4.0 exited with code 0",
      `launcher: snapshot of update ${updateId} taken`,
      `launcher: spawned 0.5.0 as pid ${trial?.pid}, the trial of update ${updateId}`,
      `launcher: 0.5.0 committed: update ${updateId} from 0.4.0, watched until 2026-09-28T12:10:00.000Z`,
    ]);
    // The trial's deadline went with its commit, and the watch's end waits.
    expect(running.timer.pending()).toEqual([10 * 60_000]);
    expect(heardBy(running, 1)).toContain("committed");
  });
});

describe.runIf(posix)("the Node the launcher runs a version on (#1910)", () => {
  /** Gives `version` in `dataDir` a Windows Node: its own Node, behind a script that first notes the path it was run from and the version it came with. */
  const windowsNode = (dataDir: string, version: string, runs: string): void => {
    const folder = join(dataDir, "versions", version, "node");
    writeFileSync(join(folder, "node.exe"), `#!/bin/sh\necho "$0 ${version}" >> '${runs}'\nexec '${join(folder, "bin", "node")}' "$@"\n`);
    chmodSync(join(folder, "node.exe"), 0o755);
  };

  it("runs every version on Windows from one Node path, holding the version's own Node, so an update is no new program to the firewall", async () => {
    const dataDir = beforeAnUpdate([switching()]);
    const runs = join(dataDir, "node-runs.txt");
    for (const version of ["0.4.0", "0.5.0"]) windowsNode(dataDir, version, runs);
    const running = launch({ dataDir, platform: "win32" });
    await running.events("committed", 2);
    const stable = join(dataDir, "node", "node.exe");
    expect(readFileSync(runs, "utf8").trim().split("\n")).toEqual([`${stable} 0.4.0`, `${stable} 0.5.0`]);
    expect(readdirSync(join(dataDir, "node")).sort()).toEqual(["node.exe", "version"]);
  });

  it("runs a version on its own Node, and says why, when the Windows copy cannot be made", async () => {
    const dataDir = dataDirectory();
    installVersion(dataDir, "0.5.0");
    writeServiceState(dataDir, state("0.5.0"));
    const runs = join(dataDir, "node-runs.txt");
    windowsNode(dataDir, "0.5.0", runs);
    // A folder where the copy goes: it cannot be renamed over.
    mkdirSync(join(dataDir, "node", "node.exe"), { recursive: true });
    const running = launch({ dataDir, platform: "win32" });
    await running.events("committed");
    expect(readFileSync(runs, "utf8").trim()).toBe(`${join(dataDir, "versions", "0.5.0", "node", "node.exe")} 0.5.0`);
    expect(running.log()).toContainEqual(expect.stringMatching(/^launcher: 0\.5\.0 runs on its own Node, which Windows Firewall may ask about again, since the copy could not be made: /));
  });
});

/** The outcome record in `dataDir`. */
const outcomeIn = (dataDir: string): unknown => JSON.parse(readFileSync(join(dataDir, "update-outcome.json"), "utf8"));

describe.runIf(posix)("the launcher rolling an update back", () => {
  const trialFailures: [what: string, reason: TrialFailure, trial: ScriptedStart, act: (running: Running) => Promise<void>][] = [
    ["exits before its prepared", "exit", { behaviour: "crash", writes: ["written by the trial"] }, async () => undefined],
    [
      "says nothing within 120 seconds of its spawn",
      "deadline",
      { behaviour: "silent", writes: ["written by the trial"] },
      async (running) => {
        await running.events("started", 2);
        await until("the trial's deadline is set", () => running.timer.pending().length > 0);
        expect(running.timer.pending()).toEqual([120_000]);
        running.timer.runNext();
      },
    ],
    ["says prepared for another version", "version", { preparedAs: "0.5.1", writes: ["written by the trial"] }, async () => undefined],
  ];

  for (const [what, reason, trial, act] of trialFailures) {
    it(`ends a trial that ${what}, restores the snapshot byte for byte, writes the outcome record, and only then starts the old version`, async () => {
      const dataDir = beforeAnUpdate([switching(), trial]);
      const before = databaseFilesIn(dataDir);
      const running = launch({ dataDir });
      await act(running);

      const [, , old] = await running.events("started", 3);
      expect(old).toMatchObject({ version: "0.4.0" });
      // By the old version's start the outcome record is written and the restore's marker cleared.
      expect(old?.["dataFiles"]).toContain("update-outcome.json");
      expect(old?.["dataFiles"]).not.toContain(RESTORE_MARKER_FILE);
      expect(databaseFilesIn(dataDir)).toEqual(before);
      expect(databaseFilesIn(snapshotDirectory(dataDir, updateId))).toEqual(before);
      expect(outcomeIn(dataDir)).toEqual({ ...update, stage: "trial", reason });
      expect(stateIn(dataDir)).toEqual(state("0.4.0"));
      expect(heardBy(running, 1)).not.toContain("committed");
      const rolledBack = [`launcher: rolling update ${updateId} back to 0.4.0: its trial failed (${reason})`, `launcher: restored the snapshot of update ${updateId}`];
      expect(running.log().join("\n")).toContain(rolledBack.join("\n"));
      if (reason !== "exit") expect(running.log()).toContain("launcher: 0.5.0 was ended by SIGKILL");
      await running.events("committed", 2);
      expect(readDatabase(dataDir)).toEqual(["before the update"]);
    });
  }

  it("names the version a trial said prepared for, and the deadline a silent one missed", async () => {
    const other = launch({ dataDir: beforeAnUpdate([switching(), { preparedAs: "0.5.1" }]) });
    await other.events("started", 3);
    expect(other.log()).toContain(`launcher: 0.5.0 fails the trial of update ${updateId}: it said prepared for 0.5.1, so it is ended`);

    const silent = launch({ dataDir: beforeAnUpdate([switching(), "silent"]) });
    await silent.events("started", 2);
    await until("the trial's deadline is set", () => silent.timer.pending().length > 0);
    silent.timer.runNext();
    await silent.events("started", 3);
    expect(silent.log()).toContain(`launcher: 0.5.0 fails the trial of update ${updateId}: it did not say prepared within 120 s of its spawn, so it is ended`);
  });

  describe("while a trial's OS keychain read waits on the person (#1689)", () => {
    /** A launcher whose trial of 0.5.0 says its stored key waits on the person, once the deadline has paused for it. */
    const waitingTrial = async (credential: "answered" | "refused") => {
      const dataDir = beforeAnUpdate([switching(), { credential, writes: ["written by the trial"] }]);
      const before = databaseFilesIn(dataDir);
      const running = launch({ dataDir });
      await running.events("credential-waiting");
      await until("the trial's deadline pauses", () => running.log().some((line) => line.startsWith("launcher: 0.5.0 waits on the person")));
      return { dataDir, before, running, answer: () => writeFileSync(join(dataDir, CREDENTIAL_ANSWER_FILE), "") };
    };

    it("pauses the deadline, so a read that returns long past it still commits", async () => {
      const { dataDir, running, answer } = await waitingTrial("answered");
      expect(running.timer.pending()).toEqual([CREDENTIAL_WAIT_MS]);
      expect(running.log()).toContain(
        "launcher: 0.5.0 waits on the person to let it read its stored key (the OS is asking them), so its trial's deadline pauses for up to 10 min",
      );
      // Long past the 120 seconds a trial had, the person answers.
      running.timer.advance(TRIAL_DEADLINE_MS * 3);
      answer();
      await until("the trial commits", () => running.log().some((line) => line.startsWith("launcher: 0.5.0 committed")));
      expect(running.log()).toContain("launcher: 0.5.0 may read its stored key, so its trial's deadline resumes with 120 s left");
      expect(stateIn(dataDir)).toMatchObject({ activeVersion: "0.5.0", previousVersion: "0.4.0", pendingUpdate: null });
      expect(existsSync(join(dataDir, "update-outcome.json"))).toBe(false);
    });

    it("ends the trial at reason credential when nobody answers within the wait's limit, and rolls it back", async () => {
      const { dataDir, before, running } = await waitingTrial("answered");
      running.timer.run(CREDENTIAL_WAIT_MS);
      const [, , old] = await running.events("started", 3);
      expect(old).toMatchObject({ version: "0.4.0" });
      expect(running.log()).toContain(
        `launcher: 0.5.0 fails the trial of update ${updateId}: the OS's prompt to let it read its stored key was not answered within 10 min, so it is ended`,
      );
      expect(outcomeIn(dataDir)).toEqual({ ...update, stage: "trial", reason: "credential" });
      expect(databaseFilesIn(dataDir)).toEqual(before);
      expect(stateIn(dataDir)).toEqual(state("0.4.0"));
    });

    it("rolls the trial back at reason credential when the person refuses and it exits", async () => {
      const { dataDir, before, running, answer } = await waitingTrial("refused");
      answer();
      const [, , old] = await running.events("started", 3);
      expect(old).toMatchObject({ version: "0.4.0" });
      expect(running.log()).toContain("launcher: 0.5.0 was refused its stored key");
      expect(running.log()).toContain(`launcher: rolling update ${updateId} back to 0.4.0: its trial failed (credential)`);
      expect(outcomeIn(dataDir)).toEqual({ ...update, stage: "trial", reason: "credential" });
      expect(databaseFilesIn(dataDir)).toEqual(before);
    });
  });

  it("keeps the snapshot a second switch? with the same update id finds, and takes none again", async () => {
    const dataDir = beforeAnUpdate([switching(), "crash", { writes: ["after the rollback"], switchTo: { updateId, version: "0.5.0" } }]);
    const before = databaseFilesIn(dataDir);
    const running = launch({ dataDir });
    const [, , , again] = await running.events("started", 4);
    expect(again).toMatchObject({ version: "0.5.0" });
    await until("the second trial commits", () => running.log().some((line) => line.startsWith("launcher: 0.5.0 committed")));
    expect(running.log().filter((line) => line.startsWith(`launcher: snapshot of update ${updateId}`))).toEqual([
      `launcher: snapshot of update ${updateId} taken`,
      `launcher: snapshot of update ${updateId} kept, as it was taken before`,
    ]);
    expect(databaseFilesIn(snapshotDirectory(dataDir, updateId))).toEqual(before);
    expect(readDatabase(dataDir)).toEqual(["before the update", "after the rollback"]);
  });

  it("records an update whose snapshot cannot be taken as a failed trial, and starts the old version on the database as it was", async () => {
    const dataDir = beforeAnUpdate([switching()]);
    // A file where the snapshots folder goes takes no snapshot.
    writeFileSync(join(dataDir, "snapshots"), "in the way");
    const before = databaseFilesIn(dataDir);
    const running = launch({ dataDir });
    const [, old] = await running.events("started", 2);
    expect(old).toMatchObject({ version: "0.4.0", dataFiles: expect.arrayContaining(["update-outcome.json"]) });
    expect(databaseFilesIn(dataDir)).toEqual(before);
    expect(outcomeIn(dataDir)).toEqual({ ...update, stage: "trial", reason: "snapshot" });
    expect(stateIn(dataDir)).toEqual(state("0.4.0"));
    expect(running.log()).toContain(`launcher: rolling update ${updateId} back to 0.4.0: its trial failed (snapshot)`);
    expect(running.log()).toContain("launcher: 0.5.0 never ran, so there was nothing to restore");
  });

  it("does not answer committed when the commit cannot be written, and leaves the rollback marked until the state can be written again", async () => {
    const dataDir = beforeAnUpdate([switching(), { spoilsState: true, writes: ["written by the trial"] }]);
    const before = databaseFilesIn(dataDir);
    const running = launch({ dataDir });
    await until("the rollback stops", () => running.log().some((line) => line.includes("could not be rolled back")));
    expect(heardBy(running, 1)).not.toContain("committed");
    expect(running.log().some((line) => line.startsWith(`launcher: 0.5.0 fails the trial of update ${updateId}: its commit could not be written: `))).toBe(true);
    expect(databaseFilesIn(dataDir)).toEqual(before);
    expect(outcomeIn(dataDir)).toEqual({ ...update, stage: "trial", reason: "commit" });
    expect(existsSync(join(dataDir, RESTORE_MARKER_FILE))).toBe(true);
    expect(running.report().filter((line) => line.event === "started")).toHaveLength(2);
    await running.launcher.stop();

    rmSync(join(dataDir, SERVICE_STATE_FILE), { recursive: true });
    writeServiceState(dataDir, { ...state("0.4.0"), pendingUpdate: update });
    const next = launch({ dataDir });
    const [, , old] = await next.events("started", 3);
    expect(old).toMatchObject({ version: "0.4.0" });
    expect(next.log()[0]).toBe(`launcher: finished the restore of update ${updateId}, which was cut short`);
    expect(stateIn(dataDir)).toEqual(state("0.4.0"));
    expect(existsSync(join(dataDir, RESTORE_MARKER_FILE))).toBe(false);
  });
});

describe.runIf(posix)("a launcher started in the middle of an update", () => {
  /** 0.4.0 active with the update pending, its snapshot taken, and the database written by its trial and left open. */
  const pendingAfterATrial = (): string => {
    const dataDir = beforeAnUpdate([]);
    writeServiceState(dataDir, { ...state("0.4.0"), pendingUpdate: update });
    takeSnapshot(dataDir, updateId);
    writeDatabase(dataDir, ["written by the trial"], "open");
    return dataDir;
  };

  it("finishes a restore it was killed in before it starts any child, with the record the marker holds", async () => {
    const dataDir = pendingAfterATrial();
    const record = { ...update, stage: "trial", reason: "deadline" };
    // Killed once the main file was copied back and before the WAL and shm were removed: the marker is there, the outcome record is not.
    writeFileSync(join(dataDir, RESTORE_MARKER_FILE), JSON.stringify(record));
    copyFileSync(join(snapshotDirectory(dataDir, updateId), "environment.db"), join(dataDir, "environment.db"));
    const running = launch({ dataDir });
    const [first] = await running.events("started");
    expect(first).toMatchObject({ version: "0.4.0", dataFiles: expect.arrayContaining(["update-outcome.json"]) });
    expect(first?.["dataFiles"]).not.toContain(RESTORE_MARKER_FILE);
    expect(databaseFilesIn(dataDir)).toEqual(databaseFilesIn(snapshotDirectory(dataDir, updateId)));
    expect(outcomeIn(dataDir)).toEqual(record);
    expect(stateIn(dataDir)).toEqual(state("0.4.0"));
    expect(running.log().slice(0, 2)).toEqual([`launcher: finished the restore of update ${updateId}, which was cut short`, `launcher: spawned 0.4.0 as pid ${first?.pid}`]);
    expect(readDatabase(dataDir)).toEqual(["before the update"]);
  });

  it("rolls an update it finds pending, with no commit, back as a failed trial before it starts any child", async () => {
    const dataDir = pendingAfterATrial();
    const snapshot = databaseFilesIn(snapshotDirectory(dataDir, updateId));
    const running = launch({ dataDir });
    const [first] = await running.events("started");
    expect(first).toMatchObject({ version: "0.4.0", dataFiles: expect.arrayContaining(["update-outcome.json"]) });
    expect(databaseFilesIn(dataDir)).toEqual(snapshot);
    expect(outcomeIn(dataDir)).toEqual({ ...update, stage: "trial", reason: "interrupted" });
    expect(stateIn(dataDir)).toEqual(state("0.4.0"));
    expect(running.log().slice(0, 4)).toEqual([
      `launcher: update ${updateId} to 0.5.0 was pending and not committed when the launcher last stopped`,
      `launcher: rolling update ${updateId} back to 0.4.0: its trial failed (interrupted)`,
      `launcher: restored the snapshot of update ${updateId}`,
      `launcher: spawned 0.4.0 as pid ${first?.pid}`,
    ]);
  });

  it("records an update it finds pending with no snapshot yet as a failed trial, restoring nothing since its target never ran, and removes a snapshot cut short", async () => {
    const dataDir = beforeAnUpdate([]);
    writeServiceState(dataDir, { ...state("0.4.0"), pendingUpdate: update });
    mkdirSync(join(dataDir, "snapshots", `${updateId}.staging`), { recursive: true });
    writeFileSync(join(dataDir, "snapshots", `${updateId}.staging`, "environment.db"), "half a copy");
    const before = databaseFilesIn(dataDir);
    const running = launch({ dataDir });
    await running.events("started");
    expect(databaseFilesIn(dataDir)).toEqual(before);
    expect(outcomeIn(dataDir)).toEqual({ ...update, stage: "trial", reason: "interrupted" });
    expect(stateIn(dataDir)).toEqual(state("0.4.0"));
    expect(readdirSync(join(dataDir, "snapshots"))).toEqual([]);
    expect(running.log()).toContain("launcher: 0.5.0 never ran, so there was nothing to restore");
  });

  it("starts nothing when a marked restore cannot be finished, and says why", async () => {
    const dataDir = beforeAnUpdate([]);
    writeFileSync(join(dataDir, RESTORE_MARKER_FILE), JSON.stringify({ ...update, stage: "trial", reason: "exit" }));
    const running = launch({ dataDir });
    expect(running.log()).toEqual([`launcher: starts nothing: There is no snapshot of update ${updateId} in ${join(dataDir, "snapshots")} to restore.`]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(running.report()).toEqual([]);
  });

  it("rolls back a trial the service manager stopped, at the next start", async () => {
    const dataDir = beforeAnUpdate([switching(), { behaviour: "silent", writes: ["written by the trial"] }]);
    const before = databaseFilesIn(dataDir);
    const first = launch({ dataDir });
    await first.events("started", 2);
    await first.launcher.stop();
    expect(first.log()).toContain(`launcher: stopping: 0.5.0 has not committed, so it is ended, and the next start rolls update ${updateId} back`);
    expect(stateIn(dataDir)?.pendingUpdate).toEqual(update);

    const next = launch({ dataDir });
    const [, , old] = await next.events("started", 3);
    expect(old).toMatchObject({ version: "0.4.0" });
    expect(databaseFilesIn(dataDir)).toEqual(before);
    expect(outcomeIn(dataDir)).toEqual({ ...update, stage: "trial", reason: "interrupted" });
  });
});

/** Waits until the launcher is waiting `ms` to restart the child, and runs that wait: the watch's end, asked for first, keeps waiting. */
const restartAfter = async (running: Running, ms: number) => {
  await until(`a restart in ${ms} ms is scheduled`, () => running.timer.pending().includes(ms));
  running.timer.run(ms);
};

/** The files in `dir` other than the database's and the launcher's own bookkeeping, with their contents. */
const environmentFiles = (dir: string): Record<string, string> =>
  Object.fromEntries(
    treeOf(dir)
      .filter((path) => !/^(environment\.db|service-state\.json|update-outcome\.json|child-report\.jsonl|snapshots|versions)/.test(path))
      .filter((path) => statSync(join(dir, path)).isFile())
      .map((path) => [path, readFileSync(join(dir, path), "utf8")]),
  );

describe.runIf(posix)("the launcher watching a committed update", () => {
  it("restores the snapshot and restarts the version the update went from after three unexpected exits within ten minutes of the commit, with stage crash-loop in the outcome record", async () => {
    const dataDir = beforeAnUpdate([switching(), { behaviour: "crash-after-commit", writes: ["written by the target"] }, "crash", "crash-after-commit"]);
    const before = databaseFilesIn(dataDir);
    const running = launch({ dataDir });
    await running.events("committed", 2);
    expect(running.timer.pending()).toContain(10 * 60_000);
    await restartAfter(running, 5_000);
    await restartAfter(running, 10_000);

    const [, , , , old] = await running.events("started", 5);
    expect(old).toMatchObject({ version: "0.4.0", dataFiles: expect.arrayContaining(["update-outcome.json"]) });
    expect(old?.["dataFiles"]).not.toContain(RESTORE_MARKER_FILE);
    expect(outcomeIn(dataDir)).toEqual({ ...update, stage: "crash-loop", reason: "exit" });
    expect(databaseFilesIn(dataDir)).toEqual(before);
    // The commit swapped the active and previous versions; the rollback swaps them back, and the watch is over.
    expect(stateIn(dataDir)).toEqual({ ...state("0.4.0"), previousVersion: "0.5.0" });
    expect(running.log().join("\n")).toContain(
      [
        "launcher: 0.5.0 exited with code 3",
        `launcher: 0.5.0 exited 3 times within 10 minutes of its commit, so update ${updateId} is rolled back to 0.4.0`,
        `launcher: restored the snapshot of update ${updateId}`,
        `launcher: spawned 0.4.0 as pid ${old?.pid}`,
      ].join("\n"),
    );
    await running.events("committed", 4);
    expect(readDatabase(dataDir)).toEqual(["before the update"]);
    // The watch went with the rollback.
    expect(running.timer.pending()).toEqual([]);
  });

  it("restores nothing after two unexpected exits within the watch, and restarts the child as it always does", async () => {
    const dataDir = beforeAnUpdate([switching(), { behaviour: "crash-after-commit", writes: ["written by the target"] }, "crash"]);
    const running = launch({ dataDir });
    await running.events("committed", 2);
    await restartAfter(running, 5_000);
    await restartAfter(running, 10_000);
    const [, , , fourth] = await running.events("started", 4);
    expect(fourth).toMatchObject({ version: "0.5.0" });
    await running.events("committed", 3);
    expect(stateIn(dataDir)).toMatchObject({ activeVersion: "0.5.0", watchedUpdateId: updateId });
    expect(existsSync(join(dataDir, "update-outcome.json"))).toBe(false);
    expect(readDatabase(dataDir)).toEqual(["before the update", "written by the target"]);
  });

  it("restores nothing after three unexpected exits once the watch is over, and restarts the child as it always does", async () => {
    // Busy when asked idle?, so the launcher does not hand over to 0.5.0's.
    const dataDir = beforeAnUpdate([switching(), { writes: ["written by the target"], busyFor: 99 }, "crash", "crash"]);
    const running = launch({ dataDir });
    const [, committed] = await running.events("committed", 2);
    running.timer.run(10 * 60_000);
    expect(stateIn(dataDir)).toMatchObject({ activeVersion: "0.5.0", watchDeadline: null, watchedUpdateId: null });
    expect(running.log()).toContain(`launcher: the watch of update ${updateId} is over: 0.5.0 held for 10 minutes`);
    process.kill(committed?.pid ?? 0, "SIGKILL");
    await restartAfter(running, 5_000);
    await restartAfter(running, 10_000);
    await restartAfter(running, 20_000);
    const [, , , , fifth] = await running.events("started", 5);
    expect(fifth).toMatchObject({ version: "0.5.0" });
    await running.events("committed", 3);
    expect(existsSync(join(dataDir, "update-outcome.json"))).toBe(false);
    expect(readDatabase(dataDir)).toEqual(["before the update", "written by the target"]);
  });

  it("touches no file but the database's three when it rolls back, keeping everything else written since the commit", async () => {
    const dataDir = beforeAnUpdate([switching(), "serve", "crash", "crash"]);
    // Files outside SQLite, before the update and since the commit: a workspace, the attachment stage, an account directory, the vault.
    mkdirSync(join(dataDir, "workspaces", "notes"), { recursive: true });
    writeFileSync(join(dataDir, "workspaces", "notes", "before.md"), "written before the update");
    const running = launch({ dataDir });
    const [, committed] = await running.events("committed", 2);
    const sinceTheCommit: [path: string, text: string][] = [
      ["workspaces/notes/after.md", "since the commit"],
      ["attachments/stage/a.bin", "staged"],
      ["accounts/claude/settings.json", "{}"],
      ["vault.json", "{}"],
    ];
    for (const [path, text] of sinceTheCommit) {
      mkdirSync(join(dataDir, path, ".."), { recursive: true });
      writeFileSync(join(dataDir, path), text);
    }
    writeDatabase(dataDir, ["written since the commit"], "open");
    const others = environmentFiles(dataDir);
    process.kill(committed?.pid ?? 0, "SIGKILL");
    await restartAfter(running, 5_000);
    await restartAfter(running, 10_000);
    await running.events("started", 5);
    expect(environmentFiles(dataDir)).toEqual(others);
    expect(readDatabase(dataDir)).toEqual(["before the update"]);
  });

  /** 0.5.0 active after update 0.4.0 to 0.5.0, committed with its watch ending at `watchDeadline`, the snapshot taken before it, and the database written since. */
  const committedAndWatched = (watchDeadline: string, starts: readonly ChildStart[] = []): string => {
    const dataDir = beforeAnUpdate(starts);
    takeSnapshot(dataDir, updateId);
    writeServiceState(dataDir, { ...state("0.5.0"), previousVersion: "0.4.0", launcherVersion: "0.4.0", watchDeadline, watchedUpdateId: updateId });
    writeDatabase(dataDir, ["written since the commit"], "open");
    return dataDir;
  };

  it("keeps watching until the deadline in the state when it starts during a watch, and rolls back a crash loop then", async () => {
    // The fake clock starts at 12:00, three minutes after this commit.
    const dataDir = committedAndWatched("2026-09-28T12:07:00.000Z", ["crash", "crash", "crash"]);
    const running = launch({ dataDir });
    await restartAfter(running, 5_000);
    expect(running.timer.pending()).toContain(7 * 60_000);
    await restartAfter(running, 10_000);
    const [, , , old] = await running.events("started", 4);
    expect(old).toMatchObject({ version: "0.4.0" });
    expect(outcomeIn(dataDir)).toEqual({ ...update, stage: "crash-loop", reason: "exit" });
    expect(stateIn(dataDir)).toEqual({ ...state("0.4.0"), previousVersion: "0.5.0" });
    expect(readDatabase(dataDir)).toEqual(["before the update"]);
  });

  it("ends a watch whose deadline passed while it was stopped as soon as it starts", async () => {
    const dataDir = committedAndWatched("2026-09-28T11:55:00.000Z");
    const running = launch({ dataDir });
    expect(running.log()[0]).toBe(`launcher: the watch of update ${updateId} is over: 0.5.0 held for 10 minutes`);
    expect(stateIn(dataDir)).toMatchObject({ activeVersion: "0.5.0", watchDeadline: null, watchedUpdateId: null });
    await running.events("committed");
  });

  it("finishes a crash-loop restore it was killed in before it starts any child, making the version the update went from active again", async () => {
    const dataDir = committedAndWatched("2026-09-28T12:07:00.000Z");
    const record = { ...update, stage: "crash-loop", reason: "exit" };
    writeFileSync(join(dataDir, RESTORE_MARKER_FILE), JSON.stringify(record));
    const running = launch({ dataDir });
    const [first] = await running.events("started");
    expect(first).toMatchObject({ version: "0.4.0" });
    expect(running.log()[0]).toBe(`launcher: finished the restore of update ${updateId}, which was cut short`);
    expect(outcomeIn(dataDir)).toEqual(record);
    expect(stateIn(dataDir)).toEqual({ ...state("0.4.0"), previousVersion: "0.5.0" });
    expect(readDatabase(dataDir)).toEqual(["before the update"]);
    expect(running.timer.pending()).toEqual([]);
  });
});

/** Another update's id: one rolled back before, whose snapshot was kept (#443). */
const rolledBackId = "0c6f8e2a-94b1-4d37-a5e2-6b8c0d1f2a3e";

describe.runIf(posix)("the launcher at the end of a watch", () => {
  /**
   * A data directory updating 0.4.0 to 0.5.0 with versions 0.1.0 to 0.7.0
   * installed besides and a rolled-back update's snapshot kept, whose target,
   * once committed, asks `install?` for 0.6.0 as the environment stages its
   * next update, and answers `idle?` busy.
   */
  const withManyVersions = (): string => {
    const dataDir = beforeAnUpdate([]);
    for (const version of ["0.1.0", "0.2.0", "0.3.0", "0.3.1", "0.7.0"]) installVersion(dataDir, version);
    // A folder an install cut short left: no version.
    layOutVersion(join(dataDir, "versions", "0.0.9"), "0.0.9");
    const staged = stageVersion(dataDir, "0.6.0");
    // Busy whenever asked, so the launcher, whose own version is not the active one, does not hand over.
    scriptChild(dataDir, [{ ...(switching() as ScriptedStart), busyFor: 99 }, { install: { version: "0.6.0", staged }, busyFor: 99 }]);
    takeSnapshot(dataDir, rolledBackId);
    mkdirSync(join(dataDir, "snapshots", `${rolledBackId}.staging`));
    return dataDir;
  };

  it("discards the snapshots and prunes the versions to the active one, the two before it, the launcher's own and the one staged, and nothing before", async () => {
    const dataDir = withManyVersions();
    const running = launch({ dataDir, version: "0.2.0" });
    await running.events("install-answered");
    // Nothing is pruned during the watch.
    expect(treeOf(join(dataDir, "snapshots"))).toEqual([rolledBackId, `${rolledBackId}.staging`, `${rolledBackId}/environment.db`, updateId, `${updateId}/environment.db`].sort());
    expect(completeVersions(dataDir)).toEqual(["0.1.0", "0.2.0", "0.3.0", "0.3.1", "0.4.0", "0.5.0", "0.6.0", "0.7.0"]);

    running.timer.run(10 * 60_000);

    expect(completeVersions(dataDir)).toEqual(["0.2.0", "0.3.1", "0.4.0", "0.5.0", "0.6.0"]);
    expect(readdirSync(join(dataDir, "versions")).sort()).toEqual(["0.2.0", "0.3.1", "0.4.0", "0.5.0", "0.6.0"]);
    expect(readdirSync(join(dataDir, "snapshots"))).toEqual([]);
    expect(stateIn(dataDir)).toMatchObject({ activeVersion: "0.5.0", watchDeadline: null, watchedUpdateId: null, stagedVersion: "0.6.0" });
    const over = running.log().indexOf(`launcher: the watch of update ${updateId} is over: 0.5.0 held for 10 minutes`);
    expect(running.log().slice(over, over + 4)).toEqual([
      `launcher: the watch of update ${updateId} is over: 0.5.0 held for 10 minutes`,
      `launcher: discarded the snapshot of update ${rolledBackId}`,
      `launcher: discarded the snapshot of update ${updateId}`,
      "launcher: pruned 0.0.9, 0.1.0, 0.3.0 and 0.7.0, keeping 0.2.0, 0.3.1, 0.4.0, 0.5.0 and 0.6.0",
    ]);
  });

  // Root ignores mode bits, so an ordinary user verifies read-only version pruning.
  it.runIf(!runningAsRoot)("removes read-only version directories and clears the rest away", async () => {
    const dataDir = withManyVersions();
    const locked = join(dataDir, "versions", "0.1.0", "packages");
    chmodSync(locked, 0o555);
    cleanups.push(() => { if (existsSync(locked)) chmodSync(locked, 0o755); });
    const running = launch({ dataDir, version: "0.2.0" });
    await running.events("install-answered");
    running.timer.run(10 * 60_000);
    expect(readdirSync(join(dataDir, "versions")).sort()).toEqual(["0.2.0", "0.3.1", "0.4.0", "0.5.0", "0.6.0"]);
    expect(completeVersions(dataDir)).toEqual(["0.2.0", "0.3.1", "0.4.0", "0.5.0", "0.6.0"]);
    expect(readdirSync(join(dataDir, "snapshots"))).toEqual([]);
    expect(running.log()).toContain("launcher: pruned 0.0.9, 0.1.0, 0.3.0 and 0.7.0, keeping 0.2.0, 0.3.1, 0.4.0, 0.5.0 and 0.6.0");
  });

  it("prunes nothing and keeps the snapshots when the watch ends while an update is pending", async () => {
    const dataDir = beforeAnUpdate([switching(), { switchTo: { updateId: rolledBackId, version: "0.7.0", lingers: true } }]);
    for (const version of ["0.1.0", "0.2.0", "0.3.0", "0.7.0"]) installVersion(dataDir, version);
    const running = launch({ dataDir });
    await running.events("switching", 2);
    running.timer.run(10 * 60_000);
    expect(completeVersions(dataDir)).toEqual(["0.1.0", "0.2.0", "0.3.0", "0.4.0", "0.5.0", "0.7.0"]);
    expect(readdirSync(join(dataDir, "snapshots"))).toEqual([updateId]);
    expect(stateIn(dataDir)).toMatchObject({ pendingUpdate: { updateId: rolledBackId, fromVersion: "0.5.0", toVersion: "0.7.0" }, watchDeadline: null, watchedUpdateId: null });
    expect(running.log()).toContain(`launcher: the watch of update ${updateId} is over while update ${rolledBackId} is pending, so nothing is pruned`);
  });
});

/** The launcher's handover files in `dataDir`: the launcher version file, the handover record and the launcher entry's start counter, each as its text or null when absent. */
const handoverFiles = (dataDir: string): Record<string, string | null> =>
  Object.fromEntries(
    ["launcher-version", "launcher-handover", "launcher-handover-starts"].map((name) => [
      name,
      existsSync(join(dataDir, name)) ? readFileSync(join(dataDir, name), "utf8") : null,
    ]),
  );

/** What the children heard of `type`, in order. */
const heardOf = (running: Running, type: string): ChildEvent[] =>
  running.report().filter((line) => line.event === "heard" && (line["message"] as { type?: string } | undefined)?.type === type);

describe.runIf(posix)("the launcher handing over to a newer launcher", () => {
  it("asks idle? every ten minutes once the watch is over, when the active version is not its own, and at the first idle writes the handover and exits with the relaunch code", async () => {
    const dataDir = beforeAnUpdate([switching(), { busyFor: 2 }]);
    writeFileSync(join(dataDir, "launcher-version"), "0.4.0\n");
    const running = launch({ dataDir });
    let exitCode: number | undefined;
    void running.launcher.stopped.then((code) => (exitCode = code));
    await running.events("committed", 2);
    // Nothing is asked during the watch.
    expect(heardOf(running, "idle?")).toEqual([]);

    running.timer.run(10 * 60_000);
    await until("the first idle? is answered", () => running.log().some((line) => line.includes("busy")));
    expect(heardOf(running, "idle?")).toHaveLength(1);
    expect(running.timer.pending()).toEqual([10 * 60_000]);
    running.timer.run(10 * 60_000);
    await until("the second idle? is answered", () => running.log().filter((line) => line.includes("busy")).length === 2);
    expect(handoverFiles(dataDir)).toEqual({ "launcher-version": "0.4.0\n", "launcher-handover": null, "launcher-handover-starts": null });
    running.timer.run(10 * 60_000);

    const code = await running.launcher.stopped;
    expect(code).toBe(RELAUNCH_EXIT_CODE);
    expect(exitCode).toBe(RELAUNCH_EXIT_CODE);
    expect(handoverFiles(dataDir)).toEqual({ "launcher-version": "0.5.0\n", "launcher-handover": "0.4.0\n0.5.0\n", "launcher-handover-starts": null });
    expect((await running.events("drained"))[0]).toMatchObject({ version: "0.5.0", trigger: "launcher" });
    await until("the child's exit is logged", () => running.log().at(-1) === "launcher: 0.5.0 exited with code 0");
    expect(running.log().slice(running.log().indexOf(`launcher: the watch of update ${updateId} is over: 0.5.0 held for 10 minutes`))).toEqual([
      `launcher: the watch of update ${updateId} is over: 0.5.0 held for 10 minutes`,
      `launcher: discarded the snapshot of update ${updateId}`,
      "launcher: 0.5.0 carries another launcher than this one's 0.4.0, so it is asked idle? every 10 minutes to hand over to it",
      "launcher: 0.5.0 is busy (run-running), so the handover waits",
      "launcher: 0.5.0 is busy (run-running), so the handover waits",
      `launcher: handing over to the launcher of 0.5.0: ${join(dataDir, "launcher-version")} names it, and this launcher exits with code ${RELAUNCH_EXIT_CODE} once 0.5.0 has drained, for the service manager to start it`,
      "launcher: stopping: draining 0.5.0",
      "launcher: 0.5.0 exited with code 0",
    ]);
    expect(running.timer.pending()).toEqual([]);
    // It pruned before it handed over, keeping its own version for the launcher entry to fall back to.
    expect(completeVersions(dataDir)).toEqual(["0.4.0", "0.5.0"]);
  });

  /**
   * 0.5.0 active and its launcher handed over to by 0.4.0's, which the
   * launcher version file names: the handover record, and the launcher
   * entry's start counter at `starts`.
   */
  const handedOver = (starts: readonly ChildStart[] = [], pointer = "0.5.0"): string => {
    const dataDir = dataDirectory();
    installVersion(dataDir, "0.4.0");
    installVersion(dataDir, "0.5.0");
    writeServiceState(dataDir, { ...state("0.5.0"), previousVersion: "0.4.0", launcherVersion: "0.4.0" });
    writeFileSync(join(dataDir, "launcher-version"), `${pointer}\n`);
    writeFileSync(join(dataDir, "launcher-handover"), "0.4.0\n0.5.0\n");
    writeFileSync(join(dataDir, "launcher-handover-starts"), "2\n");
    scriptChild(dataDir, starts);
    return dataDir;
  };

  it("confirms the handover once its child passes the gate, as the launcher handed over to: the record and the start counter go, and the state names it the launcher", async () => {
    const dataDir = handedOver();
    writeServiceState(dataDir, { ...state("0.5.0"), previousVersion: "0.4.0", launcherVersion: "0.4.0", failedHandover: { toVersion: "0.4.9", at: "2026-09-27T09:30:00.000Z" } });
    const running = launch({ dataDir, version: "0.5.0" });
    await until("the handover is confirmed", () => running.log().some((line) => line.includes("confirmed")));
    expect(running.log()).toContain("launcher: confirmed the handover from the launcher of 0.4.0: 0.5.0 passed the gate under this one");
    expect(handoverFiles(dataDir)).toEqual({ "launcher-version": "0.5.0\n", "launcher-handover": null, "launcher-handover-starts": null });
    expect(stateIn(dataDir)).toEqual({ ...state("0.5.0"), previousVersion: "0.4.0" });
    // The launcher it replaced is not asked for: it is its own.
    expect(running.timer.pending()).toEqual([]);
  });

  const unconfirmed: [what: string, starts: ChildStart[], act: (running: Running) => Promise<void>, why: string][] = [
    ["exits before it passes the gate", ["crash"], async () => undefined, "0.5.0 exited with code 1 before it passed the gate"],
    [
      "says nothing within 120 seconds of its spawn",
      ["silent"],
      async (running) => {
        await running.events("started");
        expect(running.timer.pending()).toEqual([120_000]);
        running.timer.run(120_000);
      },
      "0.5.0 did not say prepared within 120 s of its spawn",
    ],
  ];

  for (const [what, starts, act, why] of unconfirmed) {
    it(`exits 1, restarting nothing, when its child ${what} as the launcher handed over to, so the launcher entry counts the start`, async () => {
      const dataDir = handedOver(starts);
      const running = launch({ dataDir, version: "0.5.0" });
      await act(running);
      expect(await running.launcher.stopped).toBe(1);
      expect(running.log()).toContain(`launcher: the handover from the launcher of 0.4.0 is not confirmed: ${why}, so this launcher exits with code 1 for the launcher entry to count the start`);
      expect(running.report().filter((line) => line.event === "started")).toHaveLength(1);
      expect(handoverFiles(dataDir)).toEqual({ "launcher-version": "0.5.0\n", "launcher-handover": "0.4.0\n0.5.0\n", "launcher-handover-starts": "2\n" });
      expect(stateIn(dataDir)?.launcherVersion).toBe("0.4.0");
      expect(running.timer.pending()).toEqual([]);
    });
  }

  it("exits 1 when it starts nothing as the launcher handed over to", async () => {
    const dataDir = handedOver();
    writeFileSync(join(dataDir, SERVICE_STATE_FILE), "{ not json");
    const running = launch({ dataDir, version: "0.5.0" });
    expect(await running.launcher.stopped).toBe(1);
    expect(running.log()[0]).toMatch(/^launcher: starts nothing: the service state at .* is not valid: it is not JSON$/);
    expect(running.log()[1]).toBe(
      "launcher: the handover from the launcher of 0.4.0 is not confirmed: this launcher starts nothing, so this launcher exits with code 1 for the launcher entry to count the start",
    );
  });

  it("records that the handover failed when the launcher entry starts it again after the one it handed over to went unconfirmed, and never hands over to that version again", async () => {
    const dataDir = handedOver([], "0.4.0");
    writeFileSync(join(dataDir, "launcher-handover-starts"), "3\n");
    const running = launch({ dataDir, version: "0.4.0" });
    await running.events("committed");
    expect(stateIn(dataDir)).toEqual({
      ...state("0.5.0"),
      previousVersion: "0.4.0",
      launcherVersion: "0.4.0",
      failedHandover: { toVersion: "0.5.0", at: "2026-09-28T12:00:00.000Z" },
    });
    await until("the failed handover is reported to the environment", () => heardOf(running, "versions").length > 0);
    expect(heardOf(running, "versions").map((event) => event.message)).toEqual([
      { type: "versions", id: 1, installed: ["0.4.0", "0.5.0"], launcherVersion: "0.4.0", launcherProtocol: LAUNCHER_PROTOCOL, failedHandoverVersion: "0.5.0" },
    ]);
    expect(handoverFiles(dataDir)).toEqual({ "launcher-version": "0.4.0\n", "launcher-handover": null, "launcher-handover-starts": null });
    expect(running.log()[0]).toBe(
      "launcher: the handover to the launcher of 0.5.0 failed: it was not confirmed, and the launcher entry started this launcher again, which runs on",
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(heardOf(running, "idle?")).toEqual([]);
    expect(running.timer.pending()).toEqual([]);
  });

  it("asks nothing when the active version is its own", async () => {
    const running = launch();
    await running.events("committed");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(running.timer.pending()).toEqual([]);
    expect(heardOf(running, "idle?")).toEqual([]);
  });
});

/** Whether no process is `pid` any more. */
const gone = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

/** Every file and folder under `dir`, by its path relative to it, sorted; none when it is not there. */
const treeOf = (dir: string): string[] => (existsSync(dir) ? (readdirSync(dir, { recursive: true }) as string[]).sort() : []);

/**
 * A data directory running 0.5.0 whose environment, once committed, asks
 * `install?` for 0.6.0 staged in the staging area as `layout` says (or asks
 * `ask` in its place), and the folder it staged.
 */
const beforeAnInstall = (layout: VersionLayout = {}, ask?: { version: string; staged: string }): { dataDir: string; staged: string } => {
  const dataDir = dataDirectory();
  installVersion(dataDir, "0.5.0");
  writeServiceState(dataDir, state("0.5.0"));
  const staged = stageVersion(dataDir, "0.6.0", layout);
  scriptChild(dataDir, [{ install: ask ?? { version: "0.6.0", staged } }]);
  return { dataDir, staged };
};

/** The answer the environment heard to its `install?`, and what it found as it heard it. */
const installAnswer = async (running: Running): Promise<{ answer: InstallAnswer & { id: number }; complete: boolean; staged: boolean }> => {
  const [answered] = await running.events("install-answered");
  return answered as unknown as { answer: InstallAnswer & { id: number }; complete: boolean; staged: boolean };
};

describe.runIf(posix)("the launcher installing a staged version", () => {
  it("reclaims only a newly installed candidate when disk space drops before switching, restarting the old environment with its data unchanged", async () => {
    for (const alreadyInstalled of [false, true]) {
      const { dataDir, staged } = beforeAnInstall();
      if (alreadyInstalled) installVersion(dataDir, "0.6.0");
      installVersion(dataDir, "0.4.0");
      writeDatabase(dataDir, ["kept user data"], "closed");
      const before = readDatabase(dataDir);
      const updateId = "11111111-1111-4111-8111-111111111111";
      scriptChild(dataDir, [{ install: { version: "0.6.0", staged }, switchTo: { updateId, version: "0.6.0" } }, "serve"]);
      const running = launch({ dataDir, freeBytes: () => existsSync(join(dataDir, "versions", "0.6.0", ".complete")) ? 256 * 1024 * 1024 - 1 : 2 ** 40 });
      expect((await installAnswer(running)).answer.type).toBe("installed");
      await running.events("committed", 2);
      expect(running.report().filter((line) => line.event === "started").map((line) => line.version)).toEqual(["0.5.0", "0.5.0"]);
      expect(completeVersions(dataDir)).toEqual(alreadyInstalled ? ["0.4.0", "0.5.0", "0.6.0"] : ["0.4.0", "0.5.0"]);
      expect(stateIn(dataDir)?.activeVersion).toBe("0.5.0");
      expect(stateIn(dataDir)?.launcherVersion).toBe("0.5.0");
      expect(readDatabase(dataDir)).toEqual(before);
      await running.stop();
    }
  });

  it("runs the staged version's preflight on its own Node, renames it into the versions directory, its sentinel last, and only then answers installed", async () => {
    const { dataDir, staged } = beforeAnInstall();
    const stagedFiles = treeOf(staged);
    const running = launch({ dataDir });
    const heard = await installAnswer(running);
    // By the time the environment hears installed, the version is complete in the versions directory and gone from the staging area.
    expect(heard).toEqual({ ...heard, answer: { type: "installed", id: 3 }, complete: true, staged: false });
    expect(preflightRuns(dataDir)).toEqual([{ version: "0.6.0", args: ["preflight"], pid: expect.any(Number) as unknown as number }]);
    expect(treeOf(join(dataDir, "versions", "0.6.0"))).toEqual([...stagedFiles, ".complete"].sort());
    expect(existsSync(staged)).toBe(false);
    const report = `{"version":"0.6.0","protocolVersion":1,"launcherProtocol":${LAUNCHER_PROTOCOL},"databaseSchemaVersion":6,"bundledClaudeCodeVersion":"2.1.283"}`;
    expect(running.log().filter((line) => /preflight|install/.test(line))).toEqual([
      "launcher: running the preflight of 0.6.0",
      `launcher: preflight of 0.6.0: ${report}`,
      `launcher: installed 0.6.0 into ${join(dataDir, "versions")}: its preflight passed`,
    ]);
    expect(stateIn(dataDir)?.stagedVersion).toBe("0.6.0");
    expect(completeVersions(dataDir)).toEqual(["0.5.0", "0.6.0"]);
    // The preflight's 30 seconds went with its end.
    expect(running.timer.pending()).toEqual([]);
  });

  it("remembers a new waiting candidate across a launcher restart and reclaims it only after a refused switch", async () => {
    const { dataDir } = beforeAnInstall();
    const staging = launch({ dataDir });
    expect((await installAnswer(staging)).answer.type).toBe("installed");
    await staging.stop();
    expect(completeVersions(dataDir)).toEqual(["0.5.0", "0.6.0"]);
    scriptChild(dataDir, ["serve", { switchTo: { updateId: "11111111-1111-4111-8111-111111111111", version: "0.6.0" } }, "serve"]);
    const switching = launch({ dataDir, freeBytes: () => 0 });
    await switching.events("committed", 3);
    expect(completeVersions(dataDir)).toEqual(["0.5.0"]);
    expect(stateIn(dataDir)?.stagedVersion).toBe(null);
  });

  it("answers installed without a second copy or a preflight for a version already complete in the versions directory, and clears the staged copy", async () => {
    const { dataDir, staged } = beforeAnInstall();
    installVersion(dataDir, "0.6.0");
    writeFileSync(join(dataDir, "versions", "0.6.0", "installed-before"), "");
    const before = treeOf(join(dataDir, "versions"));
    const running = launch({ dataDir });
    expect((await installAnswer(running)).answer).toEqual({ type: "installed", id: 3 });
    expect(treeOf(join(dataDir, "versions"))).toEqual(before);
    expect(preflightRuns(dataDir)).toEqual([]);
    expect(existsSync(staged)).toBe(false);
    expect(running.log()).toContain(`launcher: 0.6.0 is installed already, so ${staged} is not installed again`);
  });

  it("gives the preflight 30 seconds, then ends it and refuses preflight, with its output in the log and the versions directory as it was", async () => {
    const { dataDir, staged } = beforeAnInstall({ preflight: { behaviour: "hang" } });
    const before = treeOf(join(dataDir, "versions"));
    const running = launch({ dataDir });
    // Its output goes to the log as it comes, so what it was loading is there before it is ended.
    await until("the preflight's output is logged", () => running.log().includes("launcher: preflight of 0.6.0: loading SQLite"));
    expect(running.timer.pending()).toEqual([30_000]);
    running.timer.runNext();
    const heard = await installAnswer(running);
    expect(heard.answer).toEqual({ type: "refused", id: 3, reason: "preflight" });
    expect(heard.staged).toBe(true);
    expect(treeOf(join(dataDir, "versions"))).toEqual(before);
    expect(running.log()).toContain(`launcher: refuses install? of 0.6.0 from ${staged}: preflight, as its preflight did not finish within 30 s, so it was ended`);
    const pid = preflightRuns(dataDir)[0]?.pid ?? 0;
    await until("the preflight is gone", () => gone(pid));
  });

  it("refuses preflight when the preflight fails, with everything it printed in the log and the versions directory as it was", async () => {
    const { dataDir, staged } = beforeAnInstall({ preflight: { behaviour: "fail" } });
    const before = treeOf(join(dataDir, "versions"));
    const running = launch({ dataDir });
    expect((await installAnswer(running)).answer).toEqual({ type: "refused", id: 3, reason: "preflight" });
    expect(treeOf(join(dataDir, "versions"))).toEqual(before);
    const lines = running.log().filter((line) => /preflight|install/.test(line));
    expect(lines[0]).toBe("launcher: running the preflight of 0.6.0");
    // Its standard output and error are two streams, heard in whichever order they arrive, and all of it before the refusal.
    expect(lines.slice(1, -1).sort()).toEqual([
      "launcher: preflight of 0.6.0: agent-harness preflight failed: node-pty: node-pty did not load (invalid ELF header).",
      "launcher: preflight of 0.6.0: loading SQLite, node-pty and the bundled Claude binary",
    ]);
    expect(lines.at(-1)).toBe(`launcher: refuses install? of 0.6.0 from ${staged}: preflight, as its preflight exited with code 1`);
  });

  it("refuses preflight when the preflight passes but reports another version", async () => {
    const { dataDir, staged } = beforeAnInstall({ preflight: { reports: { version: "0.6.1" } } });
    const running = launch({ dataDir });
    expect((await installAnswer(running)).answer).toEqual({ type: "refused", id: 3, reason: "preflight" });
    expect(running.log()).toContain(`launcher: refuses install? of 0.6.0 from ${staged}: preflight, as its preflight reported 0.6.1`);
    expect(existsSync(join(dataDir, "versions", "0.6.0"))).toBe(false);
  });

  it("refuses launcher-protocol before the preflight runs when the version needs a higher launcher protocol than this launcher speaks", async () => {
    const { dataDir, staged } = beforeAnInstall({ launcherProtocol: LAUNCHER_PROTOCOL + 1 });
    const before = treeOf(join(dataDir, "versions"));
    const running = launch({ dataDir });
    expect((await installAnswer(running)).answer).toEqual({ type: "refused", id: 3, reason: "launcher-protocol" });
    expect(preflightRuns(dataDir)).toEqual([]);
    expect(treeOf(join(dataDir, "versions"))).toEqual(before);
    expect(running.log()).toContain(
      `launcher: refuses install? of 0.6.0 from ${staged}: launcher-protocol, as 0.6.0 needs launcher protocol ${LAUNCHER_PROTOCOL + 1} and this launcher speaks ${LAUNCHER_PROTOCOL}`,
    );
  });

  it("refuses incomplete before the preflight runs when the staging folder lacks the version's Node, leaving the versions directory as it was", async () => {
    const { dataDir, staged } = beforeAnInstall();
    rmSync(join(staged, "node"), { recursive: true });
    const before = treeOf(join(dataDir, "versions"));
    const running = launch({ dataDir });
    expect((await installAnswer(running)).answer).toEqual({ type: "refused", id: 3, reason: "incomplete" });
    expect(preflightRuns(dataDir)).toEqual([]);
    expect(treeOf(join(dataDir, "versions"))).toEqual(before);
    expect(running.log()).toContain(`launcher: refuses install? of 0.6.0 from ${staged}: incomplete, as ${staged} has no Node runtime at ${join(staged, "node", "bin", "node")}`);
  });

  it("refuses disk before the preflight runs with less free than the 256 MiB a version needs to run, and io when the free space cannot be read", async () => {
    const full = beforeAnInstall();
    const refused = launch({ dataDir: full.dataDir, freeBytes: () => 256 * 1024 * 1024 - 1 });
    expect((await installAnswer(refused)).answer).toEqual({ type: "refused", id: 3, reason: "disk" });
    expect(refused.log()).toContain(`launcher: refuses install? of 0.6.0 from ${full.staged}: disk, as ${256 * 1024 * 1024 - 1} bytes are free and staging must leave ${256 * 1024 * 1024} for the database snapshot and reserve`);
    expect(preflightRuns(full.dataDir)).toEqual([]);

    const unread = beforeAnInstall();
    const failed = launch({
      dataDir: unread.dataDir,
      freeBytes: () => {
        throw new Error("statfs failed");
      },
    });
    expect((await installAnswer(failed)).answer).toEqual({ type: "refused", id: 3, reason: "io" });
    expect(failed.log()).toContain(`launcher: refuses install? of 0.6.0 from ${unread.staged}: io, as statfs failed`);

    const room = beforeAnInstall();
    const installed = launch({ dataDir: room.dataDir, freeBytes: () => 256 * 1024 * 1024 });
    expect((await installAnswer(installed)).answer).toEqual({ type: "installed", id: 3 });
  });

  it("ends a preflight under way when the service manager stops it, and installs nothing", async () => {
    const { dataDir } = beforeAnInstall({ preflight: { behaviour: "hang" } });
    const running = launch({ dataDir });
    await until("the preflight runs", () => preflightRuns(dataDir).length === 1);
    await running.launcher.stop();
    const pid = preflightRuns(dataDir)[0]?.pid ?? 0;
    await until("the preflight is gone", () => gone(pid));
    expect(existsSync(join(dataDir, "versions", "0.6.0"))).toBe(false);
    expect(running.report().some((line) => line.event === "install-answered")).toBe(false);
  });
});

/**
 * How long the real preflight may take here: it runs through tsx, which loads
 * and transforms the whole environment package first, 20 s and more on a
 * loaded runner (#634). Its 30 seconds are on the test's timer, which never runs.
 */
const REAL_PREFLIGHT_MS = 120_000;

// preflight, unlike serve, runs as any user, so this runs as root too.
describe.runIf(posix)("the launcher over the real preflight", { timeout: REAL_PREFLIGHT_MS }, () => {
  it("installs a staged version of this build, whose own preflight loads SQLite, node-pty and the bundled Claude binary", async () => {
    const dataDir = dataDirectory();
    installVersion(dataDir, "0.5.0");
    writeServiceState(dataDir, state("0.5.0"));
    const staged = stagedFolder(dataDir, HARNESS_VERSION);
    layOutVersion(staged, HARNESS_VERSION, new URL("../main.ts", import.meta.url).pathname);
    scriptChild(dataDir, [{ install: { version: HARNESS_VERSION, staged } }]);
    const running = launch({ dataDir });
    await until("the install is answered", () => running.report().some((line) => line.event === "install-answered"), REAL_PREFLIGHT_MS);
    expect((await installAnswer(running)).answer).toEqual({ type: "installed", id: 3 });
    expect(completeVersions(dataDir)).toContain(HARNESS_VERSION);
    const printed = running.log().find((line) => line.startsWith(`launcher: preflight of ${HARNESS_VERSION}: {`));
    expect(JSON.parse(printed?.slice(`launcher: preflight of ${HARNESS_VERSION}: `.length) ?? "null")).toMatchObject({
      version: HARNESS_VERSION,
      launcherProtocol: LAUNCHER_PROTOCOL,
    });
  });
});

// serve refuses root (ADR 0006), so this runs only as an ordinary user; the scripted child stands in for it above.
describe.runIf(posix && !runningAsRoot)("the launcher over the real serve", () => {
  it("runs a version's serve, which serves only once committed, and drains it on stop", async () => {
    const dataDir = dataDirectory();
    installVersion(dataDir, HARNESS_VERSION, new URL("../main.ts", import.meta.url).pathname);
    writeServiceState(dataDir, state(HARNESS_VERSION));
    const running = launch({ dataDir, port: 0 });
    await until("serve is committed", () => running.log().includes(`launcher: ${HARNESS_VERSION} committed`));
    const grant = join(dataDir, BOOTSTRAP_GRANT_FILE);
    await until("serve writes its bootstrap grant", () => existsSync(grant));
    const { address } = BootstrapGrant.parse(JSON.parse(readFileSync(grant, "utf8")));
    const discovery = `http://${address.host}:${address.port}${DISCOVERY_PATH}`;
    await vi.waitFor(async () => expect(await (await fetch(discovery)).json()).toMatchObject({ readiness: "ready", harnessVersion: HARNESS_VERSION }), { timeout: 15_000 });
    await running.stop();
    await until("serve's exit is logged", () => running.log().at(-1) === `launcher: ${HARNESS_VERSION} exited with code 0`);
    expect(running.log().slice(1)).toEqual([
      `launcher: ${HARNESS_VERSION} committed`,
      `launcher: stopping: draining ${HARNESS_VERSION}`,
      `launcher: ${HARNESS_VERSION} exited with code 0`,
    ]);
    await expect(fetch(discovery)).rejects.toThrow();
  });

  /**
   * Serve's start holds it busy for the idle window (#445), a minute at the
   * least on serve's own clock, which the test's timer does not move: so a
   * real serve is asked and answers, and the handover waits. The handover at
   * the first idle is the scripted child's test above. Waits on serve's
   * answer, however long serve takes to start through tsx (the real
   * preflight's budget, #634).
   */
  it("asks a real serve idle? to hand over to its launcher, and waits while the serve's start holds it busy, draining it on stop", { timeout: REAL_PREFLIGHT_MS }, async () => {
    const dataDir = dataDirectory();
    installVersion(dataDir, HARNESS_VERSION, new URL("../main.ts", import.meta.url).pathname);
    writeServiceState(dataDir, state(HARNESS_VERSION));
    const running = launch({ dataDir, port: 0, version: "0.4.0" });
    // Serve answers queries only once its wire is open, a moment after its commit, so the ask at the commit may go unheard: each second the test runs the next ask, which the launcher makes every ten minutes.
    const nextAsk = setInterval(() => {
      if (running.timer.pending().includes(10 * 60_000)) running.timer.run(10 * 60_000);
    }, 1_000);
    cleanups.push(() => clearInterval(nextAsk));
    const waits = `launcher: ${HARNESS_VERSION} is busy (recent-activity), so the handover waits`;
    await until("serve answers idle? busy", () => running.log().includes(waits), REAL_PREFLIGHT_MS);
    expect(await running.stop()).toBe(0);
    expect(handoverFiles(dataDir)).toEqual({ "launcher-version": null, "launcher-handover": null, "launcher-handover-starts": null });
    await until("serve's exit is logged", () => running.log().at(-1) === `launcher: ${HARNESS_VERSION} exited with code 0`);
    expect(running.log().slice(1).filter((line) => line !== waits)).toEqual([
      `launcher: ${HARNESS_VERSION} committed`,
      `launcher: ${HARNESS_VERSION} carries another launcher than this one's 0.4.0, so it is asked idle? every 10 minutes to hand over to it`,
      `launcher: stopping: draining ${HARNESS_VERSION}`,
      `launcher: ${HARNESS_VERSION} exited with code 0`,
    ]);
  });

  it("commits a trial of the real serve, which passes its gate on the database the switch snapshotted", async () => {
    const dataDir = dataDirectory();
    installVersion(dataDir, "0.4.0");
    installVersion(dataDir, HARNESS_VERSION, new URL("../main.ts", import.meta.url).pathname);
    writeServiceState(dataDir, state("0.4.0"));
    scriptChild(dataDir, [switching({ version: HARNESS_VERSION })]);
    const running = launch({ dataDir, port: 0 });
    await until("serve's trial is committed", () => running.log().some((line) => line.startsWith(`launcher: ${HARNESS_VERSION} committed: update ${updateId}`)));
    expect(stateIn(dataDir)).toMatchObject({ activeVersion: HARNESS_VERSION, previousVersion: "0.4.0", pendingUpdate: null });
    expect(hasSnapshot(dataDir, updateId)).toBe(true);
    const grant = join(dataDir, BOOTSTRAP_GRANT_FILE);
    await until("serve writes its bootstrap grant", () => existsSync(grant));
    const { address } = BootstrapGrant.parse(JSON.parse(readFileSync(grant, "utf8")));
    const discovery = `http://${address.host}:${address.port}${DISCOVERY_PATH}`;
    await vi.waitFor(async () => expect(await (await fetch(discovery)).json()).toMatchObject({ readiness: "ready", harnessVersion: HARNESS_VERSION }), { timeout: 15_000 });
    await running.stop();
  });
});
