import type { SettingsValues } from "@agent-harness/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { DESKTOP_UNREAD_RECHECK_MS } from "./desktop-update.js";
import { createRuntime } from "./runtime.js";
import type { Shell, ShellStagedBuild } from "./shell.js";
import { flush } from "./testing/fake-wire.js";
import { fakeShell, inMemoryPlatform, manualClock, type FakeShell } from "./testing/in-memory-platform.js";
import { scriptedWorld, type EnvironmentHandle, type ScriptedEnvironment, type ScriptedUpdates } from "./testing/scripted-environment.js";
import { desktopBuildWords } from "./updates/words.js";

/**
 * The desktop's update flow in the client runtime (launcher-update spec,
 * "The desktop moves with its local environment"; #354), against the
 * scripted environment as the local one and the recording fake shell: the
 * desktop's build checked at launch and hourly through the local
 * environment, a newer one staged there and applied through the shell's
 * `update`, and the server artefact the desktop carries handed to that
 * environment.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The build the desktop runs in these tests. */
const RUNNING = "0.5.0";

/** A build of 0.6.0 as the local environment stages it. */
const STAGED: ShellStagedBuild = { path: "/home/milo/.local/state/agent-harness/desktop/0.6.0/agent-harness-0.6.0.pacman", version: "0.6.0", sha256: "a".repeat(64) };

/** Where the bundled server lies in an installed desktop. */
const BUNDLED_PATH = "/opt/agent-harness/resources/server/agent-harness-linux-x64.tar.gz";

interface LaunchOptions {
  readonly updates?: ScriptedUpdates;
  readonly settings?: Partial<SettingsValues>;
  readonly receipts?: ScriptedEnvironment["receipts"];
  /** Scripts the fake shell before the runtime starts. */
  readonly shell?: (shell: FakeShell) => void;
  /** Takes members off the shell the platform is given. */
  readonly without?: readonly (keyof Shell)[];
  /** Scripts the environment further before the runtime starts. */
  readonly desk?: (desk: EnvironmentHandle) => void;
}

/** A desktop runtime over the scripted local environment `desk`, started, its shell running RUNNING as an Arch package. */
const launch = async (options: LaunchOptions = {}) => {
  const clock = manualClock();
  const world = scriptedWorld(clock, {
    environments: [
      {
        name: "desk",
        reach: "local",
        ...(options.updates && { updates: options.updates }),
        ...(options.settings && { settings: options.settings }),
        ...(options.receipts && { receipts: options.receipts }),
      },
    ],
  });
  options.desk?.(world.environment("desk"));
  const shell = fakeShell();
  shell.answer("update.current", async () => ({ version: RUNNING, platform: "linux", arch: "x64", format: "pacman" }));
  options.shell?.(shell);
  const given: Shell = Object.fromEntries(Object.entries(shell).filter(([member]) => !(options.without ?? []).includes(member as keyof Shell)));
  const platform = inMemoryPlatform({ clock, kind: "desktop", fetch: world.fetch, webSocket: world.webSocket, ...(world.grant && { grant: world.grant }), shell: given });
  const runtime = createRuntime(platform);
  onTestFinished(() => runtime.close());
  await runtime.start();
  const desk = world.environment("desk");
  /** Lets the fake wire and the runtime answer each other until `condition` holds, with no time passing. */
  const until = async (condition: () => boolean, what: string) => {
    for (let i = 0; i < 100; i++) {
      if (condition()) return;
      await flush();
    }
    throw new Error(`Never ${what}.`);
  };
  const build = () => runtime.desktopUpdate.view.read().build;
  const bundled = () => runtime.desktopUpdate.view.read().bundledServer;
  /** The shell's calls of `member`, each with its arguments. */
  const shellCalls = (member: string) => shell.calls.filter(([called]) => called === member).map(([, ...args]) => args);
  return { clock, world, desk, shell, platform, runtime, until, build, bundled, shellCalls };
};

/** The params of every request of `method` the environment was sent. */
const params = (desk: EnvironmentHandle, method: string) => desk.requests(method).map((request) => request.params);

