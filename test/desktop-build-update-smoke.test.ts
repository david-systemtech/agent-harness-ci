import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ARTEFACT_CLI_ENTRY, ARTEFACT_CLI_PACKAGE, artefactNode, ReleaseManifest, type DesktopEnvironment } from "../packages/contracts/src/index.js";
import { DARWIN_DESKTOP_ENVIRONMENT, WIN32_DESKTOP_ENVIRONMENT } from "../packages/cli/scripts/release/assets.js";
import { createReleaseChannel, RELEASE_SOURCE, type ReleaseChannelOptions } from "../packages/environment/src/updates/channel.js";
import { sevenZipLengthAt, tarArguments } from "../packages/environment/src/updates/staging.js";

/**
 * The hosted smoke of #2196, `scripts/desktop-build-update-smoke.mjs`: the
 * manifest it serves, read by the real release channel, its failure
 * messages and its tree check; and the fixtures recorded from the v0.1.21
 * release's real artefacts (`test/fixtures/desktop-build`): its manifest,
 * the 7z headers inside its Windows setup and its macOS zip's central
 * directory under the bundled server. The update itself runs on the hosted
 * macOS and Windows runners only.
 */

const fixtures = join(import.meta.dirname, "fixtures", "desktop-build");
const script = pathToFileURL(join(import.meta.dirname, "..", "scripts", "desktop-build-update-smoke.mjs")).href;
const { DESKTOP_ENVIRONMENTS, desktopBuildOf, desktopOnlyManifest, releaseForge, stagedTreeDefect, stagingFailure } = (await import(script)) as {
  DESKTOP_ENVIRONMENTS: Record<"darwin" | "win32", DesktopEnvironment>;
  desktopBuildOf: (platform: string) => { name: string; format: string; environment: DesktopEnvironment };
  desktopOnlyManifest: (options: { version: string; platform: string; launcherProtocol: number; size: number; sha256: string }) => unknown;
  releaseForge: (version: string, files: Map<string, string>) => ReleaseChannelOptions["forge"];
  stagedTreeDefect: (staged: string, expected: readonly string[], version: string, platform?: string) => string | undefined;
  stagingFailure: (platform: string, message: string) => string;
};

const realManifest = ReleaseManifest.parse(JSON.parse(readFileSync(join(fixtures, "release-0.1.21.json"), "utf8")));

let scratch: string | undefined;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});
const fresh = () => (scratch = mkdtempSync(join(tmpdir(), "desktop-build-smoke-")));

/** What the real release channel, on `platform`, stages of a release `version` publishing `manifest` and a small file for each of its assets. */
const stagedBy = async (platform: string, version: string, manifest: unknown) => {
  const folder = fresh();
  const files = new Map<string, string>();
  writeFileSync(join(folder, "release.json"), JSON.stringify(manifest));
  files.set("release.json", join(folder, "release.json"));
  for (const asset of ReleaseManifest.parse(manifest).assets) {
    writeFileSync(join(folder, asset.name), "x");
    files.set(asset.name, join(folder, asset.name));
  }
  const channel = createReleaseChannel({ forge: releaseForge(version, files), source: RELEASE_SOURCE, harnessVersion: "0.0.0-0", platform, databaseSchemaVersion: () => 0 });
  const reading = await channel.read({ autoUpdate: true, channel: "stable", pinnedVersion: null }, { launcherProtocol: 1, failedVersions: [] });
  if (reading.outcome !== "read") throw new Error(reading.message);
  return reading.stage?.artefact ?? null;
};

describe("the desktop-build update smoke's manifest", () => {
  it("names the environment where the release build does", () => {
    expect(DESKTOP_ENVIRONMENTS.darwin).toEqual(DARWIN_DESKTOP_ENVIRONMENT);
    expect(DESKTOP_ENVIRONMENTS.win32).toEqual(WIN32_DESKTOP_ENVIRONMENT);
  });

  for (const platform of ["darwin-arm64", "win32-x64"]) {
    it(`is a release manifest with ${platform}'s desktop build as the real release names it, and no environment asset for ${platform}`, () => {
      const manifest = ReleaseManifest.parse(desktopOnlyManifest({ version: "0.2.0", platform, launcherProtocol: 1, size: 10, sha256: "a".repeat(64) }));
      expect(manifest.assets.filter((asset) => asset.platform === platform && asset.kind === "environment")).toEqual([]);
      const real = realManifest.assets.find((asset) => asset.platform === platform && asset.kind === "desktop");
      const served = manifest.assets.find((asset) => asset.platform === platform && asset.kind === "desktop");
      expect(served).toMatchObject({ name: real?.name, format: real?.format, size: 10, environment: desktopBuildOf(platform).environment });
      // The real release still published this platform's environment asset.
      expect(realManifest.assets.some((asset) => asset.platform === platform && asset.kind === "environment")).toBe(true);
    });

    it(`has the real release channel on ${platform} take the desktop build, and the environment asset while the real release has one`, async () => {
      const served = desktopOnlyManifest({ version: "0.2.0", platform, launcherProtocol: 1, size: 1, sha256: "a".repeat(64) });
      expect(await stagedBy(platform, "0.2.0", served)).toMatchObject({ kind: "desktop", name: desktopBuildOf(platform).name, environment: desktopBuildOf(platform).environment });
      expect(await stagedBy(platform, "0.1.21", realManifest)).toMatchObject({ kind: "environment", platform });
    });
  }
});

