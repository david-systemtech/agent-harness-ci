import { afterEach, describe, expect, it } from "vitest";
import type { ShellPlatform } from "@agent-harness/client-runtime";
import { fakeArtefact, type FakeArtefact } from "../test/fake-artefact.js";
import { fakeElectron } from "../test/fake-electron.js";
import { cleanUp, platformOn, start } from "../test/harness.js";
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
/** Waits a few milliseconds between looks, and half a second in all, where the desktop waits a second and a minute. */
const QUICK = { everyMs: 5, forMs: 500 };

/** The desktop on `os`, carrying `artefact`. */
const carrying = (os: ShellPlatform, artefact: FakeArtefact): DesktopPlatform => {
  const platform = platformOn(os);
  return { ...platform, paths: { ...platform.paths, server: artefact.root } };
};

describe("service", () => {
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