describe("the desktop's own update", () => {
  it("is checked at launch through the local environment, and a newer build it stages is reported ready to apply and handed to the shell for the next quit", async () => {
    const { desk, until, build, shellCalls } = await launch({ updates: { status: { newest: "0.6.0" }, desktopBuild: STAGED } });

    await until(() => build().state === "ready", "reported the build ready");

    expect(build()).toEqual({ state: "ready", version: RUNNING, staged: STAGED });
    expect(params(desk, "updates.desktop.stage")).toEqual([{ platform: "linux-x64", format: "pacman" }]);
    expect(shellCalls("update.apply")).toEqual([[STAGED, "quit"]]);
  });

  it("is checked again each hour, never through the forge, and a build published since is staged then", async () => {
    const { clock, desk, until, build, shellCalls, shell } = await launch({ updates: { status: { newest: RUNNING } } });
    await until(() => build().state === "current", "found the build current");
    expect(build()).toEqual({ state: "current", version: RUNNING });
    expect(params(desk, "updates.desktop.stage")).toEqual([]);

    desk.setUpdates({ status: { newest: "0.6.0" }, desktopBuild: STAGED });
    clock.advance(HOUR - MINUTE);
    await flush();
    expect(build().state).toBe("current");

    clock.advance(MINUTE);
    await until(() => build().state === "ready", "staged the build published since");
    expect(params(desk, "updates.desktop.stage")).toEqual([{ platform: "linux-x64", format: "pacman" }]);
    expect(shellCalls("update.current")).toHaveLength(2);
    expect(desk.requests("updates.status")).toHaveLength(2);
    // The desktop reached the forge by no route of its own: the shell made no HTTP request.
    expect(shellCalls("http")).toEqual([]);
    expect(shell.calls.map(([member]) => member)).not.toContain("http");
  });

  it("is checked again when the local environment comes back from updating itself, not an hour later, never saying the build is the newest against the newer environment (#1793)", async () => {
    const read = { at: "2026-10-07T10:13:00.000Z", result: "ok" } as const;
    const { clock, desk, runtime, until, build } = await launch({ updates: { status: { version: RUNNING, newest: RUNNING, lastCheck: read } } });
    await until(() => build().state === "current", "found the build current");
    expect(desktopBuildWords(build())).toBe("This client's build is the newest.");

    // The environment's own check finds 0.6.0 and it updates itself: it says bye, restarts as 0.6.0 and is ready again.
    const said: (string | null)[] = [];
    onTestFinished(runtime.desktopUpdate.view.subscribe((view) => said.push(desktopBuildWords(view.build))));
    desk.bye("updating");
    await until(() => runtime.connections.list.read()[0]?.phase === "updating", "heard the environment updating");
    desk.setUpdates({ status: { version: "0.6.0", newest: "0.6.0", lastCheck: { at: "2026-10-07T11:17:24.000Z", result: "ok" } }, desktopBuild: STAGED });
    desk.discovery({ harnessVersion: "0.6.0" });
    clock.advance(10_000);
    await until(() => runtime.connections.list.read()[0]?.phase === "ready", "reconnected");

    await until(() => build().state === "ready", "staged the environment's new version");
    expect(build()).toEqual({ state: "ready", version: RUNNING, staged: STAGED });
    expect(params(desk, "updates.desktop.stage")).toEqual([{ platform: "linux-x64", format: "pacman" }]);
    expect(said).not.toContain("This client's build is the newest.");
  });

  it("is checked again when the local environment says an update is pending, which its channel's newest found (#1793)", async () => {
    const { desk, until, build } = await launch({ updates: { status: { version: RUNNING, newest: RUNNING, lastCheck: { at: "2026-10-07T10:13:00.000Z", result: "ok" } } } });
    await until(() => build().state === "current", "found the build current");

    desk.setUpdates({ status: { newest: "0.6.0", lastCheck: { at: "2026-10-07T11:13:14.000Z", result: "ok" } }, desktopBuild: STAGED });
    desk.notice("environment.update-pending", {
      updateId: "6f1c2d3e-4a5b-4c6d-8e7f-1a2b3c4d5e6f",
      toVersion: "0.6.0",
      source: "channel",
      since: "2026-10-07T11:13:14.000Z",
      deferUntil: "2026-10-07T13:13:14.000Z",
    });

    await until(() => build().state === "ready", "staged the newest the environment found");
    expect(build()).toEqual({ state: "ready", version: RUNNING, staged: STAGED });
  });

  it("checks again once the check under way ends when the local environment says more while it stages, leaving one hourly check (#1793)", async () => {
    const { clock, desk, until, build } = await launch({ updates: { status: { version: RUNNING, newest: RUNNING, lastCheck: { at: "2026-10-07T10:13:00.000Z", result: "ok" } } } });
    await until(() => build().state === "current", "found the build current");
    // Each stage is a download, answered when the test lets it end.
    const stages: (() => void)[] = [];
    desk.wire.answer("updates.desktop.stage", () => new Promise((resolve) => stages.push(() => resolve({ result: { ...STAGED } }))));
    const updateId = "6f1c2d3e-4a5b-4c6d-8e7f-1a2b3c4d5e6f";
    desk.setUpdates({ status: { newest: "0.6.0", lastCheck: { at: "2026-10-07T11:13:14.000Z", result: "ok" } } });
    desk.notice("environment.update-pending", { updateId, toVersion: "0.6.0", source: "channel", since: "2026-10-07T11:13:14.000Z", deferUntil: "2026-10-07T13:13:14.000Z" });
    await until(() => desk.requests("updates.desktop.stage").length === 1, "began staging");

    // The stage is still under way when the environment says its update began.
    desk.notice("environment.update-started", { updateId, fromVersion: RUNNING, toVersion: "0.6.0", cause: "idle" });
    for (let i = 0; i < 5; i++) await flush();
    expect(desk.requests("updates.desktop.stage")).toHaveLength(1);
    stages[0]?.();
    await until(() => desk.requests("updates.desktop.stage").length === 2, "checked again after the stage under way");
    // The second stage takes ten minutes, so an hourly check left by the first would come before the second's.
    clock.advance(10 * MINUTE);
    stages[1]?.();
    for (let i = 0; i < 10; i++) await flush();
    expect(build()).toEqual({ state: "ready", version: RUNNING, staged: STAGED });

    // One hourly check is left, an hour after the last check ended: none before it, and none after it but the next hour's.
    clock.advance(HOUR - MINUTE);
    for (let i = 0; i < 5; i++) await flush();
    expect(desk.requests("updates.desktop.stage")).toHaveLength(2);
    clock.advance(MINUTE);
    await until(() => desk.requests("updates.desktop.stage").length === 3, "checked at the hour");
    stages[2]?.();
    for (let i = 0; i < 5; i++) await flush();
    expect(desk.requests("updates.desktop.stage")).toHaveLength(3);
  });

  it("waits for the local environment's first read of its channel, never reporting the build newest, and stages the newer build as soon as that read lands (#1753)", async () => {
    const { clock, desk, until, build } = await launch();
    await until(() => build().state === "waiting", "waited for the environment's first check");
    expect(build()).toEqual({ state: "waiting", version: RUNNING });
    expect(desktopBuildWords(build())).not.toBe("This client's build is the newest.");

    // The environment reads its channel two minutes after its start: until then each look again finds it unread.
    for (let looked = 2; looked * DESKTOP_UNREAD_RECHECK_MS <= 2 * MINUTE + DESKTOP_UNREAD_RECHECK_MS; looked++) {
      clock.advance(DESKTOP_UNREAD_RECHECK_MS);
      await until(() => desk.requests("updates.status").length === looked, "looked again");
      for (let i = 0; i < 5; i++) await flush();
      expect(build()).toEqual({ state: "waiting", version: RUNNING });
    }

    // The read lands between two looks: the next one, within DESKTOP_UNREAD_RECHECK_MS, stages what it found, not an hour later.
    desk.setUpdates({ status: { newest: "0.6.0", lastCheck: { at: "2026-10-03T21:21:26.000Z", result: "ok" } }, desktopBuild: STAGED });
    clock.advance(DESKTOP_UNREAD_RECHECK_MS - 1);
    for (let i = 0; i < 5; i++) await flush();
    expect(params(desk, "updates.desktop.stage")).toEqual([]);
    clock.advance(1);
    await until(() => build().state === "ready", "staged the build the first read found");
    expect(build()).toEqual({ state: "ready", version: RUNNING, staged: STAGED });
  });

  it("does not show checking again while it waits for the local environment's first read", async () => {
    const { clock, desk, runtime, until, build } = await launch();
    await until(() => build().state === "waiting", "waited for the environment's first check");
    const seen: string[] = [];
    const stop = runtime.desktopUpdate.view.subscribe((view) => seen.push(view.build.state));
    onTestFinished(stop);

    clock.advance(DESKTOP_UNREAD_RECHECK_MS);
    await until(() => desk.requests("updates.status").length === 2, "looked again");
    await flush();
    expect(seen).not.toContain("checking");
    expect(build()).toEqual({ state: "waiting", version: RUNNING });
  });

  it("never reports a build older than the local environment's own version as the newest before the channel is read, and follows the newest once it is (#1753)", async () => {
    const unread = await launch({ updates: { status: { version: "0.6.0" }, desktopBuild: STAGED } });
    await unread.until(() => unread.build().state === "ready", "staged the environment's version");
    expect(params(unread.desk, "updates.desktop.stage")).toEqual([{ platform: "linux-x64", format: "pacman" }]);

    // The channel's newest below the version the environment runs (a beta it left, a release withdrawn) is what a stage would stage: nothing newer.
    const below = await launch({ updates: { status: { version: "0.6.0", newest: RUNNING, lastCheck: { at: "2026-10-03T21:00:00.000Z", result: "ok" } }, desktopBuild: STAGED } });
    await below.until(() => below.build().state === "current", "followed the channel's newest");
    expect(params(below.desk, "updates.desktop.stage")).toEqual([]);

    // A read that found no release on the channel (a beta left for a stable channel with none yet): a stage would find nothing either.
    const empty = await launch({ updates: { status: { version: "0.6.0", lastCheck: { at: "2026-10-03T21:00:00.000Z", result: "ok" } }, desktopBuild: STAGED } });
    await empty.until(() => empty.build().state === "current", "found nothing on the channel");
    expect(params(empty.desk, "updates.desktop.stage")).toEqual([]);
  });

  it("follows the local environment's pin, whatever its channel's newest", async () => {
    const { desk, until, build } = await launch({ updates: { status: { newest: RUNNING }, desktopBuild: STAGED }, settings: { "updates.pinnedVersion": "0.6.0" } });
    await until(() => build().state === "ready", "staged the pinned build");
    expect(params(desk, "updates.desktop.stage")).toHaveLength(1);

    const pinnedBelow = await launch({ updates: { status: { newest: "0.7.0" }, desktopBuild: STAGED }, settings: { "updates.pinnedVersion": "0.4.0" } });
    await pinnedBelow.until(() => pinnedBelow.build().state === "current", "found nothing newer pinned");
    expect(params(pinnedBelow.desk, "updates.desktop.stage")).toEqual([]);
  });

  it("applies the staged build on the renderer's call to restart", async () => {
    const { runtime, until, build, shellCalls } = await launch({ updates: { status: { newest: "0.6.0" }, desktopBuild: STAGED } });
    await until(() => build().state === "ready", "reported the build ready");

    await runtime.desktopUpdate.restart();

    expect(shellCalls("update.apply")).toEqual([
      [STAGED, "quit"],
      [STAGED, "now"],
    ]);
    expect(build()).toEqual({ state: "applying", version: RUNNING, staged: STAGED });
  });

  it("hands the shell a build for the next quit once, and a newer one staged later in its place", async () => {
    const { clock, desk, until, build, shellCalls } = await launch({ updates: { status: { newest: "0.6.0" }, desktopBuild: STAGED } });
    await until(() => build().state === "ready", "reported the build ready");
    clock.advance(HOUR);
    await until(() => desk.requests("updates.desktop.stage").length === 2, "checked again");
    await flush();
    expect(shellCalls("update.apply")).toEqual([[STAGED, "quit"]]);

    const later: ShellStagedBuild = { ...STAGED, path: STAGED.path.replaceAll("0.6.0", "0.6.1"), version: "0.6.1", sha256: "b".repeat(64) };
    desk.setUpdates({ status: { newest: "0.6.1" }, desktopBuild: later });
    clock.advance(HOUR);
    await until(() => { const now = build(); return now.state === "ready" && now.staged.version === "0.6.1"; }, "staged the newer build");
    expect(shellCalls("update.apply")).toEqual([
      [STAGED, "quit"],
      [later, "quit"],
    ]);
  });

  it("keeps a build ready through a later check that fails or finds nothing newer: it was handed over for the next quit", async () => {
    const { clock, desk, until, build, shellCalls } = await launch({ updates: { status: { newest: "0.6.0" }, desktopBuild: STAGED } });
    await until(() => build().state === "ready", "reported the build ready");

    desk.setUpdates({ desktopBuild: { refused: "conflict", message: "The forge did not answer.", data: { reason: "unreachable" } } });
    clock.advance(HOUR);
    await until(() => desk.requests("updates.desktop.stage").length === 2, "checked again");
    await flush();
    expect(build()).toEqual({ state: "ready", version: RUNNING, staged: STAGED });

    desk.setUpdates({ status: { newest: RUNNING } });
    clock.advance(HOUR);
    await until(() => desk.requests("updates.status").length === 3, "checked a third time");
    await flush();
    expect(build()).toEqual({ state: "ready", version: RUNNING, staged: STAGED });
    expect(shellCalls("update.apply")).toEqual([[STAGED, "quit"]]);
  });

  it("reports unsupported with the release page when the install cannot update itself, and stages nothing", async () => {
    const { desk, until, build, shellCalls } = await launch({
      updates: { status: { newest: "0.6.0" }, desktopBuild: STAGED },
      shell: (shell) => shell.answer("update.current", async () => ({ version: RUNNING, platform: "linux", arch: "x64", format: null })),
    });

    await until(() => build().state === "unsupported", "reported the install unsupported");

    expect(build()).toEqual({ state: "unsupported", version: RUNNING, releasePage: "https://git.example.test/david/agent-harness/releases" });
    expect(params(desk, "updates.desktop.stage")).toEqual([]);
    expect(shellCalls("update.apply")).toEqual([]);
  });

  it("reports a failure cleaning up a staged folder as a cleanup failure, never as an unreachable release, the staged build kept to apply", async () => {
    const message = "Could not remove the temporary folder /tmp/agent-harness-update-1: EBUSY.";
    const { runtime, until, build } = await launch({
      updates: { status: { newest: "0.6.0" }, desktopBuild: STAGED },
      shell: (shell) => shell.answer("update.apply", async (_staged, when) => (when === "now" ? { outcome: "failed", failure: "cleanup", message } : { outcome: "applied" })),
    });
    await until(() => build().state === "ready", "reported the build ready");

    await runtime.desktopUpdate.restart();

    expect(build()).toEqual({ state: "failed", version: RUNNING, failure: "cleanup", message, staged: STAGED, releasePage: "https://git.example.test/david/agent-harness/releases" });
  });

  it("reports an install that failed with the shell's command that installs the staged build by hand and the release page, the build kept to apply", async () => {
    const message = "Installing 0.6.0 needs pkexec, which polkit provides, and it is not installed, so 0.5.0 stays installed.";
    const byHand = `sudo pacman -U ${STAGED.path}`;
    const { runtime, until, build } = await launch({
      updates: { status: { newest: "0.6.0" }, desktopBuild: STAGED },
      shell: (shell) => shell.answer("update.apply", async (_staged, when) => (when === "now" ? { outcome: "failed", failure: "install", message, byHand } : { outcome: "applied" })),
    });
    await until(() => build().state === "ready", "reported the build ready");

    expect(await runtime.desktopUpdate.restart()).toEqual({
      state: "failed",
      version: RUNNING,
      failure: "install",
      message,
      staged: STAGED,
      byHand,
      releasePage: "https://git.example.test/david/agent-harness/releases",
    });
  });

  it("keeps an install that failed through the hourly checks that find the same build, and gives way to a newer build staged later", async () => {
    const message = "Installing 0.6.0 needs pkexec, which polkit provides, and it is not installed, so 0.5.0 stays installed.";
    const { clock, desk, runtime, until, build } = await launch({
      updates: { status: { newest: "0.6.0" }, desktopBuild: STAGED },
      shell: (shell) => shell.answer("update.apply", async (_staged, when) => (when === "now" ? { outcome: "failed", failure: "install", message, byHand: `sudo pacman -U ${STAGED.path}` } : { outcome: "applied" })),
    });
    await until(() => build().state === "ready", "reported the build ready");
    const failed = await runtime.desktopUpdate.restart();
    const shown: string[] = [];
    runtime.desktopUpdate.view.subscribe(({ build: { state } }) => shown.push(state));

    clock.advance(HOUR);
    await until(() => desk.requests("updates.desktop.stage").length === 2, "staged the same build again");
    await flush();
    // Never "checking", "staging" or "ready" between: that would offer the restart that failed.
    expect(shown.every((state) => state === "failed")).toBe(true);
    expect(build()).toEqual(failed);

    const NEWER: ShellStagedBuild = { path: "/home/milo/.local/state/agent-harness/desktop/0.7.0/agent-harness-0.7.0.pacman", version: "0.7.0", sha256: "b".repeat(64) };
    desk.setUpdates({ status: { newest: "0.7.0" }, desktopBuild: NEWER });
    clock.advance(HOUR);
    await until(() => build().state === "ready", "staged the newer build");
    expect(build()).toEqual({ state: "ready", version: RUNNING, staged: NEWER });
  });

  it("reports the build ready once a later check hands the same build over for the quit after an earlier hand-over failed", async () => {
    const message = "The staged build did not match its SHA-256.";
    let quitFails = true;
    const { clock, desk, until, build, shellCalls } = await launch({
      updates: { status: { newest: "0.6.0" }, desktopBuild: STAGED },
      shell: (shell) => shell.answer("update.apply", async () => (quitFails ? { outcome: "failed", failure: "install", message } : { outcome: "applied" })),
    });
    await until(() => build().state === "failed", "failed the hand-over for the quit");
    expect(build()).toMatchObject({ failure: "install", message, staged: STAGED });

    quitFails = false;
    clock.advance(HOUR);
    await until(() => build().state === "ready", "reported the build handed over");

    expect(build()).toEqual({ state: "ready", version: RUNNING, staged: STAGED });
    expect(shellCalls("update.apply")).toEqual([
      [STAGED, "quit"],
      [STAGED, "quit"],
    ]);
    expect(desk.requests("updates.desktop.stage")).toHaveLength(2);
  });

  it("keeps a restart that failed after a failed hand-over for the quit, though a later check hands the same build over", async () => {
    const restartMessage = "Installing 0.6.0 needs pkexec, which polkit provides, and it is not installed, so 0.5.0 stays installed.";
    let quitFails = true;
    const { clock, desk, runtime, until, build, shellCalls } = await launch({
      updates: { status: { newest: "0.6.0" }, desktopBuild: STAGED },
      shell: (shell) =>
        shell.answer("update.apply", async (_staged, when) =>
          when === "now" ? { outcome: "failed", failure: "install", message: restartMessage } : quitFails ? { outcome: "failed", failure: "install", message: "The staged build could not be read." } : { outcome: "applied" },
        ),
    });
    await until(() => build().state === "failed", "failed the hand-over for the quit");
    const failed = await runtime.desktopUpdate.restart();
    expect(failed).toMatchObject({ failure: "install", message: restartMessage });

    quitFails = false;
    clock.advance(HOUR);
    await until(() => desk.requests("updates.desktop.stage").length === 2, "staged the same build again");
    await until(() => shellCalls("update.apply").length === 3, "handed the build over for the quit");
    await flush();

    // Ready again would offer the restart that failed (#1692).
    expect(build()).toEqual(failed);
  });

  it("says which step failed: the check when the local environment's own check could not read the channel, the stage when it refused the build, the install when the shell could not apply it", async () => {
    const unread = await launch({ updates: { status: { lastCheck: { at: "2026-09-24T00:00:00.000Z", result: "failed", reason: "no_release_access", message: "No forge account covers the release origin." } } } });
    await unread.until(() => unread.build().state === "failed", "failed the check");
    expect(unread.build()).toMatchObject({ failure: "check", message: "No forge account covers the release origin." });

    const refused = await launch({ updates: { status: { newest: "0.6.0" }, desktopBuild: { refused: "conflict", message: "The artefact did not download.", data: { reason: "no_release_access" } } } });
    await refused.until(() => refused.build().state === "failed", "failed the stage");
    expect(refused.build()).toMatchObject({ failure: "stage", message: expect.stringContaining("The artefact did not download.") as unknown as string, staged: null });

    const denied = await launch({
      updates: { status: { newest: "0.6.0" }, desktopBuild: STAGED },
      shell: (shell) => shell.answer("update.apply", async (_staged, when) => (when === "now" ? { outcome: "failed", failure: "install", message: "Authentication was refused: 0.5.0 stays installed." } : { outcome: "applied" })),
    });
    await denied.until(() => denied.build().state === "ready", "reported the build ready");
    await denied.runtime.desktopUpdate.restart();
    expect(denied.build()).toMatchObject({ failure: "install", staged: STAGED });
  });

  it.each(["draining", "updating"] as const)(
    "never fails a stage the local environment's %s cut short, and stages again as soon as the environment is ready, which finds the build staged (#1788)",
    async (reason) => {
      const { clock, desk, runtime, until, build, shellCalls } = await launch({
        updates: { status: { newest: "0.6.0" }, desktopBuild: STAGED },
        desk: (desk) => desk.wire.holdNext("updates.desktop.stage"),
      });
      await until(() => build().state === "staging" && desk.requests("updates.desktop.stage").length === 1, "started the stage");

      // The environment goes away before it answers the stage: its socket closes with a bye, and the stage with it.
      desk.bye(reason);
      await until(() => runtime.connections.list.read()[0]?.phase === reason, "heard the environment go");
      for (let i = 0; i < 5; i++) await flush();
      expect(build().state).not.toBe("failed");

      // Ready again well inside a minute, not the hour after: the next stage answers the build the cut one staged.
      clock.advance(10_000);
      await until(() => runtime.connections.list.read()[0]?.phase === "ready", "reconnected");
      await until(() => build().state === "ready", "reported the build ready");
      expect(build()).toEqual({ state: "ready", version: RUNNING, staged: STAGED });
      expect(params(desk, "updates.desktop.stage")).toEqual([{ platform: "linux-x64", format: "pacman" }]);
      expect(shellCalls("update.apply")).toEqual([[STAGED, "quit"]]);
    },
  );

  it("never fails a check whose read of the local environment's updates its restart cut short, and shows what it had until it looks again (#1788)", async () => {
    const { clock, desk, runtime, until, build } = await launch({ updates: { status: { newest: RUNNING } } });
    await until(() => build().state === "current", "found the build current");

    desk.wire.holdNext("updates.status");
    desk.setUpdates({ status: { newest: "0.6.0" }, desktopBuild: STAGED });
    clock.advance(HOUR);
    await until(() => desk.requests("updates.status").length === 2, "checked again");
    desk.bye("draining");
    await until(() => runtime.connections.list.read()[0]?.phase === "draining", "heard the environment drain");
    for (let i = 0; i < 5; i++) await flush();
    expect(build()).toEqual({ state: "current", version: RUNNING });

    clock.advance(10_000);
    await until(() => build().state === "ready", "staged the build once the environment was ready again");
    expect(build()).toEqual({ state: "ready", version: RUNNING, staged: STAGED });
  });

  it("checks again at once on a person's Check again after a failed stage, not an hour later", async () => {
    const { desk, runtime, until, build } = await launch({ updates: { status: { newest: "0.6.0" }, desktopBuild: { refused: "conflict", message: "The artefact did not download.", data: { reason: "download" } } } });
    await until(() => build().state === "failed", "failed the stage");

    desk.setUpdates({ desktopBuild: STAGED });
    expect(await runtime.desktopUpdate.checkAgain()).toEqual({ state: "ready", version: RUNNING, staged: STAGED });
    expect(desk.requests("updates.desktop.stage")).toHaveLength(2);
  });

  it("is never checked on a shell with no update", async () => {
    const { desk, build, shellCalls } = await launch({ updates: { status: { newest: "0.6.0" }, desktopBuild: STAGED }, without: ["update"] });
    await flush();
    expect(build()).toEqual({ state: "unchecked" });
    expect(shellCalls("update.current")).toEqual([]);
    expect(desk.requests("updates.desktop.stage")).toEqual([]);
  });
});

