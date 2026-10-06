import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ShellPlatform, ShellStagedBuild } from "@agent-harness/client-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { fakeElectron, type FakeElectron } from "../test/fake-electron.js";
import { fakeSystem, succeeded, type FakeSystem } from "../test/fake-system.js";
import { cleanUp, platformOn, scratch, start } from "../test/harness.js";
import type { DesktopPlatform } from "./platform.js";
import type { CommandResult } from "./update.js";

afterEach(cleanUp);

/**
 * The shell's `update` (launcher-update spec, "The desktop moves with its
 * local environment"; #355): the build the desktop runs, and each
 * platform's own way of applying one its local environment staged. The
 * platform is injected and the OS's commands faked (`test/fake-system.ts`),
 * so each platform's path runs on every runner; the bundle swap's renames
 * and temporary folder are real, on the test's scratch folders.
 */

/** A macOS install: the bundle in an Applications folder of the test's own, its executable saying which build it is. */
const macBundle = (version = "0.5.0") => {
  const applications = join(scratch(), "Applications");
  const bundle = join(applications, "agent-harness.app");
  const executable = join(bundle, "Contents", "MacOS", "agent-harness");
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(executable, version);
  return { applications, bundle, executable, build: () => readFileSync(executable, "utf8") };
};

/** A build of `version` as the local environment stages it, in `desktop-builds/<version>/`: its path, version and SHA-256. */
const stagedBuild = (version: string, name: string): ShellStagedBuild => {
  const path = join(scratch(), "desktop-builds", version, name);
  mkdirSync(dirname(path), { recursive: true });
  const bytes = `the ${name} build of ${version}`;
  writeFileSync(path, bytes);
  return { path, version, sha256: createHash("sha256").update(bytes).digest("hex") };
};

/** The desktop running packaged on `os` at 0.5.0, its executable at `executable`, over `system`. */
const installed = async (os: ShellPlatform, executable: string, system: FakeSystem, overrides: { electron?: FakeElectron; platform?: Partial<DesktopPlatform> } = {}) => {
  const electron = overrides.electron ?? fakeElectron({ os });
  electron.app.isPackaged = true;
  const reported: unknown[] = [];
  const started = await start({ electron, platform: platformOn(os, { executable, ...overrides.platform }), system, reportError: (error) => reported.push(error) });
  return { ...started, reported };
};

/** An Arch machine's pacman, which owns `executable`: `pacman -Qqo` of it names the package. */
const pacmanOwns = (system: FakeSystem, executable: string) =>
  system.answer("pacman", (args) => (args[0] === "-Qqo" && args[1] === executable ? { code: 0, stderr: "" } : { code: 1, stderr: `error: No package owns ${args[1]}` }));

describe("current", () => {
  it("answers the build's version, platform and architecture, and the macOS bundle's format where the bundle can be replaced", async () => {
    const mac = macBundle();
    const { shell } = await installed("darwin", mac.executable, fakeSystem());
    expect(await shell().update.current()).toEqual({ version: "0.5.0", platform: "darwin", arch: "arm64", format: "zip" });
  });

  it("answers the NSIS setup's format on Windows", async () => {
    const { shell } = await installed("win32", "C:\\Users\\milo\\AppData\\Local\\Programs\\agent-harness\\agent-harness.exe", fakeSystem(), {
      platform: { architecture: "x64" },
    });
    expect(await shell().update.current()).toEqual({ version: "0.5.0", platform: "win32", arch: "x64", format: "nsis" });
  });

  it("answers the Arch package's format where pacman owns the running executable", async () => {
    const system = fakeSystem();
    pacmanOwns(system, "/opt/agent-harness/agent-harness");
    const { shell } = await installed("linux", "/opt/agent-harness/agent-harness", system, { platform: { architecture: "x64" } });
    expect(await shell().update.current()).toEqual({ version: "0.5.0", platform: "linux", arch: "x64", format: "pacman" });
    expect(system.ran).toEqual([["pacman", "-Qqo", "/opt/agent-harness/agent-harness"]]);
  });

  it("answers no format for an AppImage or a .deb, which no pacman owns, and for a bundle it cannot replace", async () => {
    const appImage = fakeSystem();
    pacmanOwns(appImage, "/opt/agent-harness/agent-harness");
    const mounted = await installed("linux", "/tmp/.mount_agent-harnessQx7c/agent-harness", appImage);
    expect(await mounted.shell().update.current()).toMatchObject({ platform: "linux", format: null });

    // A Debian machine has no pacman at all.
    const deb = await installed("linux", "/opt/agent-harness/agent-harness", fakeSystem());
    expect(await deb.shell().update.current()).toMatchObject({ platform: "linux", format: null });

    const mac = macBundle();
    const system = fakeSystem();
    system.readOnly(mac.applications);
    const readOnly = await installed("darwin", mac.executable, system);
    expect(await readOnly.shell().update.current()).toMatchObject({ platform: "darwin", format: null });
  });

  it("answers no format when it runs from a checkout, on every platform", async () => {
    for (const os of ["darwin", "win32", "linux"] as const) {
      const system = fakeSystem();
      pacmanOwns(system, "/opt/agent-harness/agent-harness");
      const { shell } = await start({ electron: fakeElectron({ os }), platform: platformOn(os), system });
      expect(await shell().update.current()).toMatchObject({ platform: os, format: null });
    }
  });
});

