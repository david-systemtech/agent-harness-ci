import type { SettingsValues } from "@agent-harness/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { createRuntime } from "./runtime.js";
import type { Shell, ShellStagedBuild } from "./shell.js";
import { flush } from "./testing/fake-wire.js";
import { fakeShell, inMemoryPlatform, manualClock, type FakeShell } from "./testing/in-memory-platform.js";
import { scriptedWorld, type ScriptedEnvironment, type ScriptedUpdates } from "./testing/scripted-environment.js";

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
const STAGED: ShellStagedBuild = { path: "/home/seth/.local/state/agent-harness/desktop/0.6.0/agent-harness-0.6.0.pacman", version: "0.6.0", sha256: "a".repeat(64) };

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
const params = (desk: ReturnType<typeof scriptedWorld>["environments"][number], method: string) => desk.requests(method).map((request) => request.params);

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

    expect(build()).toEqual({ state: "failed", version: RUNNING, failure: "cleanup", message, staged: STAGED });
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
