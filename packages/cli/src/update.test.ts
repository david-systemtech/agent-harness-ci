import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative as relativePath } from "node:path";
import { setImmediate } from "node:timers/promises";
import { ContractError, PROTOCOL_VERSION, UpdatesStatus, pastTimeWords, registry } from "@agent-harness/contracts";
import { HARNESS_VERSION, PRESET_IDLE_WINDOW_MS } from "@agent-harness/environment";
import { afterEach, describe, expect, it } from "vitest";
import { manualClock } from "../../environment/test/clock.js";
import { TEST_CLAUDE_CODE_VERSION, startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../environment/test/helper.js";
import { testLauncher } from "../../environment/test/launcher.js";
import { ARTEFACT, startFakeReleaseSource, type FakeReleaseSource } from "../../environment/test/release-source.js";
import { runCli, type CliContext } from "./cli.js";
import { UPDATE_APPLY_WAIT_MS, renderUpdatesStatus } from "./update.js";

/**
 * The `update` verbs that reach the local environment (launcher-update spec,
 * "Settings, methods, notices and flags": CLI verbs), against the in-process
 * environment: `update status` prints `updates.status` as text or JSON, and
 * `update settings` writes the update settings through
 * `updates.settings.set`, each through a local client session exchanged from
 * the bootstrap grant and revoked after, as `pair` does.
 */

let cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  cleanups.push(() => t.close());
  return t;
};

/** The CLI in-process, its output captured, `input` on its standard input. */
const harness = (input = "") => {
  let out = "";
  let err = "";
  const context: Partial<CliContext> = {
    stdout: (text) => void (out += text),
    stderr: (text) => void (err += text),
    stdin: async () => input,
    net: { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket },
  };
  return { context, out: () => out, err: () => err };
};

const run = async (args: readonly string[], input?: string) => {
  const cli = harness(input);
  const code = await runCli(args, cli.context);
  return { code, out: cli.out(), err: cli.err() };
};

/** A fake release source publishing `versions`, closed after the test. */
const releaseSource = async (...versions: string[]): Promise<FakeReleaseSource> => {
  const fake = await startFakeReleaseSource();
  cleanups.push(() => fake.forge.close());
  fake.publish(...versions.map((version) => ({ version })));
  return fake;
};

/** An environment whose fake release source publishes `versions`, with the forge account for its origin. */
const withReleases = async (...versions: string[]) => {
  const fake = await releaseSource(...versions);
  const t = await start({ releaseSource: fake.source, forgeFetch: fake.forge.fetch });
  const admin = await t.client();
  await fake.grantAccess(admin);
  await admin.close();
  return { fake, t };
};

/** The labels of the client sessions still live on `t`. */
const liveLabels = async (t: TestEnvironment): Promise<string[]> => {
  const admin = await t.client();
  const labels = (await admin.request("access.sessions.list", { live: true })).sessions.map((session) => session.label);
  await admin.close();
  return labels;
};

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

