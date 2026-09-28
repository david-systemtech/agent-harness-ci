import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOOTSTRAP_GRANT_FILE, BootstrapGrant, DISCOVERY_PATH } from "@agent-harness/contracts";
import { LAUNCHER_PROTOCOL } from "@agent-harness/contracts/launcher";
import { HARNESS_VERSION } from "@agent-harness/environment";
import { afterEach, describe, expect, it, vi } from "vitest";
import { childReport, fakeTimer, installVersion, scriptChild, until, type ChildEvent, type FakeTimer } from "../../test/launcher-fixtures.js";
import { LAUNCHER_VERSION, startLauncher, type Launcher } from "./launcher.js";
import { SERVICE_STATE_FILE, writeServiceState, type ServiceState } from "./state.js";

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

/** A launcher on `dataDir` (preset: a fresh one with 0.5.0 installed and active), logging to memory, on a fake timer. */
const launch = (options: { dataDir?: string; port?: number } = {}): Running => {
  const dataDir = options.dataDir ?? dataDirectory();
  if (options.dataDir === undefined) {
    installVersion(dataDir, "0.5.0");
    writeServiceState(dataDir, state("0.5.0"));
  }
  const timer = fakeTimer();
  const lines: string[] = [];
  const launcher = startLauncher({ dataDir, port: options.port, log: (line) => lines.push(line), timer });
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
});