/** `ditto` unpacking a macOS build: the zip's one bundle, its executable saying it is `version`, into the folder it is given. */
const unzipping = (system: FakeSystem, version: string) =>
  system.answer("ditto", (args) => {
    const into = args.at(-1) ?? "";
    const executable = join(into, "agent-harness.app", "Contents", "MacOS", "agent-harness");
    mkdirSync(dirname(executable), { recursive: true });
    writeFileSync(executable, version);
    return succeeded;
  });

describe("apply on macOS", () => {
  it("replaces the running bundle with the staged one by rename, removes its temporary folder, and starts the new build", async () => {
    const mac = macBundle();
    const system = fakeSystem();
    unzipping(system, "0.6.0");
    const { shell, electron } = await installed("darwin", mac.executable, system);
    const staged = stagedBuild("0.6.0", "agent-harness-desktop-darwin-arm64.zip");

    expect(await shell().update.apply(staged, "now")).toEqual({ outcome: "applied" });

    expect(mac.build()).toBe("0.6.0");
    expect(system.ran).toEqual([["ditto", "-x", "-k", staged.path, system.made[0]]]);
    expect(system.removed).toEqual(system.made);
    expect(readdirSync(mac.applications)).toEqual(["agent-harness.app"]);
    expect(electron.app.calls.filter(([method]) => method === "relaunch" || method === "quit")).toEqual([["relaunch"], ["quit"]]);
    await electron.app.quitted;
  });

  it("renames the old bundle back when the new one cannot be put in place, and says the installed version stays", async () => {
    const mac = macBundle();
    const system = fakeSystem();
    unzipping(system, "0.6.0");
    // The first rename onto the bundle's path is the new bundle's; the old one's rename back is let through.
    system.fail("rename", (_from, to) => to === mac.bundle);
    const { shell, electron } = await installed("darwin", mac.executable, system);

    const outcome = await shell().update.apply(stagedBuild("0.6.0", "agent-harness-desktop-darwin-arm64.zip"), "now");

    expect(outcome).toMatchObject({ outcome: "failed", failure: "install" });
    expect(outcome).toHaveProperty("message", expect.stringMatching(/renamed back, so 0\.5\.0 stays installed/));
    expect(mac.build()).toBe("0.5.0");
    expect(readdirSync(mac.applications)).toEqual(["agent-harness.app"]);
    expect(electron.app.calls.map(([method]) => method)).not.toContain("relaunch");
    expect(electron.app.calls.map(([method]) => method)).not.toContain("quit");
  });

  it("installs nothing from a build that does not unpack, and removes what the unpack left", async () => {
    const mac = macBundle();
    const system = fakeSystem();
    system.answer("ditto", () => ({ code: 1, stderr: "ditto: Couldn't read PKZip signature" }));
    const { shell } = await installed("darwin", mac.executable, system);

    expect(await shell().update.apply(stagedBuild("0.6.0", "agent-harness-desktop-darwin-arm64.zip"), "now")).toEqual({
      outcome: "failed",
      failure: "install",
      message: "0.6.0 did not unpack (ditto: Couldn't read PKZip signature), so 0.5.0 stays installed.",
    });
    expect(mac.build()).toBe("0.5.0");
    expect(readdirSync(mac.applications)).toEqual(["agent-harness.app"]);
  });

  it("at `quit`, swaps the bundle as the desktop next quits, each hand-over replacing the one before, and starts nothing", async () => {
    const mac = macBundle();
    const system = fakeSystem();
    const { shell, electron } = await installed("darwin", mac.executable, system);
    const first = stagedBuild("0.6.0", "agent-harness-desktop-darwin-arm64.zip");
    const second = stagedBuild("0.7.0", "agent-harness-desktop-darwin-arm64.zip");

    expect(await shell().update.apply(first, "quit")).toEqual({ outcome: "applied" });
    expect(await shell().update.apply(second, "quit")).toEqual({ outcome: "applied" });
    expect(system.ran).toEqual([]);
    expect(mac.build()).toBe("0.5.0");

    unzipping(system, "0.7.0");
    electron.app.quit();
    await electron.app.quitted;

    expect(mac.build()).toBe("0.7.0");
    expect(system.ran).toEqual([["ditto", "-x", "-k", second.path, system.made[0]]]);
    expect(readdirSync(mac.applications)).toEqual(["agent-harness.app"]);
    expect(electron.app.calls.map(([method]) => method)).not.toContain("relaunch");
  });

  it("says a temporary folder it could not remove is a cleanup failure, the new build installed and started all the same", async () => {
    const mac = macBundle();
    const system = fakeSystem();
    unzipping(system, "0.6.0");
    system.fail("rm");
    const { shell, electron, reported } = await installed("darwin", mac.executable, system);

    const outcome = await shell().update.apply(stagedBuild("0.6.0", "agent-harness-desktop-darwin-arm64.zip"), "now");

    expect(outcome).toEqual({
      outcome: "failed",
      failure: "cleanup",
      message: `0.6.0 is installed, but the temporary folder ${system.made[0]} could not be removed: EACCES: permission denied, rm '${system.made[0]}'.`,
    });
    expect(mac.build()).toBe("0.6.0");
    expect(reported).toHaveLength(1);
    expect(electron.app.calls.filter(([method]) => method === "relaunch" || method === "quit")).toEqual([["relaunch"], ["quit"]]);
  });
});

