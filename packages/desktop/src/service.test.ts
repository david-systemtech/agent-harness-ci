import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serviceFailureOf, type ServiceFailure, type ShellPlatform } from "@agent-harness/client-runtime";
import { fakeArtefact, type FakeArtefact } from "../test/fake-artefact.js";
import { fakeElectron } from "../test/fake-electron.js";
import { cleanUp, platformOn, scratch, start } from "../test/harness.js";
import type { DesktopPlatform } from "./platform.js";

afterEach(cleanUp);

/**
 * The shell's `service` (docs/specs/gui.md, "The desktop shell"): the
 * `service` verbs of the server artefact the desktop carries, run with the
 * artefact's own Node, so one install gives David the window and this
 * machine's environment. Driven over a fake artefact whose CLI answers from
 * a service manager kept in a file.
 */

const STATUS = ["service", "status", "--json"];
/** Looks every few milliseconds where the desktop looks every second; still waits a minute, so a loaded runner's slow spawns never run it out. */
const QUICK = { everyMs: 5, forMs: 60_000 };

/** The failure a shell call rejected with, as the window reads it on its side of the bridge. */
const failureOf = (call: Promise<unknown>): Promise<ServiceFailure | undefined> =>
  call.then(() => undefined, (error: unknown) => serviceFailureOf(error));

/** The desktop on `os`, carrying `artefact`. */
const carrying = (os: ShellPlatform, artefact: FakeArtefact): DesktopPlatform => {
  const platform = platformOn(os);
  return { ...platform, paths: { ...platform.paths, server: artefact.root } };
};