describe("agent-harness update status", () => {
  it("prints what runs here and that nothing manages its updates under a foreground serve, saying why", async () => {
    const t = await start({ harnessVersion: "0.4.1" });
    const { code, out, err } = await run(["update", "status", "--data-dir", t.dataDir]);
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toContain(`Version: agent-harness 0.4.1, protocol ${PROTOCOL_VERSION}`);
    expect(out).toContain(`Claude Code (bundled): ${TEST_CLAUDE_CODE_VERSION}`);
    expect(out).toMatch(/Updates: not managed: serve runs in the foreground/);
    expect(out).toContain("Pending update: none");
    expect(out).not.toContain("Installed:");
  });

  it("prints the launcher with its version and the versions installed, under a launcher", async () => {
    const launcher = testLauncher({
      present: true,
      versions: () => ({ type: "versions", installed: ["0.4.0", "0.4.1"], launcherVersion: "0.4.0", launcherProtocol: 1 }),
    });
    const t = await start({ harnessVersion: "0.4.1", launcher });
    const { code, out } = await run(["update", "status", "--data-dir", t.dataDir]);
    expect(code).toBe(0);
    expect(out).toContain("Updates: managed by its launcher, version 0.4.0");
    expect(out).toContain("Installed: 0.4.0, 0.4.1");
  });

  it("prints the document updates.status answers as JSON with --json", async () => {
    const t = await start({ containerDetector: { inContainer: () => true } });
    const { code, out } = await run(["update", "status", "--json", "--data-dir", t.dataDir]);
    expect(code).toBe(0);
    const printed = UpdatesStatus.parse(JSON.parse(out));
    const admin = await t.client();
    expect(printed).toEqual(await admin.request("updates.status", {}));
    expect(printed).toMatchObject({ version: HARNESS_VERSION, manager: { kind: "outside", lastPoll: null } });
  });

  it("with --host-updater is the host-side updater's poll, which the environment remembers as the manager's last poll (#348)", async () => {
    const t = await start({ containerDetector: { inContainer: () => true } });
    const { code, out, err } = await run(["update", "status", "--json", "--host-updater", "--data-dir", t.dataDir]);
    expect(err).toBe("");
    expect(code).toBe(0);
    const polled = t.clock.now().toISOString();
    expect(UpdatesStatus.parse(JSON.parse(out)).manager).toEqual({ kind: "outside", lastPoll: polled });
    const admin = await t.client();
    expect((await admin.request("updates.status", {})).manager).toEqual({ kind: "outside", lastPoll: polled });
    await admin.close();
    expect(await liveLabels(t)).not.toContain("agent-harness update status");
  });

  it("revokes its own local client session before it exits", async () => {
    const t = await start();
    expect((await run(["update", "status", "--data-dir", t.dataDir])).code).toBe(0);
    const admin = await t.client();
    const own = (await admin.request("access.sessions.list", {})).sessions.filter((session) => session.label === "agent-harness update status");
    expect(own).toHaveLength(1);
    expect(own[0]?.revokedAt).not.toBeNull();
    expect(await liveLabels(t)).not.toContain("agent-harness update status");
  });

  it("before the first check since the start, says when the channel was last read, kept in the data directory, and that the read is due, never that there was no check (#1812)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-harness-cli-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dataDir = join(dir, "data");
    mkdirSync(dataDir);
    // Twelve minutes before this start, as the last start's environment kept it.
    const lastRead = "2026-09-23T23:48:00.000Z";
    writeFileSync(join(dataDir, "release-channel.json"), `${JSON.stringify({ lastSucceededAt: lastRead })}\n`);
    const fake = await releaseSource("0.5.0");
    const t = await start({ harnessVersion: "0.4.1", dataDir, releaseSource: fake.source, forgeFetch: fake.forge.fetch });
    const admin = await t.client();
    await fake.grantAccess(admin);

    const before = await run(["update", "status", "--data-dir", t.dataDir]);
    expect(before.code).toBe(0);
    expect(before.out).toContain(`Channel's newest: due, not read since the environment started; last read at ${lastRead}\n`);
    expect(before.out).toContain(`Last check: none since the environment started, the first due two minutes after it; the channel was last read at ${lastRead}\n`);
    expect(before.out).not.toMatch(/not read yet|Last check: never/);

    t.clock.advance(2 * 60_000);
    const firstCheck = t.clock.now().toISOString();
    await expect.poll(async () => (await admin.request("updates.status", {})).lastCheck, { timeout: 10_000 }).toEqual({ at: firstCheck, result: "ok" });
    const after = await run(["update", "status", "--data-dir", t.dataDir]);
    expect(after.out).toContain("Channel's newest: 0.5.0\n");
    expect(after.out).toContain(`Last check: ${firstCheck}, ok\n`);
    expect((await admin.request("updates.status", {})).lastReadAt).toBe(firstCheck);
    await admin.close();
  });
});