describe("apply on Windows", () => {
  const EXECUTABLE = "C:\\Users\\milo\\AppData\\Local\\Programs\\agent-harness\\agent-harness.exe";

  it("at `now`, quits, and runs the staged NSIS setup silently once the desktop has quit, the setup starting it again", async () => {
    const system = fakeSystem();
    const { shell, electron } = await installed("win32", EXECUTABLE, system);
    const staged = stagedBuild("0.6.0", "agent-harness-desktop-win32-x64-setup.exe");
    // The setup is handed over at the quit; until then nothing is started.
    let startedBeforeQuit: unknown[] | undefined;
    const quit = electron.app.quit.bind(electron.app);
    electron.app.quit = () => {
      startedBeforeQuit ??= [...system.started];
      quit();
    };

    expect(await shell().update.apply(staged, "now")).toEqual({ outcome: "applied" });
    await electron.app.quitted;

    expect(startedBeforeQuit).toEqual([]);
    expect(system.started).toEqual([[staged.path, "/S", "--updated", "--force-run"]]);
    expect(system.ran).toEqual([]);
    expect(electron.app.calls.map(([method]) => method)).not.toContain("relaunch");
  });

  it("at `quit`, runs the setup silently as the desktop next quits, and does not start it again", async () => {
    const system = fakeSystem();
    const { shell, electron } = await installed("win32", EXECUTABLE, system);
    const staged = stagedBuild("0.6.0", "agent-harness-desktop-win32-x64-setup.exe");

    expect(await shell().update.apply(staged, "quit")).toEqual({ outcome: "applied" });
    expect(system.started).toEqual([]);
    electron.app.quit();
    await electron.app.quitted;

    expect(system.started).toEqual([[staged.path, "/S", "--updated"]]);
  });
});