describe("the server artefact the desktop carries", () => {
  const carrying = (version: string) => (shell: FakeShell) => shell.answer("installer.bundledServer", async () => ({ version, path: BUNDLED_PATH }));

  it("is handed to a local environment it is newer than, with its version and path, under the idle rules, when auto-update is effective there, once a start", async () => {
    const { clock, desk, runtime, until, bundled } = await launch({ updates: { status: { version: RUNNING } }, shell: carrying("0.6.0") });

    await until(() => bundled().state === "handed-over", "handed the bundled server over");

    expect(params(desk, "updates.apply")).toEqual([{ commandId: expect.any(String) as unknown as string, version: "0.6.0", artefactPath: BUNDLED_PATH, when: "idle" }]);
    expect(bundled()).toEqual({ state: "handed-over", version: "0.6.0", updateId: expect.any(String) as unknown as string });

    // The environment's restart for it is a new ready, not a new start: nothing is handed over again.
    desk.bye("updating");
    await until(() => runtime.connections.list.read()[0]?.phase === "updating", "heard the environment updating");
    clock.advance(10_000);
    await until(() => desk.wire.opened() === 2 && runtime.connections.list.read()[0]?.phase === "ready", "reconnected");
    await flush();
    expect(desk.requests("updates.apply")).toEqual([]);
  });

  it.each(["updating", "draining"] as const)("regains the local grant when the bundled server's %s restart rejects the earlier local session", async reason => {
    const { clock, desk, runtime, until, bundled } = await launch({ updates: { status: { version: RUNNING } }, settings: { "updates.autoUpdate": false }, shell: carrying("0.6.0") });
    await until(() => bundled().state === "offered", "offered the bundled server");
    const firstSession = runtime.connections.list.read()[0]?.clientSessionId;
    const firstToken = desk.wire.credential()?.token;
    expect(runtime.connections.list.read()[0]?.phase).toBe("ready");
    expect(await runtime.desktopUpdate.applyBundledServer()).toMatchObject({ state: "handed-over", version: "0.6.0" });

    // The service's new process accepts fresh local grants, but not the old process's local session.
    desk.autoAccept(false);
    desk.bye(reason);
    await until(() => runtime.connections.list.read()[0]?.phase === reason, "heard the owned environment restarting");
    desk.discovery({ harnessVersion: "0.6.0" });
    clock.advance(10_000);
    await until(() => desk.wire.opened() === 2, "opened the owned update's reconnect");
    const auth = await desk.server.expect("auth");
    desk.autoAccept(true);
    if (auth.token === firstToken) desk.bye("revoked");
    else desk.server.hello();
    await flush();
    clock.advance(10_000);
    await until(() => runtime.connections.list.read()[0]?.phase === "ready", "regained the local environment after the owned update revoked its earlier session");

    expect(runtime.connections.list.read()[0]).toMatchObject({ kind: "local", phase: "ready", blocked: null });
    expect(runtime.connections.list.read()[0]?.clientSessionId).not.toBe(firstSession);
    expect(desk.wire.credential()?.token).not.toBe(firstToken);
  });

  it.each(["updating", "draining"] as const)("regains the local grant after a transport failure during the bundled server's %s restart", async reason => {
    const { clock, desk, runtime, until, bundled } = await launch({ updates: { status: { version: RUNNING } }, settings: { "updates.autoUpdate": false }, shell: carrying("0.6.0") });
    await until(() => bundled().state === "offered", "offered the bundled server");
    const firstSession = runtime.connections.list.read()[0]?.clientSessionId;
    const firstToken = desk.wire.credential()?.token;
    await runtime.desktopUpdate.applyBundledServer();
    desk.autoAccept(false);
    desk.bye(reason);
    await until(() => runtime.connections.list.read()[0]?.phase === reason, "heard the owned environment restarting");
    clock.advance(10_000);
    await until(() => desk.wire.opened() === 2, "opened the restart's first handshake");
    await desk.server.expect("auth");
    desk.server.drop();
    await flush();
    clock.advance(10_000);
    await until(() => desk.wire.opened() === 3, "retried after the transient transport failure");
    const auth = await desk.server.expect("auth");
    desk.autoAccept(true);
    if (auth.token === firstToken) desk.bye("revoked");
    else desk.server.hello();
    await until(() => runtime.connections.list.read()[0]?.phase === "ready", "regained the local environment after the transient transport failure and old session rejection");

    expect(runtime.connections.list.read()[0]).toMatchObject({ kind: "local", phase: "ready", blocked: null });
    expect(runtime.connections.list.read()[0]?.clientSessionId).not.toBe(firstSession);
    expect(desk.wire.credential()?.token).not.toBe(firstToken);
  });

  it.each([false, true])("stops if the restarted service rejects the fresh local session too (transport failure before rejection: %s)", async transportFailure => {
    const { clock, desk, runtime, until, bundled } = await launch({ updates: { status: { version: RUNNING } }, settings: { "updates.autoUpdate": false }, shell: carrying("0.6.0") });
    await until(() => bundled().state === "offered", "offered the bundled server");
    const firstToken = desk.wire.credential()?.token;
    await runtime.desktopUpdate.applyBundledServer();
    desk.autoAccept(false);
    desk.bye("updating");
    await until(() => runtime.connections.list.read()[0]?.phase === "updating", "heard the update");
    clock.advance(10_000);
    await until(() => desk.wire.opened() === 2, "opened the restart's handshake");
    let auth = await desk.server.expect("auth");
    if (auth.token === firstToken) {
      desk.bye("revoked");
      await until(() => desk.wire.opened() === 3, "exchanged the grant once and opened its handshake");
      auth = await desk.server.expect("auth");
    }
    expect(auth.token).not.toBe(firstToken);
    if (transportFailure) {
      const freshToken = auth.token;
      const openedBefore = desk.wire.opened();
      desk.server.drop();
      await flush();
      clock.advance(10_000);
      await until(() => desk.wire.opened() === openedBefore + 1, "retried the fresh session after the transport failure");
      auth = await desk.server.expect("auth");
      expect(auth.token).toBe(freshToken);
    }
    desk.bye("revoked");
    await flush();
    const socketsAfterRejection = desk.wire.opened();
    clock.advance(HOUR);
    await flush();

    expect(runtime.connections.list.read()[0]).toMatchObject({ kind: "local", phase: "blocked", blocked: "revoked", retryAt: null });
    expect(desk.wire.opened()).toBe(socketsAfterRejection);
  });

  it("is offered instead when auto-update is not effective there, off or pinned, and handed over on the card's call", async () => {
    const off = await launch({ updates: { status: { version: RUNNING } }, settings: { "updates.autoUpdate": false }, shell: carrying("0.6.0") });
    await off.until(() => off.bundled().state === "offered", "offered the bundled server");
    expect(off.bundled()).toEqual({ state: "offered", version: "0.6.0", environmentVersion: RUNNING });
    expect(off.desk.requests("updates.apply")).toEqual([]);

    expect(await off.runtime.desktopUpdate.applyBundledServer()).toMatchObject({ state: "handed-over", version: "0.6.0" });
    expect(params(off.desk, "updates.apply")).toEqual([{ commandId: expect.any(String) as unknown as string, version: "0.6.0", artefactPath: BUNDLED_PATH, when: "idle" }]);

    const pinned = await launch({ updates: { status: { version: RUNNING } }, settings: { "updates.pinnedVersion": RUNNING }, shell: carrying("0.6.0") });
    await pinned.until(() => pinned.bundled().state === "offered", "offered the bundled server");
    expect(pinned.desk.requests("updates.apply")).toEqual([]);
  });

  it("is looked at again on the card's call, so a server the environment has since passed is not handed over, and a look that failed is retried", async () => {
    const passed = await launch({ updates: { status: { version: RUNNING } }, settings: { "updates.autoUpdate": false }, shell: carrying("0.6.0") });
    await passed.until(() => passed.bundled().state === "offered", "offered the bundled server");
    passed.desk.setUpdates({ status: { version: "0.6.1" } });
    expect(await passed.runtime.desktopUpdate.applyBundledServer()).toEqual({ state: "none" });
    expect(passed.desk.requests("updates.apply")).toEqual([]);

    const unread = await launch({
      updates: { status: { version: RUNNING } },
      shell: carrying("0.6.0"),
      desk: (desk) => desk.wire.answer("settings.get", () => ({ error: { code: "internal", message: "The database is busy.", data: {} } })),
    });
    await unread.until(() => unread.bundled().state === "failed", "failed the look");
    expect(unread.bundled()).toMatchObject({ state: "failed", version: "0.6.0", reason: "internal" });
    unread.desk.wire.answer("settings.get", () => ({ result: { values: { "updates.autoUpdate": false, "updates.pinnedVersion": null } } }));
    expect(await unread.runtime.desktopUpdate.applyBundledServer()).toMatchObject({ state: "handed-over", version: "0.6.0" });
  });

  it("is offered rather than handed over when its version's update failed there, which is never retaken automatically", async () => {
    const { desk, until, bundled } = await launch({ updates: { status: { version: RUNNING, failedVersions: ["0.6.0"] } }, shell: carrying("0.6.0") });
    await until(() => bundled().state === "offered", "offered the bundled server");
    expect(desk.requests("updates.apply")).toEqual([]);
  });

  it("is left alone when it is not newer than the environment or than the update it has pending, and when the desktop carries none", async () => {
    const same = await launch({ updates: { status: { version: RUNNING } }, shell: carrying(RUNNING) });
    await same.until(() => same.bundled().state === "none", "left the bundled server alone");

    const pending = await launch({
      updates: {
        status: {
          version: RUNNING,
          pending: { state: "waiting", updateId: "0199aa00-0000-4000-8000-00000000000a", toVersion: "0.6.0", source: "channel", since: "2026-09-24T00:00:00.000Z", deferUntil: "2026-09-25T00:00:00.000Z", image: null, waitsOn: null },
        },
      },
      shell: carrying("0.6.0"),
    });
    await pending.until(() => pending.bundled().state === "none", "left the bundled server alone");

    const none = await launch({ updates: { status: { version: RUNNING } } });
    await none.until(() => none.bundled().state === "none", "found none carried");
    for (const { desk } of [same, pending, none]) expect(desk.requests("updates.apply")).toEqual([]);
  });

  it("keeps a bundled disk refusal retryable without reopening the desktop", async () => {
    let room = false;
    const message = "Not enough disk space for staging and the snapshot. Free space and retry.";
    const { runtime, desk, until, bundled } = await launch({
      updates: { status: { version: RUNNING } },
      shell: (shell) => shell.answer("installer.bundledServer", async () => ({
        version: "0.6.0", path: BUNDLED_PATH,
        ...(!room && { refusal: { reason: "disk" as const, message } }),
      })),
    });
    await until(() => bundled().state !== "unchecked" && bundled().state !== "handing-over", "finished the bundled lookup");
    expect(bundled()).toEqual({ state: "failed", version: "0.6.0", reason: "disk", message });
    expect(desk.requests("updates.apply")).toEqual([]);
    room = true;
    expect(await runtime.desktopUpdate.applyBundledServer()).toMatchObject({ state: "handed-over", version: "0.6.0" });
    expect(params(desk, "updates.apply")).toEqual([{ commandId: expect.any(String) as unknown as string, version: "0.6.0", artefactPath: BUNDLED_PATH, when: "idle" }]);
  });

  it("reports a shell that cannot say what it carries as a failure, at the start and on the card's call alike, never as a rejection", async () => {
    const { runtime, desk, until, bundled } = await launch({
      updates: { status: { version: RUNNING } },
      shell: (shell) => shell.answer("installer.bundledServer", async () => Promise.reject(new Error("resources/server is unreadable"))),
    });
    await until(() => bundled().state === "failed", "reported the failure");
    const failure = { state: "failed", version: null, reason: "shell", message: "The desktop could not say which server it carries: resources/server is unreadable" };
    expect(bundled()).toEqual(failure);

    expect(await runtime.desktopUpdate.applyBundledServer()).toEqual(failure);
    expect(desk.requests("updates.apply")).toEqual([]);
  });

  it.each(["unreadable", "absent"])("keeps a disk refusal actionable when the native space probe is %s", async (probe) => {
    const { runtime, until, bundled } = await launch({
      settings: { "updates.autoUpdate": false },
      receipts: { "updates.apply": { rejected: "conflict", message: "The launcher refused to install 0.6.0: disk.", data: { reason: "install", launcherReason: "disk" } } },
      shell: (shell) => {
        carrying("0.6.0")(shell);
        if (probe === "absent") delete shell.installer.reserveSpace;
        else shell.answer("installer.reserveSpace", async () => { throw new Error("The volume is unavailable."); });
      },
    });
    await until(() => bundled().state === "offered", "offered the bundled server");
    expect(await runtime.desktopUpdate.applyBundledServer()).toMatchObject({
      state: "failed", reason: "install",
      message: "Insufficient disk space to install 0.6.0. The available disk space could not be read; 256 MiB reserve required. The existing environment remains running. Free space and retry.",
    });
  });

  it("reports the environment's refusal with its reason", async () => {
    const { until, bundled } = await launch({
      updates: { status: { version: RUNNING } },
      receipts: { "updates.apply": { rejected: "conflict", message: "No launcher runs this environment to switch its version.", data: { reason: "no_launcher" } } },
      shell: carrying("0.6.0"),
    });
    await until(() => bundled().state === "failed", "reported the refusal");
    expect(bundled()).toEqual({ state: "failed", version: "0.6.0", reason: "no_launcher", message: "No launcher runs this environment to switch its version." });
  });
});