describe("agent-harness update settings", () => {
  it("sets any of the five update settings from flags through updates.settings.set, and prints all five", async () => {
    const { t } = await withReleases("0.4.2");
    const { code, out, err } = await run([
      "update",
      "settings",
      "--auto-update",
      "off",
      "--channel",
      "beta",
      "--pinned-version",
      "0.4.2",
      "--idle-window-minutes",
      "25",
      "--deferral-cap-hours",
      "48",
      "--data-dir",
      t.dataDir,
    ]);
    expect(err).toBe("");
    expect(code).toBe(0);
    const expected = {
      "updates.autoUpdate": false,
      "updates.channel": "beta",
      "updates.pinnedVersion": "0.4.2",
      "updates.idleWindowMinutes": 25,
      "updates.deferralCapHours": 48,
    };
    const admin = await t.client();
    expect((await admin.request("settings.get", { keys: Object.keys(expected) as never })).values).toEqual(expected);
    expect(out).toContain("Auto-update: off");
    expect(out).toContain("Channel: beta");
    expect(out).toContain("Pinned version: 0.4.2");
    expect(out).toContain("Idle window: 25 minutes");
    expect(out).toContain("Deferral cap: 48 hours");
    const [updated] = t.env.log.readStream({ kinds: ["settings"] });
    expect(updated).toMatchObject({ type: "settings.updated", payload: { values: expected } });
  });

  it("says why a pin was refused and exits 1, setting nothing", async () => {
    const { fake, t } = await withReleases("0.4.2");
    fake.absent("0.9.9");
    const { code, out, err } = await run(["update", "settings", "--pinned-version", "0.9.9", "--channel", "beta", "--data-dir", t.dataDir]);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe("The environment refused the update settings: 0.9.9 cannot be pinned: No release 0.9.9 is published, or it is a draft.\n");
    expect(t.env.log.readStream({ kinds: ["settings"] })).toEqual([]);
  });

  it("sets one key alone, leaving the others as they were, and clears a pin with none", async () => {
    const { t } = await withReleases("0.4.2");
    expect((await run(["update", "settings", "--pinned-version", "0.4.2", "--data-dir", t.dataDir])).code).toBe(0);
    const { code, out } = await run(["update", "settings", "--pinned-version", "none", "--data-dir", t.dataDir]);
    expect(code).toBe(0);
    expect(out).toContain("Pinned version: none");
    expect(out).toContain("Channel: stable");
    const admin = await t.client();
    expect((await admin.request("settings.get", { keys: ["updates.pinnedVersion", "updates.autoUpdate"] })).values).toEqual({
      "updates.pinnedVersion": null,
      "updates.autoUpdate": true,
    });
  });

  it("revokes its own local client session before it exits", async () => {
    const t = await start();
    expect((await run(["update", "settings", "--channel", "beta", "--data-dir", t.dataDir])).code).toBe(0);
    expect(await liveLabels(t)).not.toContain("agent-harness update settings");
  });

  it("prints its usage and exits 2, setting nothing, on a value a key does not take, an unknown flag, or no flag", async () => {
    for (const args of [
      ["--auto-update", "maybe"],
      ["--channel", "nightly"],
      ["--pinned-version", "v0.4.2"],
      ["--idle-window-minutes", "0"],
      ["--idle-window-minutes", "121"],
      ["--idle-window-minutes", "2.5"],
      ["--deferral-cap-hours", "169"],
      ["--deferral-cap-hours", "a day"],
      ["--drain-cap", "30"],
      [],
    ]) {
      const { code, err } = await run(["update", "settings", ...args, "--data-dir", "/nonexistent/agent-harness"]);
      expect(code, args.join(" ")).toBe(2);
      expect(err, args.join(" ")).toContain("agent-harness update settings");
    }
  });
});

