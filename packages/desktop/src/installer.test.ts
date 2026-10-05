import { statfsSync, writeFileSync } from "node:fs";
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
  it("refuses handing a bundle to an older installed environment before that environment can consume the snapshot reserve", async () => {
    const artefact = fakeArtefact("linux");
    const { shell, platform } = await carrying("linux", artefact.root);
    writeFileSync(join(platform.paths.environment, "service-state.json"), JSON.stringify({ activeVersion: "0.4.0" }));
    writeFileSync(join(platform.paths.environment, DATABASE_FILE), "user data");
    vi.mocked(statfsSync).mockReturnValue({ ...statfsSync(platform.paths.environment), bsize: 4096, bavail: 65536 });
    await expect(shell().installer.bundledServer()).rejects.toThrow(/disk space.*staging.*snapshot/i);
    writeFileSync(join(platform.paths.environment, "service-state.json"), JSON.stringify({ activeVersion: "0.5.0" }));
    expect(await shell().installer.bundledServer()).toEqual({ version: "0.5.0", path: artefact.root });
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