describe("service", () => {
  it("reads and applies a pending update with the installed version's CLI through the shell bridge", async () => {
    const pending = {
      state: "waiting", updateId: "0199aa00-0000-4000-8000-00000000000a", toVersion: "0.6.0", source: "desktop",
      since: "2026-09-24T00:00:00.000Z", deferUntil: "2026-09-25T00:00:00.000Z", image: null,
      waitsOn: { reason: "recent-activity", until: "2026-09-24T00:10:00.000Z" },
    } as const;
    for (const os of ["linux", "darwin", "win32"] as const) {
      const carried = fakeArtefact(os);
      const installed = fakeArtefact(os, { pendingUpdate: pending });
      const platform = carrying(os, carried);
      const data = platform.paths.environment;
      mkdirSync(join(data, "versions"), { recursive: true });
      symlinkSync(installed.root, join(data, "versions", "0.5.0"));
      writeFileSync(join(installed.root, ".complete"), "");
      writeFileSync(join(data, "service-state.json"), JSON.stringify({ activeVersion: "0.5.0" }));
      const { shell } = await start({ electron: fakeElectron({ os }), platform });
      expect(await shell().service.pendingUpdate!()).toEqual(pending);
      await shell().service.applyUpdateNow!();
      expect(installed.runs()).toEqual([
        ["update", "status", "--json", "--data-dir", data],
        ["update", "apply", "--now", "--data-dir", data],
      ]);
      expect(carried.runs()).toEqual([]);
    }
  });

  it("installs from the artefact when nothing is installed, starts it, and settles once the environment answers", async () => {
    const artefact = fakeArtefact("linux", { answersAfter: 2 });
    const { shell } = await start({ platform: carrying("linux", artefact), serviceWait: QUICK });

    await shell().service.start();

    expect(artefact.runs()).toEqual([STATUS, ["service", "install"], ["service", "start"], STATUS, STATUS, STATUS]);
    expect(artefact.state()).toMatchObject({ installed: true, running: true, readiness: "starting" });
  });

  it("starts an installed service without installing it again, and starts none already running", async () => {
    const artefact = fakeArtefact("linux", { installed: true });
    const { shell } = await start({ platform: carrying("linux", artefact), serviceWait: QUICK });

    await shell().service.start();
    expect(artefact.runs()).toEqual([STATUS, ["service", "start"], STATUS]);

    await shell().service.start();
    expect(artefact.runs().slice(3)).toEqual([STATUS]);
  });

  it("reports whether the service is installed, running and ready, and installs it when asked", async () => {
    const artefact = fakeArtefact("linux");
    const { shell } = await start({ platform: carrying("linux", artefact), serviceWait: QUICK });

    expect(await shell().service.status()).toEqual({ installed: false, running: false, ready: false });
    await shell().service.install();
    expect(await shell().service.status()).toEqual({ installed: true, running: false, ready: false });
    artefact.set({ running: true, readiness: "ready" });
    expect(await shell().service.status()).toEqual({ installed: true, running: true, ready: true });
    expect(artefact.runs()).toEqual([STATUS, ["service", "install"], STATUS, STATUS]);
  });

  it("runs the artefact's own Node where each platform's artefact keeps it", async () => {
    for (const os of ["win32", "darwin"] as const) {
      const artefact = fakeArtefact(os, { installed: true, running: true, readiness: "ready" });
      const { shell } = await start({ electron: fakeElectron({ os }), platform: carrying(os, artefact), serviceWait: QUICK });
      expect(await shell().service.status()).toEqual({ installed: true, running: true, ready: true });
    }
  });

  it("says in one line why the install or the start failed, and that an install went through before a start that failed", async () => {
    const refused = fakeArtefact("linux", { fails: { verb: "install", message: "agent-harness refuses to run as root." } });
    const first = await start({ platform: carrying("linux", refused), serviceWait: QUICK });
    await expect(first.shell().service.start()).rejects.toThrow("Could not install the environment on this machine: agent-harness refuses to run as root.");
    await expect(first.shell().service.install()).rejects.toThrow("Could not install the environment on this machine: agent-harness refuses to run as root.");

    const stopped = fakeArtefact("linux", { fails: { verb: "start", message: "Could not run systemctl: no user manager." } });
    const second = await start({ platform: carrying("linux", stopped), serviceWait: QUICK });
    await expect(second.shell().service.start()).rejects.toThrow("Installed, but starting it failed: Could not run systemctl: no user manager.");
    expect(stopped.state()).toMatchObject({ installed: true, running: false });
  });

  it("names the kind of each failure beside its text, across the bridge", async () => {
    const refused = await start({ platform: carrying("linux", fakeArtefact("linux", { fails: { verb: "install", message: "agent-harness refuses to run as root." } })), serviceWait: QUICK });
    expect(await failureOf(refused.shell().service.install())).toEqual({ kind: "install", text: "Could not install the environment on this machine: agent-harness refuses to run as root." });
    expect(await failureOf(refused.shell().service.start())).toMatchObject({ kind: "install" });

    const stopped = await start({ platform: carrying("linux", fakeArtefact("linux", { installed: true, fails: { verb: "start", message: "Could not run systemctl: no user manager." } })), serviceWait: QUICK });
    expect(await failureOf(stopped.shell().service.start())).toEqual({ kind: "start", text: "Could not start the environment on this machine: Could not run systemctl: no user manager." });

    const unread = await start({ platform: carrying("linux", fakeArtefact("linux", { fails: { verb: "status", message: "No user service manager." } })), serviceWait: QUICK });
    expect(await failureOf(unread.shell().service.status())).toEqual({ kind: "status", text: "Could not read the service's status: No user service manager." });
    expect(await failureOf(unread.shell().service.start())).toMatchObject({ kind: "status" });

    const silent = await start({ platform: carrying("linux", fakeArtefact("linux", { startsAs: null })), serviceWait: { everyMs: 5, forMs: 60 } });
    expect(await failureOf(silent.shell().service.start())).toMatchObject({ kind: "no-answer" });

    const platform = platformOn("linux");
    const broken = await start({ platform: { ...platform, paths: { ...platform.paths, server: scratch() } }, serviceWait: QUICK });
    expect(await failureOf(broken.shell().service.status())).toMatchObject({ kind: "unrunnable", text: expect.stringMatching(/could not be run/) });
    expect(await failureOf(broken.shell().service.start())).toMatchObject({ kind: "unrunnable" });

    const bare = await start();
    expect(await failureOf(bare.shell().service.start())).toMatchObject({ kind: "no-artefact", text: expect.stringMatching(/carries no server artefact/) });
    expect(await failureOf(bare.shell().service.install())).toMatchObject({ kind: "no-artefact" });
  });

  it.each([
    ["install", "stderr"], ["install", "stdout"], ["start", "stderr"], ["start", "stdout"],
  ] as const)("reports the first error when %s crashes on %s, before its stack and runtime version", async (verb, stream) => {
    const cause = "Error: EACCES: permission denied, copying the server artefact";
    const artefact = fakeArtefact("linux", { installed: verb === "start", fails: { verb, stream, message: [
      "node:internal/fs/cp/cp-sync:91",
      "  throw error;",
      "",
      cause,
      "    at copyFileSync (node:fs:3091:11)",
      "Node.js v24.21.0",
    ].join("\n") } });
    const { shell } = await start({ platform: carrying("linux", artefact), serviceWait: QUICK });
    const prefix = verb === "install" ? "Could not install the environment on this machine: " : "Could not start the environment on this machine: ";
    await expect(shell().service[verb]()).rejects.toThrow(`${prefix}${cause}`);
  });

  it("reports the first error from a failed status command, including Node's missing-package cause before its stack and version", async () => {
    const cause = "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@agent-harness/contracts' imported from /fixture/packages/cli/dist/cli.js";
    const artefact = fakeArtefact("linux", { fails: { verb: "status", message: [
      "(node:1) Warning: a runtime warning",
      "node:internal/modules/package_json_reader:316",
      "  throw new ERR_MODULE_NOT_FOUND(packageName);",
      "        ^",
      "",
      cause,
      "    at Object.getPackageJSONURL (node:internal/modules/package_json_reader:316:9)",
      "Node.js v24.21.0",
    ].join("\r\n") } });
    const { shell } = await start({ platform: carrying("linux", artefact), serviceWait: QUICK });
    await expect(shell().service.status()).rejects.toThrow(`Could not read the service's status: ${cause}`);
    await expect(shell().service.start()).rejects.toThrow(`Could not read the service's status: ${cause}`);
  });

  it.each([
    ["\r\nNo user service manager.\r\nMore detail.\r\n", "No user service manager."],
    ["\n \n", "`service status` exited with 1."],
  ])("reports a status refusal or its exit code when there is no error heading", async (message, reason) => {
    const artefact = fakeArtefact("linux", { fails: { verb: "status", message } });
    const { shell } = await start({ platform: carrying("linux", artefact), serviceWait: QUICK });
    await expect(shell().service.status()).rejects.toThrow(`Could not read the service's status: ${reason}`);
  });

  // The one test whose wait runs out: it runs out whatever the runner's load, and what it asserts is the giving up.
  it("stops waiting when the environment does not answer, and says where to look", async () => {
    const artefact = fakeArtefact("linux", { startsAs: null });
    const { shell } = await start({ platform: carrying("linux", artefact), serviceWait: { everyMs: 5, forMs: 60 } });
    await expect(shell().service.start()).rejects.toThrow(/did not answer.*agent-harness service status/);
    expect(artefact.state()).toMatchObject({ installed: true, running: true });
  });

  it("runs one verb at a time: a second start waits for the first, and finds the service running", async () => {
    const artefact = fakeArtefact("linux");
    const { shell } = await start({ platform: carrying("linux", artefact), serviceWait: QUICK });
    await Promise.all([shell().service.start(), shell().service.start()]);
    expect(artefact.runs().filter(([, verb]) => verb === "install")).toHaveLength(1);
    expect(artefact.runs().filter(([, verb]) => verb === "start")).toHaveLength(1);
  });

  it("says so when the desktop carries no server artefact, as when it runs from a checkout", async () => {
    const { shell } = await start();
    await expect(shell().service.start()).rejects.toThrow(/carries no server artefact/);
    await expect(shell().service.status()).rejects.toThrow(/carries no server artefact/);
  });
});