describe("agent-harness update apply", () => {
  /** A server artefact of `version`: a gzipped tar with `bin/agent-harness` and a file naming the version at its top. */
  const artefact = (version: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "agent-harness-artefact-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "root", "bin"), { recursive: true });
    writeFileSync(join(dir, "root", "bin", "agent-harness"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(dir, "root", "VERSION"), `${version}\n`);
    execFileSync("tar", ["-czf", join(dir, "artefact.tar.gz"), "-C", join(dir, "root"), "."]);
    return join(dir, "artefact.tar.gz");
  };

  const pendingOf = async (t: TestEnvironment) => {
    const admin = await t.client();
    const { pending } = await admin.request("updates.status", {});
    await admin.close();
    return pending;
  };

  it("downloads and installs the native artefact from the public GitHub release anonymously", async () => {
    const fake = await startFakeReleaseSource("github");
    cleanups.push(() => fake.forge.close());
    fake.publish({ version: "0.5.0", artefact: readFileSync(artefact("0.5.0")) });
    let installed: string | undefined;
    const t = await start({ harnessVersion: "0.4.1", releaseSource: fake.source, forgeFetch: fake.forge.fetch,
      launcher: testLauncher({ present: true, install: (request) => ((installed = request.version), { type: "installed" }) }),
    });
    const result = await run(["update", "apply", "--version", "0.5.0", "--data-dir", t.dataDir]);
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    expect(installed).toBe("0.5.0");
    expect(fake.reads()).toEqual([
      { method: "GET", path: "/api/v3/repos/david-systemtech/agent-harness/releases", query: "per_page=50", scheme: null },
      { method: "GET", path: "/api/v3/repos/david-systemtech/agent-harness/releases/assets/100", scheme: null },
      { method: "GET", path: "/api/v3/repos/david-systemtech/agent-harness/releases/assets/101", scheme: null },
    ]);
  });

  it("takes a version and the path of its artefact, which the environment stages and its launcher installs, and says the update waits for idle", async () => {
    let staged: string | undefined;
    const t = await start({ harnessVersion: "0.4.1", launcher: testLauncher({ present: true, install: (request) => ((staged = request.staged), { type: "installed" }) }) });
    t.runs.start("r1");
    t.runs.running("r1");
    const path = artefact("0.5.0");
    // A relative path is the working directory's, not the environment's.
    const relative = relativePath(process.cwd(), path);

    const { code, out, err } = await run(["update", "apply", "--version", "0.5.0", "--path", relative, "--data-dir", t.dataDir]);

    expect(err).toBe("");
    expect(code).toBe(0);
    const pending = await pendingOf(t);
    expect(pending).toMatchObject({ state: "waiting", toVersion: "0.5.0", source: "request" });
    expect(staged).toBe(join(t.dataDir, "staging", "0.5.0"));
    expect(out).toBe(`Updating to 0.5.0 (update ${pending.state === "waiting" ? pending.updateId : ""}) once the environment is idle, or at its deferral cap; update status says what it waits on.\n`);
    expect(await liveLabels(t)).not.toContain("agent-harness update apply");
  });

  it("with --now drains the environment at once, and exits 0 when the environment goes away updating before its client session's revoke is answered", async () => {
    const t = await start({ harnessVersion: "0.4.1", launcher: testLauncher({ present: true }) });
    // The revoke comes after the drain has closed the wire: the environment has gone to update.
    t.env.methods.register(registry["access.sessions.revoke"], {
      prepare: () => {
        t.clock.advance(0);
        return new Promise<never>(() => undefined);
      },
    } as never);

    const { code, out, err } = await run(["update", "apply", "--version", "0.5.0", "--path", artefact("0.5.0"), "--now", "--data-dir", t.dataDir]);

    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toMatch(/^Updating to 0\.5\.0 \(update [0-9a-f-]{36}\) now: the environment is draining\.\n$/);
    expect(await t.env.drained).toMatchObject({ trigger: "update" });
    expect(t.launcher.received).toContainEqual(expect.objectContaining({ type: "switch?", version: "0.5.0" }));
  });

  it("with --now alone drains for the update that waits", async () => {
    const t = await start({ harnessVersion: "0.4.1", launcher: testLauncher({ present: true }) });
    t.runs.start("r1");
    t.runs.running("r1");
    expect((await run(["update", "apply", "--version", "0.5.0", "--path", artefact("0.5.0"), "--data-dir", t.dataDir])).code).toBe(0);
    const { code, out } = await run(["update", "apply", "--now", "--data-dir", t.dataDir]);
    expect(code).toBe(0);
    expect(out).toContain("now: the environment is draining");
    expect(t.env.readiness()).toBe("draining");
  });

  it("takes a version alone, which the environment downloads from its release through the forge account, stages and installs as any update (#347)", async () => {
    const fake = await startFakeReleaseSource();
    cleanups.push(() => fake.forge.close());
    fake.publish({ version: "0.5.0", artefact: readFileSync(artefact("0.5.0")) });
    fake.absent("0.9.9");
    const t = await start({ harnessVersion: "0.4.1", launcher: testLauncher({ present: true }), releaseSource: fake.source, forgeFetch: fake.forge.fetch });
    const admin = await t.client();
    await fake.grantAccess(admin);
    await admin.close();
    t.runs.start("r1");
    t.runs.running("r1");

    const { code, out, err } = await run(["update", "apply", "--version", "0.5.0", "--data-dir", t.dataDir]);

    expect(err).toBe("");
    expect(code).toBe(0);
    const pending = await pendingOf(t);
    expect(pending).toMatchObject({ state: "waiting", toVersion: "0.5.0", source: "request" });
    expect(out).toContain(`Updating to 0.5.0 (update ${pending.state === "waiting" ? pending.updateId : ""}) once the environment is idle`);
    expect(fake.reads().map((request) => request.path)).toContain(`/david/agent-harness/releases/download/v0.5.0/${ARTEFACT}`);

    const missing = await run(["update", "apply", "--version", "0.9.9", "--data-dir", t.dataDir]);
    expect(missing.code).toBe(1);
    expect(missing.err).toBe("The environment refused the update: Cannot update to 0.9.9: No release 0.9.9 is published, or it is a draft.\n");
  });

  it("says what the environment refused and exits 1", async () => {
    const t = await start({ harnessVersion: "0.4.1", launcher: testLauncher({ present: true, install: () => ({ type: "refused", reason: "preflight" }) }) });
    const { code, out, err } = await run(["update", "apply", "--version", "0.5.0", "--path", artefact("0.5.0"), "--data-dir", t.dataDir]);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe("The environment refused the update: The launcher refused to install 0.5.0: preflight.\n");
  });

  it("prints its usage and exits 2 on a version that is not a release's, a path without its version, or a stray argument", async () => {
    for (const args of [["--version", "v0.5.0"], ["--path", "/tmp/a.tar.gz"], ["--now", "yes"], ["--later"]]) {
      const { code, err } = await run(["update", "apply", ...args, "--data-dir", "/nonexistent/agent-harness"]);
      expect(code, args.join(" ")).toBe(2);
      expect(err, args.join(" ")).toContain("agent-harness update apply");
    }
  });

  it("waits on the environment's staging and install past the route's 10 seconds, and fails as unanswered only past its own wait", async () => {
    const t = await start({ harnessVersion: "0.4.1", launcher: testLauncher({ present: true }) });
    const clock = manualClock();
    let asked!: () => void;
    const applying = new Promise<void>((resolve) => (asked = resolve));
    // The environment answers once the update is staged and installed, and says nothing meanwhile.
    t.env.methods.register(registry["updates.apply"], {
      prepare: () => {
        asked();
        return new Promise<never>(() => undefined);
      },
    } as never);
    const cli = harness();
    let settled = false;
    const verb = runCli(["update", "apply", "--version", "0.5.0", "--path", artefact("0.5.0"), "--now", "--data-dir", t.dataDir], { ...cli.context, clock }).finally(() => (settled = true));
    await applying;

    clock.advance(10_000);
    await setImmediate();
    expect(settled).toBe(false);
    clock.advance(UPDATE_APPLY_WAIT_MS - 10_001);
    await setImmediate();
    expect(settled).toBe(false);
    clock.advance(1);

    expect(await verb).toBe(1);
    expect(cli.err()).toMatch(`did not answer within ${UPDATE_APPLY_WAIT_MS / 1000} seconds`);
  });
});

describe("updates from public GitHub releases", () => {
  it("prints the release source and requests its version without a forge account", async () => {
    const fake = await startFakeReleaseSource("github");
    cleanups.push(() => fake.forge.close());
    fake.publish({ version: "0.5.0" });
    const t = await start({ harnessVersion: "0.4.1", containerDetector: { inContainer: () => true }, releaseSource: fake.source, forgeFetch: fake.forge.fetch });
    const status = await run(["update", "status", "--data-dir", t.dataDir]);
    expect(status.code).toBe(0);
    expect(status.out).toContain("Releases: https://github.com/david-systemtech/agent-harness\n");
    const applied = await run(["update", "apply", "--version", "0.5.0", "--data-dir", t.dataDir]);
    expect(applied.code).toBe(0);
    expect(applied.err).toBe("");
    expect(applied.out).toContain("Updating to 0.5.0");
    expect(fake.reads().every((request) => request.scheme === null)).toBe(true);
    expect(fake.reads().some((request) => request.path.includes("/api/v3/repos/david-systemtech/agent-harness/releases"))).toBe(true);
  });
});

describe("agent-harness update begin", () => {
  /** A container whose check made the update to 0.5.0 pending, ready as it is idle: with the update's id. */
  const readyContainer = async () => {
    const fake = await releaseSource("0.5.0");
    const t = await start({ harnessVersion: "0.4.1", containerDetector: { inContainer: () => true }, releaseSource: fake.source, forgeFetch: fake.forge.fetch });
    const admin = await t.client();
    await fake.grantAccess(admin);
    await admin.request("updates.check", {});
    // Past the idle window its start holds (#445), it is idle and the update ready.
    t.clock.advance(PRESET_IDLE_WINDOW_MS);
    const { pending } = await admin.request("updates.status", {});
    await admin.close();
    if (pending.state !== "ready") throw new Error(`The update is not ready: ${JSON.stringify(pending)}`);
    return { t, updateId: pending.updateId };
  };

  it("begins the ready update the host-side updater names, through updates.begin, and says the environment drains until the container stops (#348)", async () => {
    const { t, updateId } = await readyContainer();

    const { code, out, err } = await run(["update", "begin", "--update-id", updateId, "--data-dir", t.dataDir]);

    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toBe(`Began the update to 0.5.0 (update ${updateId}): the environment is draining, and ends once the container is stopped.\n`);
    expect(t.env.readiness()).toBe("draining");
    const started = t.env.log.readStream({ kinds: ["environment"] }).filter((event) => event.type === "environment.update-started");
    expect(started.map((event) => event.payload)).toEqual([{ updateId, fromVersion: "0.4.1", toVersion: "0.5.0", cause: "idle" }]);
    expect(await liveLabels(t)).not.toContain("agent-harness update begin");
  });

  it("says what the environment refused and exits 1: an update that is not the ready one", async () => {
    const { t } = await readyContainer();
    const other = "0b5c4f8e-9a51-4d2c-8e3f-6a7b8c9d0e1f";
    const { code, out, err } = await run(["update", "begin", "--update-id", other, "--data-dir", t.dataDir]);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toMatch(/^The environment refused to begin the update: 0b5c4f8e-9a51-4d2c-8e3f-6a7b8c9d0e1f is not the pending update/);
    expect(t.env.readiness()).toBe("ready");
  });

  it("prints its usage and exits 2 without an update id, or with one that is not an update's", async () => {
    for (const args of [[], ["--update-id", "u-1"], ["--update-id", "0b5c4f8e-9a51-4d2c-8e3f-6a7b8c9d0e1f", "--now"]]) {
      const { code, err } = await run(["update", "begin", ...args, "--data-dir", "/nonexistent/agent-harness"]);
      expect(code, args.join(" ")).toBe(2);
      expect(err, args.join(" ")).toContain("agent-harness update begin");
    }
  });
});

describe("the status as update status prints it", () => {
  const updateId = "7d0f2b1e-2c55-4a8e-9f0b-3a1c5d7e9b20";
  const at = "2026-09-28T10:00:00.000Z";
  const later = "2026-09-29T10:00:00.000Z";
  /** When the CLI prints it: two hours and five minutes after the host-side updater's last poll. */
  const now = new Date(Date.parse(at) + (2 * 60 + 5) * 60_000);
  const base: UpdatesStatus = {
    version: "0.4.2",
    protocolVersion: 1,
    bundledClaudeCodeVersion: null,
    manager: { kind: "outside", lastPoll: at },
    releaseSource: { origin: "https://github.com", kind: "github", repository: "david-systemtech/agent-harness" },
    newest: "0.5.0",
    lastCheck: { at, result: "failed", reason: "unreachable", message: "The forge did not answer." },
    lastReadAt: null,
    target: { version: "0.5.0", source: "channel" },
    passedOver: null,
    pending: { state: "current" },
    lastOutcome: { outcome: "failed", updateId, fromVersion: "0.4.2", toVersion: "0.5.0", at, stage: "trial", reason: "deadline", rolledBack: true },
    failedVersions: ["0.5.0"],
    installed: [],
  };
  const pending = { updateId, toVersion: "0.5.1", source: "channel", since: at, deferUntil: later, image: null } as const;

  it("says each part the document can carry, the channel, pending and outcome parts later tickets fill included", () => {
    expect(renderUpdatesStatus(base, now).split("\n")).toEqual([
      "Version: agent-harness 0.4.2, protocol 1",
      "Claude Code (bundled): unknown",
      `Updates: managed outside, by a host-side updater; last polled ${pastTimeWords(at, now)}`,
      "Releases: https://github.com/david-systemtech/agent-harness",
      "Channel's newest: 0.5.0",
      `Last check: ${at}, failed (unreachable): The forge did not answer.`,
      "Target: 0.5.0 (channel)",
      "Pending update: none",
      `Last update: 0.4.2 to 0.5.0, failed at ${at} (trial: deadline), rolled back`,
      "Failed versions: 0.5.0",
      "",
    ]);
    // The poll's time where the CLI runs, its age and its clock time, as the clients word it (#1742).
    expect(renderUpdatesStatus(base, now)).toMatch(/\nUpdates: managed outside, by a host-side updater; last polled 2 h ago, at [^\n]*\d\d:\d\d\n/);
    expect(renderUpdatesStatus(base, now)).not.toContain(`last polled at ${at}`);
    const lines: [UpdatesStatus["pending"], string][] = [
      [{ state: "staging", updateId, toVersion: "0.5.1", source: "request" }, "0.5.1 (request), staging"],
      [{ state: "waiting", ...pending, waitsOn: { reason: "parked-prompt", until: later } }, `0.5.1 (channel), waiting since ${at}, forced at ${later}; busy: parked-prompt until ${later}`],
      [{ state: "waiting", ...pending, waitsOn: { reason: "run-running", until: null } }, `0.5.1 (channel), waiting since ${at}, forced at ${later}; busy: run-running`],
      [{ state: "ready", ...pending }, `0.5.1 (channel), ready for the host-side updater since ${at}`],
      [{ state: "draining", ...pending, cause: "cap" }, "0.5.1 (channel), draining (cap)"],
      [
        { state: "blocked", reason: "launcher", toVersion: "0.9.0", message: "Run agent-harness service install from the 0.9.0 release." },
        "0.9.0, blocked (launcher): Run agent-harness service install from the 0.9.0 release.",
      ],
    ];
    for (const [state, line] of lines) expect(renderUpdatesStatus({ ...base, pending: state }, now)).toContain(`Pending update: ${line}\n`);
    expect(renderUpdatesStatus({ ...base, lastOutcome: { outcome: "updated", updateId: null, fromVersion: "0.4.1", toVersion: "0.4.2", at } }, now)).toContain(
      `Last update: 0.4.1 to 0.4.2, updated at ${at}\n`,
    );
    expect(renderUpdatesStatus({ ...base, manager: { kind: "outside", lastPoll: null }, lastCheck: null, newest: null, target: null }, now)).toMatch(
      /Updates: managed outside, by a host-side updater; it has not polled yet\nReleases: .*\nChannel's newest: not read yet\nLast check: never\nTarget: none\n/,
    );
    // A read kept from before the start, and no check since (#1812).
    expect(renderUpdatesStatus({ ...base, lastCheck: null, newest: null, target: null, lastReadAt: later }, now)).toContain(
      `Channel's newest: due, not read since the environment started; last read at ${later}\nLast check: none since the environment started, the first due two minutes after it; the channel was last read at ${later}\n`,
    );
    // An environment that predates the last read answers without it, as one before any read.
    const predating = UpdatesStatus.parse(JSON.parse(JSON.stringify({ ...base, lastCheck: null, newest: null, target: null, lastReadAt: undefined })));
    expect(renderUpdatesStatus(predating, now)).toContain("Channel's newest: not read yet\nLast check: never\n");
    // The first check since the start read the channel and is staging what it found: under way, never "none since" (#1812).
    const staging = renderUpdatesStatus({ ...base, lastCheck: null, newest: "0.5.0", lastReadAt: later }, now);
    expect(staging).toContain(`Channel's newest: 0.5.0\nLast check: under way, the first since the environment started; it read the channel at ${later}\n`);
    expect(staging).not.toContain("none since");
    // The first check since failed: the read is still due, and the last check is that one.
    expect(renderUpdatesStatus({ ...base, newest: null, target: null, lastReadAt: later }, now)).toContain(
      `Channel's newest: due, not read since the environment started; last read at ${later}\nLast check: ${at}, failed (unreachable): The forge did not answer.\n`,
    );
    expect(renderUpdatesStatus({ ...base, target: null, passedOver: { version: "0.3.0", source: "pin", reason: "schema", message: "Its schema is below the database's." } }, now)).toContain(
      "Target: none\nPassed over: 0.3.0 (pin, schema): Its schema is below the database's.\nPending update: none\n",
    );
  });
});

describe("agent-harness update credential", () => {
  /** A token the fake forge answers as David; nothing a secret scanner takes for a real one. */
  const RELEASE_TOKEN = "release-token-for-tests";

  it("reads the token from standard input and adds it as the forge account for the release origin through the forge's add method, never printing it", async () => {
    const fake = await releaseSource("0.5.0");
    fake.forge.user(RELEASE_TOKEN, { login: "david", id: 42 });
    fake.forge.answer(RELEASE_TOKEN, "GET /api/v1/repos/david/agent-harness/releases", { status: 200, body: [] });
    const t = await start({ releaseSource: fake.source, forgeFetch: fake.forge.fetch });

    const { code, out, err } = await run(["update", "credential", "--stdin", "--data-dir", t.dataDir], `${RELEASE_TOKEN}\n`);

    expect(err).toBe("");
    expect(code).toBe(0);
    const admin = await t.client();
    const { accounts } = await admin.request("forge.accounts.list", {});
    expect(accounts).toEqual([expect.objectContaining({ origin: fake.source.origin, kind: "forgejo", credential: expect.objectContaining({ kind: "stored", provenance: "pasted" }) as unknown })]);
    expect(out).toBe(`Added the forge account ${accounts[0]?.slug ?? ""} for ${fake.source.origin}, where its releases are published: the environment reads its releases with it.\n`);
    expect(`${out}${err}`).not.toContain(RELEASE_TOKEN);
    // The identity call heard the token before anything was stored.
    expect(fake.forge.requests).toContainEqual({ method: "GET", path: "/api/v1/user", scheme: "token" });
    expect((await admin.request("updates.check", {})).lastCheck).toMatchObject({ result: "ok" });
    expect(await liveLabels(t)).not.toContain("agent-harness update credential");
  });

  it("says so and uses nothing when a forge account covers the release origin already", async () => {
    const { fake, t } = await withReleases("0.5.0");
    const before = fake.forge.requests.length;
    const { code, out, err } = await run(["update", "credential", "--stdin", "--data-dir", t.dataDir], RELEASE_TOKEN);
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toMatch(new RegExp(`^The forge account \\S+ already covers ${fake.source.origin.replace(/[.]/g, "\\.")}, where its releases are published; the token was not used\\.`));
    expect(out).not.toContain(RELEASE_TOKEN);
    expect(fake.forge.requests.length).toBe(before);
    const admin = await t.client();
    expect((await admin.request("forge.accounts.list", {})).accounts).toHaveLength(1);
  });

  it("says what the environment refused and exits 1 when the forge refuses the token, storing nothing and never printing it", async () => {
    const fake = await releaseSource("0.5.0");
    const t = await start({ releaseSource: fake.source, forgeFetch: fake.forge.fetch });
    const { code, out, err } = await run(["update", "credential", "--stdin", "--data-dir", t.dataDir], RELEASE_TOKEN);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toMatch(/^The environment refused the token: /);
    expect(err).not.toContain(RELEASE_TOKEN);
    const admin = await t.client();
    expect((await admin.request("forge.accounts.list", {})).accounts).toEqual([]);
  });

  it("takes the token from standard input only: without --stdin it prints its usage and exits 2, and with nothing piped in it says so and exits 1", async () => {
    const t = await start();
    for (const args of [[], ["--token", RELEASE_TOKEN], [RELEASE_TOKEN]]) {
      const { code, err } = await run(["update", "credential", ...args, "--data-dir", t.dataDir], RELEASE_TOKEN);
      expect(code, args.join(" ")).toBe(2);
      expect(err, args.join(" ")).toContain("agent-harness update credential --stdin");
      expect(err, args.join(" ")).not.toContain(RELEASE_TOKEN);
    }
    const empty = await run(["update", "credential", "--stdin", "--data-dir", t.dataDir], "  \n");
    expect(empty).toMatchObject({ code: 1, out: "", err: "No token came on standard input: pipe the release token in.\n" });
  });
});

describe("the update verbs", () => {
  it("say plainly and exit 1 when no environment runs on the data directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-harness-cli-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    for (const args of [["status"], ["status", "--json"], ["settings", "--channel", "beta"], ["apply", "--now"]]) {
      const { code, out, err } = await run(["update", ...args, "--data-dir", dir]);
      expect(code, args.join(" ")).toBe(1);
      expect(err, args.join(" ")).toMatch(/No environment is running on/);
      expect(out, args.join(" ")).toBe("");
    }
  });

  it("say what the environment refused and exit 1, and still revoke their local client session", async () => {
    const t = await start();
    t.env.methods.register(registry["updates.status"], () => {
      throw new ContractError({ code: "unavailable", message: "The environment is draining.", data: { readiness: "draining" } });
    });
    const { code, out, err } = await run(["update", "status", "--data-dir", t.dataDir]);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe("The environment refused updates.status: The environment is draining.\n");
    expect(await liveLabels(t)).not.toContain("agent-harness update status");
  });

  it("say plainly and exit 1 when the environment does not answer on the port", async () => {
    const t = await start();
    const port = await freePort();
    const { code, err } = await run(["update", "status", "--data-dir", t.dataDir, "--port", String(port)]);
    expect(code).toBe(1);
    expect(err).toMatch(/did not answer/);
  });

  it("other than apply, keep the route's 10 seconds for an unanswered call", async () => {
    const t = await start();
    // credential's first call is updates.status, which it reads the release source from.
    for (const [method, args] of [
      ["updates.status", ["status"]],
      ["updates.settings.set", ["settings", "--channel", "beta"]],
      ["updates.status", ["credential", "--stdin"]],
      ["updates.begin", ["begin", "--update-id", "11111111-1111-4111-8111-111111111111"]],
    ] as const) {
      const clock = manualClock();
      let asked!: () => void;
      const calling = new Promise<void>((resolve) => (asked = resolve));
      const silent = () => {
        asked();
        return new Promise<never>(() => undefined);
      };
      // A command is silent while it prepares; a query, in its handler.
      if (method === "updates.status") t.env.methods.register(registry[method], silent);
      else t.env.methods.register(registry[method], { prepare: silent } as never);
      const cli = harness("token-for-tests\n");
      const verb = runCli(["update", ...args, "--data-dir", t.dataDir], { ...cli.context, clock });
      await calling;
      clock.advance(10_000);
      expect(await verb, args[0]).toBe(1);
      expect(cli.err(), args[0]).toMatch("did not answer within 10 seconds");
    }
  });

  it("print the usage and exit 2 on a verb they do not know, or none", async () => {
    for (const args of [["update"], ["update", "now"], ["update", "status", "extra"]]) {
      const { code, err } = await run(args);
      expect(code, args.join(" ")).toBe(2);
      expect(err, args.join(" ")).toContain("agent-harness update status [--json]");
    }
  });
});
