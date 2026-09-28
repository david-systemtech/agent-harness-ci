import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOOTSTRAP_GRANT_FILE, BootstrapGrant, DISCOVERY_PATH } from "@agent-harness/contracts";
import { LAUNCHER_PROTOCOL } from "@agent-harness/contracts/launcher";
import { HARNESS_VERSION } from "@agent-harness/environment";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  childReport,
  databaseFilesIn,
  fakeTimer,
  installVersion,
  readDatabase,
  scriptChild,
  until,
  writeDatabase,
  type ChildEvent,
  type ChildStart,
  type FakeTimer,
  type ScriptedStart,
} from "../../test/launcher-fixtures.js";
import { LAUNCHER_VERSION, startLauncher, type Launcher, type TrialFailure } from "./launcher.js";
import { hasSnapshot, RESTORE_MARKER_FILE, snapshotDirectory, takeSnapshot } from "./snapshot.js";
import { readServiceState, SERVICE_STATE_FILE, writeServiceState, type ServiceState } from "./state.js";

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
});

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
}

/**
 * A launcher on `dataDir` (preset: a fresh one with 0.5.0 installed and
 * active), logging to memory, on a fake timer, finding `freeBytes` free on
 * the disk (preset: a terabyte).
 */
const launch = (options: { dataDir?: string; port?: number; freeBytes?: (dataDir: string) => number } = {}): Running => {
  const dataDir = options.dataDir ?? dataDirectory();
  if (options.dataDir === undefined) {
    installVersion(dataDir, "0.5.0");
    writeServiceState(dataDir, state("0.5.0"));
  }
  const timer = fakeTimer();
  const lines: string[] = [];
  const launcher = startLauncher({ dataDir, port: options.port, log: (line) => lines.push(line), timer, freeBytes: options.freeBytes ?? (() => 2 ** 40) });
  cleanups.push(async () => {
    await launcher.stop();
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
      launcherVersion: LAUNCHER_VERSION,
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

/** The service state in `dataDir` now. */
const stateIn = (dataDir: string): ServiceState | undefined => {
  const read = readServiceState(dataDir);
  return "state" in read ? read.state : undefined;
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
    // The trial's deadline went with its commit.
    expect(running.timer.pending()).toEqual([]);
    expect(heardBy(running, 1)).toContain("committed");
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
    await running.launcher.stop();
    await until("serve's exit is logged", () => running.log().at(-1) === `launcher: ${HARNESS_VERSION} exited with code 0`);
    expect(running.log().slice(1)).toEqual([
      `launcher: ${HARNESS_VERSION} committed`,
      `launcher: stopping: draining ${HARNESS_VERSION}`,
      `launcher: ${HARNESS_VERSION} exited with code 0`,
    ]);
    await expect(fetch(discovery)).rejects.toThrow();
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
    await running.launcher.stop();
  });
});