describe("apply on Arch", () => {
  const EXECUTABLE = "/opt/agent-harness/agent-harness";

  /** An Arch install whose `pkexec` answers `answer`, recording what it was asked to run. */
  const onArch = async (answer: CommandResult) => {
    const system = fakeSystem();
    pacmanOwns(system, EXECUTABLE);
    system.answer("pkexec", () => answer);
    return { system, ...(await installed("linux", EXECUTABLE, system)) };
  };

  /** Holds `system`'s next pkexec run until the test finishes it, saying when it has started; later runs succeed at once. */
  const holdNextPkexec = (system: FakeSystem) => {
    let started = () => {};
    let finish: (answer: CommandResult) => void = () => {};
    const running = new Promise<void>((resolve) => (started = resolve));
    const held = new Promise<CommandResult>((resolve) => (finish = resolve));
    system.answer("pkexec", () => {
      system.answer("pkexec", () => succeeded);
      started();
      return held;
    });
    return { running, finish };
  };

  /** Whether the desktop has quit by now. */
  const hasQuit = async (electron: FakeElectron) => {
    let gone = false;
    void electron.app.quitted.then(() => (gone = true));
    await Promise.resolve();
    return gone;
  };

  it("at `now`, runs pacman -U on the staged package through pkexec, then starts the new build", async () => {
    const { system, shell, electron } = await onArch(succeeded);
    const staged = stagedBuild("0.6.0", "agent-harness-desktop-linux-x64.pkg.tar.zst");

    expect(await shell().update.apply(staged, "now")).toEqual({ outcome: "applied" });

    expect(system.ran.filter(([command]) => command === "pkexec")).toEqual([["pkexec", "pacman", "-U", "--noconfirm", staged.path]]);
    expect(electron.app.calls.filter(([method]) => method === "relaunch" || method === "quit")).toEqual([["relaunch"], ["quit"]]);
    await electron.app.quitted;
  });

  it("leaves the installed version in place when the authentication is refused or dismissed, and says so", async () => {
    for (const code of [126, 127]) {
      const { shell, electron } = await onArch({ code, stderr: code === 127 ? "Error executing command as another user: Not authorized" : "" });

      const outcome = await shell().update.apply(stagedBuild("0.6.0", "agent-harness-desktop-linux-x64.pkg.tar.zst"), "now");

      expect(outcome).toMatchObject({ outcome: "failed", failure: "install" });
      expect(outcome).toHaveProperty("message", expect.stringMatching(/^Installing 0\.6\.0 needs an administrator, and the authentication was refused.*, so 0\.5\.0 stays installed\.$/));
      expect(electron.app.calls.map(([method]) => method)).not.toContain("quit");
    }
  });

  it("says why pacman did not install the package, and the command that installs it by hand", async () => {
    const { shell } = await onArch({ code: 1, stderr: "loading packages...\nerror: failed to init transaction (unable to lock database)" });
    const staged = stagedBuild("0.6.0", "agent-harness-desktop-linux-x64.pkg.tar.zst");
    expect(await shell().update.apply(staged, "now")).toEqual({
      outcome: "failed",
      failure: "install",
      message: "pacman could not install 0.6.0 (error: failed to init transaction (unable to lock database)), so 0.5.0 stays installed.",
      byHand: `sudo pacman -U ${staged.path}`,
    });
  });

  it("says pkexec is missing, as on an install without polkit, and the command that installs the package by hand", async () => {
    const system = fakeSystem();
    pacmanOwns(system, EXECUTABLE);
    const { shell, electron } = await installed("linux", EXECUTABLE, system);
    const staged = stagedBuild("0.6.0", "agent-harness-desktop-linux-x64.pkg.tar.zst");

    expect(await shell().update.apply(staged, "now")).toEqual({
      outcome: "failed",
      failure: "install",
      message: "Installing 0.6.0 needs pkexec, which polkit provides, and it is not installed, so 0.5.0 stays installed.",
      byHand: `sudo pacman -U ${staged.path}`,
    });
    expect(electron.app.calls.map(([method]) => method)).not.toContain("quit");
  });

  it("says no polkit authentication agent is running when pkexec finds none to ask", async () => {
    const { shell } = await onArch({ code: 127, stderr: "Error executing command as another user: No authentication agent found." });
    const staged = stagedBuild("0.6.0", "agent-harness-desktop-linux-x64.pkg.tar.zst");
    expect(await shell().update.apply(staged, "now")).toEqual({
      outcome: "failed",
      failure: "install",
      message: "Installing 0.6.0 needs an administrator, and no polkit authentication agent is running to ask for one, so 0.5.0 stays installed.",
      byHand: `sudo pacman -U ${staged.path}`,
    });
  });

  it("quotes a staged path the shell would split in the command that installs it by hand", async () => {
    const { shell } = await onArch({ code: 126, stderr: "" });
    const staged = stagedBuild("0.6.0", "agent harness's build.pkg.tar.zst");
    expect(await shell().update.apply(staged, "now")).toHaveProperty("byHand", `sudo pacman -U '${staged.path.replaceAll("'", "'\\''")}'`);
  });

  it("keeps a build handed over for the quit when installing it now was refused", async () => {
    const { system, shell, electron } = await onArch({ code: 126, stderr: "" });
    const staged = stagedBuild("0.6.0", "agent-harness-desktop-linux-x64.pkg.tar.zst");
    await shell().update.apply(staged, "quit");
    expect(await shell().update.apply(staged, "now")).toMatchObject({ outcome: "failed", failure: "install" });

    system.answer("pkexec", () => succeeded);
    electron.app.quit();
    await electron.app.quitted;

    expect(system.ran.filter(([command]) => command === "pkexec")).toHaveLength(2);
  });

  it("at `quit`, holds the quit until pacman has run, and says on the desktop's log when it did not install", async () => {
    const { system, shell, electron, reported } = await onArch({ code: 126, stderr: "" });
    const staged = stagedBuild("0.6.0", "agent-harness-desktop-linux-x64.pkg.tar.zst");

    expect(await shell().update.apply(staged, "quit")).toEqual({ outcome: "applied" });
    expect(system.ran.filter(([command]) => command === "pkexec")).toEqual([]);
    electron.app.quit();
    await electron.app.quitted;

    expect(system.ran.filter(([command]) => command === "pkexec")).toEqual([["pkexec", "pacman", "-U", "--noconfirm", staged.path]]);
    expect(String(reported[0])).toMatch(/the authentication was refused, so 0\.5\.0 stays installed/);
    expect(electron.app.calls.map(([method]) => method)).not.toContain("relaunch");
  });

  it("refuses every quit asked for while the install at the quit runs, and quits once it is done", async () => {
    const { system, shell, electron } = await onArch(succeeded);
    const staged = stagedBuild("0.6.0", "agent-harness-desktop-linux-x64.pkg.tar.zst");
    const pacman = holdNextPkexec(system);

    await shell().update.apply(staged, "quit");
    electron.app.quit();
    await pacman.running;
    // A second quit while pacman runs, as the dock's Quit or another Cmd-Q asks for.
    electron.app.quit();
    expect(await hasQuit(electron)).toBe(false);

    pacman.finish(succeeded);
    await electron.app.quitted;
    expect(system.ran.filter(([command]) => command === "pkexec")).toEqual([["pkexec", "pacman", "-U", "--noconfirm", staged.path]]);
  });

  it("holds a quit asked for while a build installs now until it is done, then quits, starting the new build only when it installed", async () => {
    const outcomes = [
      { answer: succeeded, outcome: "applied", restarts: true },
      { answer: { code: 1, stderr: "error: failed to commit transaction" }, outcome: "failed", restarts: false },
    ];
    for (const { answer, outcome, restarts } of outcomes) {
      const { system, shell, electron } = await onArch(succeeded);
      const pacman = holdNextPkexec(system);

      const applying = shell().update.apply(stagedBuild("0.6.0", "agent-harness-desktop-linux-x64.pkg.tar.zst"), "now");
      await pacman.running;
      electron.app.quit();
      expect(await hasQuit(electron)).toBe(false);

      pacman.finish(answer);
      expect(await applying).toMatchObject({ outcome });
      await electron.app.quitted;
      expect(electron.app.calls.some(([method]) => method === "relaunch")).toBe(restarts);
    }
  });

  it("installs nothing at the quit over a build installed now while the quit was held", async () => {
    const { system, shell, electron } = await onArch(succeeded);
    const handed = stagedBuild("0.6.0", "agent-harness-desktop-linux-x64.pkg.tar.zst");
    const newer = stagedBuild("0.7.0", "agent-harness-desktop-linux-x64.pkg.tar.zst");
    await shell().update.apply(handed, "quit");
    const pacman = holdNextPkexec(system);

    const applying = shell().update.apply(newer, "now");
    await pacman.running;
    electron.app.quit();
    pacman.finish(succeeded);

    expect(await applying).toEqual({ outcome: "applied" });
    await electron.app.quitted;
    expect(system.ran.filter(([command]) => command === "pkexec")).toEqual([["pkexec", "pacman", "-U", "--noconfirm", newer.path]]);
  });
});

