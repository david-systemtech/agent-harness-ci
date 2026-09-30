import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { LAUNCHER_PROTOCOL, PROTOCOL_VERSION, ReleaseManifest } from "@agent-harness/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { declaredVersion } from "../../src/launch/versions.js";
import { FIXTURE_IMAGE, fixtureBuild, fixtureReport, type FixtureBuild } from "../../test/release-fixtures.js";
import { buildOptionsOf } from "./arguments.js";
import { buildRelease } from "./build.js";
import { withoutNode } from "./verify.js";

/**
 * The release build (launcher-update spec, "The release"; #356), run over a
 * fixture workspace: its packages built, its dependencies installed as pnpm's
 * hoisted linker lays them out, Node's archives and the host's check faked,
 * and observed through what it writes: the artefacts unpacked, their
 * sidecars and `release.json`. What only a real build shows is its run on a
 * runner and the manual checklist.
 */

let build: FixtureBuild;
afterEach(() => build?.remove());

/**
 * Unpacks the artefact `name` from the build's output into a fresh folder,
 * and answers the folder: a gzipped tar with `tar`, as the environment's
 * staging and the install script do; a zip with Python's zipfile, a reader
 * the build's own zip code has no part in, which checks every file's CRC.
 */
const unpack = (name: string): string => {
  const into = join(build.out, "..", "unpacked", name);
  mkdirSync(into, { recursive: true });
  const archive = join(build.out, name);
  if (name.endsWith(".zip")) execFileSync("python3", ["-c", "import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nz.extractall(sys.argv[2])", archive, into]);
  else execFileSync("tar", ["-xf", archive, "-C", into]);
  return into;
};

/** Every file and folder under `root` that is a link, relative to it. */
const links = (root: string): string[] =>
  readdirSync(root, { recursive: true, encoding: "utf8" }).filter((path) => lstatSync(join(root, path)).isSymbolicLink());

const text = (path: string): string => readFileSync(path, "utf8");
const executable = (path: string): boolean => (statSync(path).mode & 0o111) !== 0;

/** Each test builds, packs and unpacks; the host's check runs the artefact's processes. Generous for a loaded CI runner. */
const BUILD_MS = 120_000;

