import { statfsSync, writeFileSync } from "node:fs";
import { readFile, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { ShellPlatform } from "@agent-harness/client-runtime";
import { DATABASE_FILE } from "@agent-harness/contracts/launcher";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeArtefact } from "../test/fake-artefact.js";
import { fakeElectron } from "../test/fake-electron.js";
import { cleanUp, platformOn, start } from "../test/harness.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<{ statfsSync: typeof statfsSync }>();
  return { ...fs, statfsSync: vi.fn(fs.statfsSync) };
});
afterEach(() => { cleanUp(); vi.mocked(statfsSync).mockReset(); });

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<{ readFile: typeof readFile; statfs: typeof statfs }>();
  return { ...fs, statfs: vi.fn(fs.statfs) };
});

/**
 * The shell's `installer` (launcher-update spec, "The desktop moves with its
 * local environment"): the server artefact the desktop carries, which the
 * runtime hands its local environment so that nothing downloads twice.
 */

/** The desktop on `os`, carrying the server artefact unpacked at `server`. */
const carrying = (os: ShellPlatform, server: string) => {
  const platform = platformOn(os);
  return start({ electron: fakeElectron({ os }), platform: { ...platform, paths: { ...platform.paths, server } } });
};

describe("installer", () => {
  it("reports space available to the user on the environment data volume, with the launcher reserve, through the shell", async () => {
    const platform = platformOn("darwin");
    const { shell } = await start({ platform });
    vi.mocked(statfs).mockImplementationOnce(async (path) => ({
      type: 0, bsize: 4096, frsize: 4096, blocks: 100000, bfree: 65536,
      bavail: path === platform.paths.environment ? 48795 : 0, files: 0, ffree: 0,
    }));
    expect(await shell().installer.reserveSpace!()).toEqual({ availableBytes: 199864320, requiredBytes: 268435456 });
  });


  it("refuses handing a bundle to an older installed environment before that environment can consume the snapshot reserve", async () => {
    const artefact = fakeArtefact("linux");
    const { shell, platform } = await carrying("linux", artefact.root);
    writeFileSync(join(platform.paths.environment, "service-state.json"), JSON.stringify({ activeVersion: "0.4.0" }));
    writeFileSync(join(platform.paths.environment, DATABASE_FILE), "user data");
    vi.mocked(statfsSync).mockReturnValue({ ...statfsSync(platform.paths.environment), bsize: 4096, bavail: 65536 });
    expect(await shell().installer.bundledServer()).toEqual({
      version: "0.5.0", path: artefact.root,
      refusal: { reason: "disk", message: expect.stringMatching(/disk space.*staging.*snapshot/i) as unknown as string },
    });
    vi.mocked(statfsSync).mockReturnValue({ ...statfsSync(platform.paths.environment), bsize: 4096, bavail: 262144 });
    expect(await shell().installer.bundledServer()).toEqual({ version: "0.5.0", path: artefact.root });
    vi.mocked(statfsSync).mockReturnValue({ ...statfsSync(platform.paths.environment), bsize: 4096, bavail: 65536 });
    writeFileSync(join(platform.paths.environment, "service-state.json"), JSON.stringify({ activeVersion: "0.5.0" }));
    expect(await shell().installer.bundledServer()).toEqual({ version: "0.5.0", path: artefact.root });
  });

  it("keeps filesystem probe errors as shell failures rather than disk-space refusals", async () => {
    const artefact = fakeArtefact("linux");
    const { shell, platform } = await carrying("linux", artefact.root);
    writeFileSync(join(platform.paths.environment, "service-state.json"), JSON.stringify({ activeVersion: "0.4.0" }));
    vi.mocked(statfsSync).mockImplementationOnce(() => { throw new Error("EACCES: data volume unavailable"); });
    await expect(shell().installer.bundledServer()).rejects.toThrow("EACCES: data volume unavailable");
  });

  it("answers the version and the path of the server artefact the desktop carries, on every platform", async () => {
    for (const os of ["darwin", "win32", "linux"] as const) {
      const artefact = fakeArtefact(os);
      const { shell } = await carrying(os, artefact.root);
      expect(await shell().installer.bundledServer()).toEqual({ version: "0.5.0", path: artefact.root });
    }
  });

  it("answers null for a desktop that carries none, as one run from a checkout", async () => {
    const { shell } = await start();
    expect(await shell().installer.bundledServer()).toBeNull();
  });

  it("says so when the artefact it carries names no release version", async () => {
    const artefact = fakeArtefact("linux");
    const cli = join(artefact.root, "packages", "cli", "package.json");
    writeFileSync(cli, JSON.stringify({ name: "@agent-harness/cli", version: "0.0.0-dev+local stamp" }));
    const { shell } = await carrying("linux", artefact.root);
    await expect(shell().installer.bundledServer()).rejects.toThrow(`The server artefact this desktop carries names no release version in ${cli}.`);

    writeFileSync(cli, "{");
    await expect(shell().installer.bundledServer()).rejects.toThrow(`The server artefact this desktop carries names no release version in ${cli}.`);
  });
});