describe("apply, on every platform", () => {
  it("refuses an install that cannot update itself, pointing at the release page, and runs nothing", async () => {
    const system = fakeSystem();
    const { shell } = await installed("linux", "/tmp/.mount_agent-harnessQx7c/agent-harness", system);

    const outcome = await shell().update.apply(stagedBuild("0.6.0", "agent-harness-desktop-linux-x64.pkg.tar.zst"), "now");

    expect(outcome).toMatchObject({ outcome: "failed", failure: "install" });
    expect(outcome).toHaveProperty("message", expect.stringMatching(/cannot update itself.*0\.6\.0 is on the release page\.$/));
    expect(system.ran.filter(([command]) => command !== "pacman")).toEqual([]);
    expect(system.made).toEqual([]);
  });

  it("installs nothing from a staged build that does not match its SHA-256", async () => {
    const mac = macBundle();
    const system = fakeSystem();
    unzipping(system, "0.6.0");
    const { shell } = await installed("darwin", mac.executable, system);
    const staged = stagedBuild("0.6.0", "agent-harness-desktop-darwin-arm64.zip");
    writeFileSync(staged.path, "another build");

    for (const when of ["now", "quit"] as const) {
      expect(await shell().update.apply(staged, when)).toEqual({
        outcome: "failed",
        failure: "install",
        message: `The staged build at ${staged.path} does not match the SHA-256 0.6.0 was staged with, so 0.5.0 stays installed.`,
      });
    }
    expect(system.ran).toEqual([]);
    expect(mac.build()).toBe("0.5.0");
  });

  it("makes and removes its temporary folders through Node's file calls, and runs no command but the install's own", async () => {
    const mac = macBundle();
    const macSystem = fakeSystem();
    unzipping(macSystem, "0.6.0");
    await (await installed("darwin", mac.executable, macSystem)).shell().update.apply(stagedBuild("0.6.0", "agent-harness-desktop-darwin-arm64.zip"), "now");
    expect(macSystem.made).toHaveLength(1);
    expect(macSystem.removed).toEqual(macSystem.made);

    const archSystem = fakeSystem();
    pacmanOwns(archSystem, "/opt/agent-harness/agent-harness");
    archSystem.answer("pkexec", () => succeeded);
    await (await installed("linux", "/opt/agent-harness/agent-harness", archSystem)).shell().update.apply(stagedBuild("0.6.0", "agent-harness-desktop-linux-x64.pkg.tar.zst"), "now");

    const windowsSystem = fakeSystem();
    const windows = await installed("win32", "C:\\Program Files\\agent-harness\\agent-harness.exe", windowsSystem);
    await windows.shell().update.apply(stagedBuild("0.6.0", "agent-harness-desktop-win32-x64-setup.exe"), "now");
    await windows.electron.app.quitted;

    const commands = [...macSystem.ran, ...archSystem.ran, ...archSystem.started, ...windowsSystem.ran, ...windowsSystem.started].map(([command]) => basename(command ?? ""));
    expect(new Set(commands)).toEqual(new Set(["ditto", "pacman", "pkexec", "agent-harness-desktop-win32-x64-setup.exe"]));
  });
});