describe("the release build", { timeout: BUILD_MS }, () => {
  it("refuses a tag that is not v and a semantic version, before it builds anything", async () => {
    build = fixtureBuild();
    for (const tag of ["0.5.0", "v0.5", "release-0.5.0", "v01.0.0", ""]) {
      await expect(buildRelease(build.options({ tag }), build.seams), tag).rejects.toThrow(/is not v and a semantic version/);
    }
    expect(build.compiled).toBe(0);
    expect(existsSync(build.out) ? readdirSync(build.out) : []).toEqual([]);
  });

  it("builds the linux-x64 artefact as agent-harness-linux-x64.tar.gz: its own Node, the CLI in packages/cli, the packages it runs and their production dependencies in node_modules, and bin/agent-harness", async () => {
    build = fixtureBuild();
    await buildRelease(build.options({ platforms: ["linux-x64"] }), build.seams);
    const root = unpack("agent-harness-linux-x64.tar.gz");
    expect(readdirSync(root).sort()).toEqual(["bin", "node", "node_modules", "packages"]);
    expect(build.downloaded).toEqual(["https://nodejs.org/dist/v24.0.0/node-v24.0.0-linux-x64.tar.gz"]);
    expect(executable(join(root, "node", "bin", "node"))).toBe(true);
    expect(readdirSync(join(root, "node"), { recursive: true }).sort()).toEqual(["LICENSE", "bin", "bin/node"]);
    expect(readdirSync(join(root, "packages"))).toEqual(["cli"]);
    expect(text(join(root, "packages", "cli", "dist", "main.js"))).toBe(text(join(build.root, "packages", "cli", "dist", "main.js")));
    expect(readdirSync(join(root, "node_modules", "@agent-harness")).sort()).toEqual(["contracts", "environment"]);
    expect(text(join(root, "node_modules", "@agent-harness", "environment", "dist", "index.js"))).toBe(text(join(build.root, "packages", "environment", "dist", "index.js")));
    expect(existsSync(join(root, "node_modules", "@agent-harness", "environment", "node_modules"))).toBe(false);
    expect(readdirSync(join(root, "node_modules")).filter((name) => name.startsWith("."))).toEqual([]);
    expect(existsSync(join(root, "node_modules", "zod", "package.json"))).toBe(true);
    expect(links(root)).toEqual([]);
  });

  it("carries node-pty compiled for Linux on the build's own runner and no prebuild, and the SDK's Claude binary for linux-x64 alone", async () => {
    build = fixtureBuild();
    await buildRelease(build.options({ platforms: ["linux-x64"] }), build.seams);
    const pty = join(unpack("agent-harness-linux-x64.tar.gz"), "node_modules", "node-pty");
    expect(text(join(pty, "build", "Release", "pty.node"))).toBe("elf pty for linux-x64\n");
    expect(existsSync(join(pty, "prebuilds"))).toBe(false);
    const sdk = join(pty, "..", "@anthropic-ai");
    expect(readdirSync(sdk).sort()).toEqual(["claude-agent-sdk", "claude-agent-sdk-linux-x64"]);
    expect(executable(join(sdk, "claude-agent-sdk-linux-x64", "claude"))).toBe(true);
  });

  it("runs its own Node on its CLI from bin/agent-harness, wherever it is unpacked and by whatever path it is run", async () => {
    build = fixtureBuild();
    await buildRelease(build.options({ platforms: ["linux-x64"] }), build.seams);
    const root = unpack("agent-harness-linux-x64.tar.gz");
    const bin = join(root, "bin", "agent-harness");
    expect(executable(bin)).toBe(true);
    const where = { node: "node 24.0.0 for linux-x64", entry: join(realpathSync(root), "packages", "cli", "dist", "main.js"), args: ["--port", "7433"] };
    expect(JSON.parse(execFileSync(bin, ["where", "--port", "7433"], { encoding: "utf8" }))).toEqual(where);
    expect(JSON.parse(execFileSync("sh", [relative(join(root, ".."), bin), "where", "--port", "7433"], { cwd: join(root, ".."), encoding: "utf8" }))).toEqual(where);
    expect(execFileSync(bin, ["--version"], { encoding: "utf8" })).toBe("agent-harness 0.5.0\n");
  });

  it("stamps the tag's version into every package it carries, the CLI keeping the launcher protocol the launcher reads beside it, and leaves the workspace as it was", async () => {
    build = fixtureBuild();
    await buildRelease(build.options({ tag: "v1.2.0-beta.3", platforms: ["linux-x64"] }), build.seams);
    const root = unpack("agent-harness-linux-x64.tar.gz");
    expect(declaredVersion(root)).toEqual({ version: "1.2.0-beta.3", launcherProtocol: LAUNCHER_PROTOCOL });
    for (const name of ["contracts", "environment"]) {
      expect(JSON.parse(text(join(root, "node_modules", "@agent-harness", name, "package.json")))).toMatchObject({ name: `@agent-harness/${name}`, version: "1.2.0-beta.3" });
    }
    expect(JSON.parse(text(join(build.root, "packages", "cli", "package.json")))).toMatchObject({ version: "0.0.0" });
  });

  it("builds the darwin-arm64 artefact on a Linux runner: macOS's Node, node-pty's darwin-arm64 prebuild alone with its helper made executable, and the SDK's darwin-arm64 Claude binary", async () => {
    build = fixtureBuild();
    await buildRelease(build.options({ platforms: ["linux-x64", "darwin-arm64"] }), build.seams);
    const root = unpack("agent-harness-darwin-arm64.tar.gz");
    expect(readdirSync(root).sort()).toEqual(["bin", "node", "node_modules", "packages"]);
    expect(build.downloaded).toContain("https://nodejs.org/dist/v24.0.0/node-v24.0.0-darwin-arm64.tar.gz");
    expect(text(join(root, "node", "bin", "node"))).toContain("for darwin-arm64");
    const pty = join(root, "node_modules", "node-pty");
    expect(readdirSync(join(pty, "prebuilds"))).toEqual(["darwin-arm64"]);
    expect(existsSync(join(pty, "build"))).toBe(false);
    expect(executable(join(pty, "prebuilds", "darwin-arm64", "spawn-helper"))).toBe(true);
    expect(readdirSync(join(root, "node_modules", "@anthropic-ai")).sort()).toEqual(["claude-agent-sdk", "claude-agent-sdk-darwin-arm64"]);
    expect(executable(join(root, "bin", "agent-harness"))).toBe(true);
  });

  it("builds the win32-x64 artefact on a Linux runner as agent-harness-win32-x64.zip: node\\node.exe, bin\\agent-harness.cmd, node-pty's win32-x64 prebuild without its debug symbols, the SDK's claude.exe, and no link", async () => {
    build = fixtureBuild();
    await buildRelease(build.options({ platforms: ["linux-x64", "win32-x64"] }), build.seams);
    expect(readdirSync(build.out)).toContain("agent-harness-win32-x64.zip");
    const root = unpack("agent-harness-win32-x64.zip");
    expect(readdirSync(root).sort()).toEqual(["bin", "node", "node_modules", "packages"]);
    expect(build.downloaded).toContain("https://nodejs.org/dist/v24.0.0/node-v24.0.0-win-x64.zip");
    expect(readdirSync(join(root, "node")).sort()).toEqual(["LICENSE", "node.exe"]);
    expect(readdirSync(join(root, "bin"))).toEqual(["agent-harness.cmd"]);
    expect(text(join(root, "bin", "agent-harness.cmd"))).toBe(
      '@echo off\r\nrem agent-harness: this release\'s CLI on its own Node, from wherever the artefact is unpacked.\r\n"%~dp0..\\node\\node.exe" "%~dp0..\\packages\\cli\\dist\\main.js" %*\r\nexit /b %ERRORLEVEL%\r\n',
    );
    const pty = join(root, "node_modules", "node-pty");
    expect(readdirSync(join(pty, "prebuilds", "win32-x64"), { recursive: true }).sort()).toEqual(["conpty", "conpty/conpty.dll", "pty.node"]);
    expect(readdirSync(join(pty, "prebuilds"))).toEqual(["win32-x64"]);
    expect(readdirSync(join(root, "node_modules", "@anthropic-ai")).sort()).toEqual(["claude-agent-sdk", "claude-agent-sdk-win32-x64"]);
    expect(existsSync(join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk-win32-x64", "claude.exe"))).toBe(true);
    expect(declaredVersion(root)).toEqual({ version: "0.5.0", launcherProtocol: LAUNCHER_PROTOCOL });
    expect(links(root)).toEqual([]);
  });

  it("writes a sidecar beside every asset in #113's format, and release.json: the host artefact's preflight identity, each artefact's name, kind, platform, format, size and SHA-256, and the image it was given, which the contracts' schema reads back whole", async () => {
    build = fixtureBuild();
    await buildRelease(build.options(), build.seams);
    const artefacts = ["agent-harness-linux-x64.tar.gz", "agent-harness-darwin-arm64.tar.gz", "agent-harness-win32-x64.zip"];
    expect(readdirSync(build.out).sort()).toEqual([...artefacts, "release.json"].flatMap((name) => [name, `${name}.sha256`]).sort());
    for (const name of [...artefacts, "release.json"]) {
      expect(execFileSync("sha256sum", ["-c", `${name}.sha256`], { cwd: build.out, encoding: "utf8" })).toBe(`${name}: OK\n`);
    }
    const digest = (name: string) => text(join(build.out, `${name}.sha256`)).split(" ", 1)[0];
    const size = (name: string) => statSync(join(build.out, name)).size;
    const manifest = JSON.parse(text(join(build.out, "release.json"))) as unknown;
    expect(manifest).toEqual({
      version: "0.5.0",
      protocolVersion: PROTOCOL_VERSION,
      launcherProtocol: LAUNCHER_PROTOCOL,
      databaseSchemaVersion: 17,
      bundledClaudeCodeVersion: "2.1.283 (Claude Code)",
      assets: [
        { name: artefacts[0], kind: "environment", platform: "linux-x64", format: "tar.gz", size: size(artefacts[0] ?? ""), sha256: digest(artefacts[0] ?? "") },
        { name: artefacts[1], kind: "environment", platform: "darwin-arm64", format: "tar.gz", size: size(artefacts[1] ?? ""), sha256: digest(artefacts[1] ?? "") },
        { name: artefacts[2], kind: "environment", platform: "win32-x64", format: "zip", size: size(artefacts[2] ?? ""), sha256: digest(artefacts[2] ?? "") },
      ],
      image: FIXTURE_IMAGE,
    });
    expect(ReleaseManifest.parse(manifest)).toEqual(manifest);
    expect(build.verified.map(({ archive, target }) => [basename(archive), target.platform])).toEqual([[artefacts[0], "linux-x64"]]);
  });

  it("refuses, before it builds anything, to run where it builds no artefact to check, an image the manifest cannot name, and an output folder that is not empty", async () => {
    build = fixtureBuild({ host: "linux-arm64" });
    await expect(buildRelease(build.options(), build.seams)).rejects.toThrow(/runs on linux-arm64, whose artefact it does not build/);
    build.remove();
    build = fixtureBuild();
    await expect(buildRelease(build.options({ platforms: ["darwin-arm64"] }), build.seams)).rejects.toThrow(/runs on linux-x64, whose artefact it does not build/);
    await expect(buildRelease(build.options({ image: { ...FIXTURE_IMAGE, digest: "sha256:abc" } }), build.seams)).rejects.toThrow(/image/);
    await expect(buildRelease(build.options({ image: { ...FIXTURE_IMAGE, reference: "" } }), build.seams)).rejects.toThrow(/image/);
    await expect(buildRelease(build.options({ platforms: ["linux-x64", "linux-arm64"] }), build.seams)).rejects.toThrow(/No artefact is built for linux-arm64/);
    mkdirSync(build.out, { recursive: true });
    writeFileSync(join(build.out, "stale.tar.gz"), "from an earlier run\n");
    await expect(buildRelease(build.options(), build.seams)).rejects.toThrow(/is not empty/);
    expect(build.compiled).toBe(0);
  });

  it("fails when the host artefact's preflight reports another version than the tag's, and writes no release.json", async () => {
    build = fixtureBuild();
    await expect(buildRelease(build.options({ platforms: ["linux-x64"] }), { ...build.seams, verify: async () => fixtureReport("0.4.9") })).rejects.toThrow(
      /reports the version 0.4.9, not 0.5.0/,
    );
    expect(existsSync(join(build.out, "release.json"))).toBe(false);
  });

  it("builds the linux-x64 artefact only on a linux-x64 runner, where node-pty compiles, since its npm package has no Linux prebuild", async () => {
    build = fixtureBuild({ host: "darwin-arm64" });
    await expect(buildRelease(build.options({ platforms: ["linux-x64", "darwin-arm64"] }), build.seams)).rejects.toThrow(
      /node-pty has no prebuild for linux-x64.*build the linux-x64 artefact on one/,
    );
  });

  it("refuses a Node archive whose SHA-256 is not the pinned one, and keeps none of it", async () => {
    build = fixtureBuild();
    const pinned = build.seams.nodeRuntime ?? { version: "", sha256: {} };
    const seams = { ...build.seams, nodeRuntime: { ...pinned, sha256: { ...pinned.sha256, "linux-x64": "1".repeat(64) } } };
    await expect(buildRelease(build.options({ platforms: ["linux-x64"] }), seams)).rejects.toThrow(/node-v24.0.0-linux-x64.tar.gz has the SHA-256 [0-9a-f]{64}, not the pinned 1{64}/);
    expect(readdirSync(build.out)).toEqual([]);
  });
});

describe("the host's artefact", { timeout: BUILD_MS }, () => {
  it("is unpacked and run on the runner with no Node on the path, as an ordinary user: --version, preflight, and serve's discovery and health name the tag's version, and the release's identity is its preflight report", async () => {
    build = fixtureBuild({ runHostArtefact: true });
    await buildRelease(build.options({ tag: "v0.6.1", platforms: ["linux-x64", "darwin-arm64"] }), build.seams);
    const { assets, ...identity } = JSON.parse(text(join(build.out, "release.json"))) as ReleaseManifest;
    expect(identity).toEqual({ ...fixtureReport("0.6.1"), image: FIXTURE_IMAGE });
    expect(assets.map((asset) => asset.name)).toEqual(["agent-harness-linux-x64.tar.gz", "agent-harness-darwin-arm64.tar.gz"]);
  });

  it("fails the build when serve's discovery or health names another version than the tag's", async () => {
    build = fixtureBuild({ runHostArtefact: true, quirks: { discoveryVersion: "0.0.0" } });
    await expect(buildRelease(build.options({ platforms: ["linux-x64"] }), build.seams)).rejects.toThrow(/discovery document names the version 0.0.0, not 0.5.0/);
    build.remove();
    build = fixtureBuild({ runHostArtefact: true, quirks: { healthVersion: "0.0.0" } });
    await expect(buildRelease(build.options({ platforms: ["linux-x64"] }), build.seams)).rejects.toThrow(/health answer names the version 0.0.0, not 0.5.0/);
    expect(existsSync(join(build.out, "release.json"))).toBe(false);
  });

  it("fails the build when the Claude binary its environment would run is not inside it", async () => {
    build = fixtureBuild({ runHostArtefact: true, quirks: { claudeOutside: "/usr/bin/env" } });
    await expect(buildRelease(build.options({ platforms: ["linux-x64"] }), build.seams)).rejects.toThrow(/Claude binary resolves to \/usr\/bin\/env, outside the artefact/);
  });

  it("runs with a path that keeps every folder but those holding a node", () => {
    const withNode = new Set(["/usr/local/bin/node", "/opt/node/bin/node.exe"]);
    expect(withoutNode(["/home/me/bin", "/usr/local/bin", "/usr/bin", "", "/opt/node/bin", "/bin"].join(":"), (path) => withNode.has(path))).toBe("/home/me/bin:/usr/bin:/bin");
  });
});

describe("the build's command line", () => {
  it("takes the tag, the output folder, the image's reference and digest, and platforms to build, the folder read from where pnpm was run", () => {
    const args = ["--tag", "v0.5.0", "--out", "release", "--image-reference", FIXTURE_IMAGE.reference, "--image-digest", FIXTURE_IMAGE.digest];
    expect(buildOptionsOf(args, "/work/checkout")).toEqual({ tag: "v0.5.0", out: "/work/checkout/release", image: FIXTURE_IMAGE });
    expect(buildOptionsOf([...args, "--platform", "linux-x64", "--platform", "win32-x64"], "/work")).toMatchObject({ platforms: ["linux-x64", "win32-x64"] });
  });

  it("refuses arguments missing one it needs, or one it does not know", () => {
    expect(() => buildOptionsOf(["--tag", "v0.5.0", "--out", "release"], "/work")).toThrow(/--image-reference and --image-digest/);
    expect(() => buildOptionsOf(["--out", "release"], "/work")).toThrow(/--tag/);
    expect(() => buildOptionsOf(["--tag", "v0.5.0", "--out", "r", "--image-reference", "x", "--image-digest", "y", "--sign"], "/work")).toThrow(/--sign/);
  });
});