describe("the desktop-build update smoke's checks", () => {
  it("says plainly on Windows whether the carve or tar.exe failed, which decides the 7zr.exe fallback", () => {
    expect(stagingFailure("win32-x64", "The artefact at C:\\b\\setup.exe did not unpack: Unrecognized archive format")).toMatch(/^WINDOWS TAR\.EXE CANNOT READ THE SETUP'S 7Z: .*pinned 7zr\.exe fallback.*Unrecognized archive format$/);
    expect(stagingFailure("win32-x64", "The artefact at C:\\b\\setup.exe did not unpack: C:\\b\\setup.exe holds no 7z archive.")).toMatch(/^CARVE FAILED: .*tar\.exe was never tried/);
    expect(stagingFailure("darwin-arm64", "boom")).toBe("Staging the environment from the macOS desktop zip failed: boom");
  });

  it("passes a staged tree with the bundled server's top level, its Node, its CLI and the version, and names what is wrong otherwise", () => {
    const tree = fresh();
    for (const folder of ["bin", "node/bin", "node_modules", "packages/cli/dist"]) mkdirSync(join(tree, folder), { recursive: true });
    writeFileSync(join(tree, "node", "bin", "node"), "");
    writeFileSync(join(tree, "packages", "cli", "dist", "main.js"), "");
    writeFileSync(join(tree, "packages", "cli", "package.json"), JSON.stringify({ version: "0.2.0" }));
    const top = ["packages", "node_modules", "node", "bin"];
    expect(stagedTreeDefect(tree, top, "0.2.0", "darwin")).toBeUndefined();
    expect(stagedTreeDefect(tree, top, "0.3.0", "darwin")).toBe("its CLI declares 0.2.0, not 0.3.0");
    expect(stagedTreeDefect(tree, [...top, "server"], "0.2.0", "darwin")).toMatch(/^its top level is bin, node, node_modules, packages/);
    expect(stagedTreeDefect(tree, top, "0.2.0", "win32")).toMatch(/^it has no Node at .*node\.exe$/);
  });
});

describe("the v0.1.21 desktop builds, as recorded", () => {
  it("has the 7z the carve takes stored whole in the Windows setup, found by its real start and next headers", async () => {
    const setup = JSON.parse(readFileSync(join(fixtures, "win32-setup-0.1.21-7z.json"), "utf8")) as { setupSize: number; startHeaderOffset: number; startHeader: string; nextHeaderOffset: number; nextHeader: string };
    const regions = [
      { at: setup.startHeaderOffset, bytes: Buffer.from(setup.startHeader, "hex") },
      { at: setup.nextHeaderOffset, bytes: Buffer.from(setup.nextHeader, "hex") },
    ];
    /** The setup's bytes as recorded: the two headers where they are, zeros elsewhere. */
    const read = (corrupt?: number) => async (position: number, length: number) => {
      const out = Buffer.alloc(Math.max(0, Math.min(length, setup.setupSize - position)));
      for (const { at, bytes } of regions) for (let i = 0; i < bytes.length; i += 1) if (at + i >= position && at + i < position + out.length) out[at + i - position] = bytes[i]!;
      if (corrupt !== undefined && corrupt >= position && corrupt < position + out.length) out[corrupt - position]! ^= 0xff;
      return out;
    };
    const length = await sevenZipLengthAt(read(), setup.startHeaderOffset, setup.setupSize);
    expect(length).toBe(setup.nextHeaderOffset + setup.nextHeader.length / 2 - setup.startHeaderOffset);
    expect(setup.startHeaderOffset + length!).toBeLessThanOrEqual(setup.setupSize);
    // The archive is nearly all of the setup: the server and the app, stored uncompressed.
    expect(length! / setup.setupSize).toBeGreaterThan(0.99);
    expect(await sevenZipLengthAt(read(setup.nextHeaderOffset + 3), setup.startHeaderOffset, setup.setupSize)).toBeUndefined();
    expect(await sevenZipLengthAt(read(setup.startHeaderOffset + 13), setup.startHeaderOffset, setup.setupSize)).toBeUndefined();
  });

  it("has the macOS zip hold the bundled server where the release names it, a server artefact's top level once stripped", () => {
    const zip = JSON.parse(readFileSync(join(fixtures, "darwin-zip-0.1.21-server.json"), "utf8")) as { prefix: string; serverTopLevel: string[]; members: string[]; entries: number; serverEntries: number };
    expect(zip.prefix).toBe(`${DARWIN_DESKTOP_ENVIRONMENT.path}/`);
    const args = tarArguments("desktop.zip", "into", DARWIN_DESKTOP_ENVIRONMENT);
    const strip = Number(args[args.indexOf("--strip-components") + 1]);
    const stripped = zip.members.map((member) => member.split("/").slice(strip).join("/"));
    expect(stripped).toEqual(expect.arrayContaining([artefactNode("darwin").join("/"), ARTEFACT_CLI_ENTRY.join("/"), ARTEFACT_CLI_PACKAGE.join("/")]));
    expect(zip.serverTopLevel).toEqual(["bin", "node", "node_modules", "packages"]);
    // Nearly every entry of the zip is the server's: the unpack the limits are set for (#2196).
    expect(zip.serverEntries / zip.entries).toBeGreaterThan(0.9);
  });
});
