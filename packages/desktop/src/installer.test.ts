import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ShellPlatform } from "@agent-harness/client-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { fakeArtefact } from "../test/fake-artefact.js";
import { fakeElectron } from "../test/fake-electron.js";
import { cleanUp, platformOn, start } from "../test/harness.js";

afterEach(cleanUp);

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
