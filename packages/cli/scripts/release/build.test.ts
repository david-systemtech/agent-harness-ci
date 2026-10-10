import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { LAUNCHER_PROTOCOL, PROTOCOL_VERSION, ReleaseManifest } from "@agent-harness/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { declaredVersion } from "../../src/launch/versions.js";
import { FIXTURE_IMAGE, fixtureBuild, fixtureInstall, fixtureReport, fixtureWindowsPty, type FixtureBuild } from "../../test/release-fixtures.js";
import { buildOptionsOf } from "./arguments.js";
import type { OtherAsset } from "./assets.js";
import { buildRelease } from "./build.js";
import { withoutNode } from "./verify.js";
import { releaseWorkflowInput } from "../../../../test/release-workflow-input.js";

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
  it("stages the repaired Windows native payload in the cross-built archive instead of the upstream prebuild", async () => {
    build = fixtureBuild();
    const native = fixtureWindowsPty(join(build.out, "..", "windows-native"));
    await buildRelease({ ...build.options({ platforms: ["linux-x64", "win32-x64"] }), windowsPtyBuild: native }, build.seams);
    const pty = join(unpack("agent-harness-win32-x64.zip"), "node_modules", "node-pty");
    expect(readFileSync(join(pty, "build/Release/conpty.node"))).toEqual(readFileSync(join(native, "Release/conpty.node")));
    expect(readFileSync(join(pty, "build/Release/conpty_console_list.node"))).toEqual(readFileSync(join(native, "Release/conpty_console_list.node")));
    expect(existsSync(join(pty, "build/Release/conpty/conpty.dll"))).toBe(true);
    expect(existsSync(join(pty, "prebuilds"))).toBe(false);
    expect(links(pty)).toEqual([]);
  });

  it("refuses to cross-stage a Windows archive without a repaired native payload", async () => {
    build = fixtureBuild();
    const { tag, out, image } = build.options();
    await expect(buildRelease({ tag, out, image, platforms: ["linux-x64", "win32-x64"] }, build.seams)).rejects.toThrow(/require --windows-pty-build/);
    expect(existsSync(join(out, "agent-harness-win32-x64.zip"))).toBe(false);
  });

  it("refuses a Windows native payload built from a different source", async () => {
    build = fixtureBuild();
    await expect(buildRelease(build.options({ platforms: ["linux-x64", "win32-x64"] }), {
      ...build.seams,
      installDependencies: async (request) => {
        await fixtureInstall(request);
        if (request.target.os === "win32") writeFileSync(join(request.workspace, "node_modules/node-pty/src/win/conpty.cc"), "old console ownership");
      },
    })).rejects.toThrow(/does not match the installed pinned source/);
    expect(existsSync(join(build.out, "agent-harness-win32-x64.zip"))).toBe(false);
  });

  it("ships the module imported by the packaged macOS ownership smoke", async () => {
    build = fixtureBuild({ host: "darwin-arm64" });
    const workflow = releaseWorkflowInput(join(import.meta.dirname, "..", "..", "..", "..")).hosted;
    const ownership = workflow.split("- name: Verify packaged macOS tunnel ownership")[1]?.split("- name:")[0];
    expect(ownership).toBeDefined();
    const modulePath = ownership?.match(/resolve\(process\.env\.SERVER, "([^"]+)"\)/)?.[1];
    expect(modulePath).toBeDefined();
    await buildRelease(build.options({ platforms: ["darwin-arm64"] }), {
      ...build.seams,
      compile: async (repository, version) => {
        await build.seams.compile?.(repository, version);
        const directory = join(repository, "packages/environment/dist/serve");
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "interfaces.js"), "export const tailscaleDetector = () => {}; export const bindPlan = () => {};\n");
      },
    });
    const root = unpack("agent-harness-darwin-arm64.tar.gz");
    const imported = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { pathToFileURL } from 'node:url';
      const module = await import(pathToFileURL(process.argv[1]));
      assert.equal(typeof module.tailscaleDetector, 'function');
      assert.equal(typeof module.bindPlan, 'function');
      console.log('ownership module loaded');
    `, join(root, modulePath ?? "")], { encoding: "utf8" });
    expect(imported.trim()).toBe("ownership module loaded");
  });

  it.each(["darwin-arm64", "win32-x64"])("refuses a %s artefact without its keychain native prebuild", async (platform) => {
    build = fixtureBuild({ host: platform });
    await expect(buildRelease(build.options({ platforms: [platform] }), {
      ...build.seams,
      installDependencies: async (request) => {
        await fixtureInstall(request);
        const prebuild = platform === "win32-x64" ? "win32-x64-msvc" : platform;
        // The package directory remains, but its native file is absent.
        rmSync(join(request.workspace, "node_modules", "@napi-rs", `keyring-${prebuild}`, `keyring.${prebuild}.node`));
      },
    })).rejects.toThrow(/has no keychain prebuild/);
    expect(existsSync(join(build.out, "release.json"))).toBe(false);
  });

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
    expect(readdirSync(join(root, "node_modules", "@agent-harness")).sort()).toEqual(["contracts", "environment", "extension"]);
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
    for (const name of ["contracts", "environment", "extension"]) {
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
    expect(text(join(root, "node_modules", "@napi-rs", "keyring-darwin-arm64", "keyring.darwin-arm64.node"))).toBe("fixture keychain prebuild\n");
    const pty = join(root, "node_modules", "node-pty");
    expect(readdirSync(join(pty, "prebuilds"))).toEqual(["darwin-arm64"]);
    expect(existsSync(join(pty, "build"))).toBe(false);
    expect(executable(join(pty, "prebuilds", "darwin-arm64", "spawn-helper"))).toBe(true);
    expect(readdirSync(join(root, "node_modules", "@anthropic-ai")).sort()).toEqual(["claude-agent-sdk", "claude-agent-sdk-darwin-arm64"]);
    expect(executable(join(root, "bin", "agent-harness"))).toBe(true);
  });

  it("builds the win32-x64 artefact on a Linux runner as agent-harness-win32-x64.zip: node\\node.exe, bin\\agent-harness.cmd, the repaired Windows native runtime, the SDK's claude.exe, and no link", async () => {
    build = fixtureBuild();
    await buildRelease(build.options({ platforms: ["linux-x64", "win32-x64"] }), build.seams);
    expect(readdirSync(build.out)).toContain("agent-harness-win32-x64.zip");
    const root = unpack("agent-harness-win32-x64.zip");
    expect(readdirSync(root).sort()).toEqual(["bin", "node", "node_modules", "packages"]);
    expect(build.downloaded).toContain("https://nodejs.org/dist/v24.0.0/node-v24.0.0-win-x64.zip");
    expect(readdirSync(join(root, "node")).sort()).toEqual(["LICENSE", "node.exe"]);
    expect(text(join(root, "node_modules", "@napi-rs", "keyring-win32-x64-msvc", "keyring.win32-x64-msvc.node"))).toBe("fixture keychain prebuild\n");
    expect(readdirSync(join(root, "bin"))).toEqual(["agent-harness.cmd"]);
    expect(text(join(root, "bin", "agent-harness.cmd"))).toBe(
      '@echo off\r\nrem agent-harness: this release\'s CLI on its own Node, from wherever the artefact is unpacked.\r\n"%~dp0..\\node\\node.exe" "%~dp0..\\packages\\cli\\dist\\main.js" %*\r\nexit /b %ERRORLEVEL%\r\n',
    );
    const pty = join(root, "node_modules", "node-pty");
    expect(readFileSync(join(pty, "build/Release/conpty.node")).toString()).toContain("repaired conpty.node");
    expect(existsSync(join(pty, "prebuilds"))).toBe(false);
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

/** This checkout's compose file, whose image line the release names its image in. */
const COMPOSE_FILE = join(import.meta.dirname, "..", "..", "..", "..", "scripts", "compose.yaml");

/**
 * The release's other assets as the workflow names them (#358), made in a
 * folder beside the build's output: two scripts, the compose file (this
 * checkout's) and a schema export folder.
 */
const otherAssets = (): { kind: string; path: string }[] => {
  const sources = join(build.out, "..", "sources");
  mkdirSync(join(sources, "schema", "release"), { recursive: true });
  writeFileSync(join(sources, "install.sh"), "#!/bin/sh\necho install\n");
  writeFileSync(join(sources, "host-updater.sh"), "#!/bin/sh\necho update\n");
  writeFileSync(join(sources, "schema", "index.json"), '{"title":"index"}\n');
  writeFileSync(join(sources, "schema", "release", "manifest.json"), '{"title":"ReleaseManifest"}\n');
  return [
    { kind: "schema", path: join(sources, "schema") },
    { kind: "install-script", path: join(sources, "install.sh") },
    { kind: "compose", path: COMPOSE_FILE },
    { kind: "host-updater", path: join(sources, "host-updater.sh") },
  ];
};

/**
 * The three desktop builds as the release workflow names them (#359), each
 * with the platform and format its shell's update installs, made in a folder
 * beside the build's output: bytes standing in for the macOS zip, the Windows
 * setup and the Arch package.
 */
const desktopBuilds = (): OtherAsset[] => {
  const sources = join(build.out, "..", "desktop");
  mkdirSync(sources, { recursive: true });
  const desktop = (name: string, platform: string, format: string): OtherAsset => {
    writeFileSync(join(sources, name), `the ${format} desktop build\n`);
    return { kind: "desktop", path: join(sources, name), target: { platform, format } };
  };
  return [
    desktop("agent-harness-desktop-darwin-arm64.zip", "darwin-arm64", "zip"),
    desktop("agent-harness-desktop-win32-x64-setup.exe", "win32-x64", "nsis"),
    desktop("agent-harness-desktop-linux-x64.pacman", "linux-x64", "pacman"),
  ];
};

describe("the release's other assets", { timeout: BUILD_MS }, () => {
  it("writes a complete GitHub release manifest with all platforms, desktops and the exact ghcr image", async () => {
    build = fixtureBuild();
    const assets = [...otherAssets(), ...desktopBuilds()];
    const windowsInstall = join(build.out, "..", "install.ps1");
    writeFileSync(windowsInstall, "Write-Output install\n");
    assets.push({ kind: "install-script", path: windowsInstall });
    const image = { reference: "ghcr.io/david-systemtech/agent-harness:1.2.3-beta.2", digest: `sha256:${"0".repeat(64)}` };
    await buildRelease(build.options({ tag: "v1.2.3-beta.2", image, assets }), build.seams);
    const manifest = ReleaseManifest.parse(JSON.parse(text(join(build.out, "release.json"))));
    expect(manifest).toMatchObject({ version: "1.2.3-beta.2", image });
    expect(manifest.assets.map(({ name }) => name).sort()).toEqual([
      "agent-harness-linux-x64.tar.gz", "agent-harness-darwin-arm64.tar.gz", "agent-harness-win32-x64.zip",
      "agent-harness-desktop-darwin-arm64.zip", "agent-harness-desktop-win32-x64-setup.exe", "agent-harness-desktop-linux-x64.pacman",
      "agent-harness-schema.tar.gz", "install.sh", "install.ps1", "compose.yaml", "host-updater.sh",
    ].sort());
    for (const name of [...manifest.assets.map(({ name }) => name), "release.json"]) {
      expect(execFileSync("sha256sum", ["-c", `${name}.sha256`], { cwd: build.out, encoding: "utf8" })).toBe(`${name}: OK\n`);
    }
    expect(text(join(build.out, "compose.yaml"))).toContain(image.reference);
  });

  it("are written beside the artefacts with a sidecar each, a folder packed as agent-harness-<kind>.tar.gz, and listed in release.json after them with their kind, no platform and the format their name says", async () => {
    build = fixtureBuild();
    await buildRelease(build.options({ platforms: ["linux-x64"], assets: otherAssets() }), build.seams);
    const names = ["agent-harness-linux-x64.tar.gz", "agent-harness-schema.tar.gz", "install.sh", "compose.yaml", "host-updater.sh", "release.json"];
    expect(readdirSync(build.out).sort()).toEqual(names.flatMap((name) => [name, `${name}.sha256`]).sort());
    for (const name of names) {
      expect(execFileSync("sha256sum", ["-c", `${name}.sha256`], { cwd: build.out, encoding: "utf8" })).toBe(`${name}: OK\n`);
    }
    const digest = (name: string) => text(join(build.out, `${name}.sha256`)).split(" ", 1)[0];
    const size = (name: string) => statSync(join(build.out, name)).size;
    const manifest = ReleaseManifest.parse(JSON.parse(text(join(build.out, "release.json"))));
    expect(manifest.assets.slice(1)).toEqual([
      { name: "agent-harness-schema.tar.gz", kind: "schema", platform: null, format: "tar.gz", size: size("agent-harness-schema.tar.gz"), sha256: digest("agent-harness-schema.tar.gz") },
      { name: "install.sh", kind: "install-script", platform: null, format: null, size: size("install.sh"), sha256: digest("install.sh") },
      { name: "compose.yaml", kind: "compose", platform: null, format: null, size: size("compose.yaml"), sha256: digest("compose.yaml") },
      { name: "host-updater.sh", kind: "host-updater", platform: null, format: null, size: size("host-updater.sh"), sha256: digest("host-updater.sh") },
    ]);
    expect(text(join(build.out, "install.sh"))).toBe("#!/bin/sh\necho install\n");
    expect(text(join(build.out, "host-updater.sh"))).toBe("#!/bin/sh\necho update\n");
    const schema = unpack("agent-harness-schema.tar.gz");
    expect(readdirSync(schema, { recursive: true, encoding: "utf8" }).sort()).toEqual(["schema", "schema/index.json", "schema/release", "schema/release/manifest.json"]);
    expect(text(join(schema, "schema", "release", "manifest.json"))).toBe('{"title":"ReleaseManifest"}\n');
  });

  it("take the desktop builds, each written with a sidecar and listed in release.json with kind desktop, the platform and the format it was named with", async () => {
    build = fixtureBuild();
    await buildRelease(build.options({ platforms: ["linux-x64"], assets: desktopBuilds() }), build.seams);
    const names = ["agent-harness-desktop-darwin-arm64.zip", "agent-harness-desktop-win32-x64-setup.exe", "agent-harness-desktop-linux-x64.pacman"];
    for (const name of names) {
      expect(execFileSync("sha256sum", ["-c", `${name}.sha256`], { cwd: build.out, encoding: "utf8" })).toBe(`${name}: OK\n`);
    }
    const listed = (name: string, platform: string, format: string) => ({
      name,
      kind: "desktop",
      platform,
      format,
      size: statSync(join(build.out, name)).size,
      sha256: text(join(build.out, `${name}.sha256`)).split(" ", 1)[0],
    });
    const manifest = ReleaseManifest.parse(JSON.parse(text(join(build.out, "release.json"))));
    expect(manifest.assets.slice(1)).toEqual([
      listed("agent-harness-desktop-darwin-arm64.zip", "darwin-arm64", "zip"),
      listed("agent-harness-desktop-win32-x64-setup.exe", "win32-x64", "nsis"),
      listed("agent-harness-desktop-linux-x64.pacman", "linux-x64", "pacman"),
    ]);
    expect(text(join(build.out, "agent-harness-desktop-win32-x64-setup.exe"))).toBe("the nsis desktop build\n");
  });

  it("refuse, before anything is built, a desktop build without its platform and format, one the manifest cannot list, and a second build of one platform and format", async () => {
    build = fixtureBuild();
    const [zip, setup] = desktopBuilds() as [OtherAsset, OtherAsset, OtherAsset];
    const refused: [OtherAsset[], RegExp][] = [
      [[{ kind: "desktop", path: zip.path }], /agent-harness-desktop-darwin-arm64\.zip is a desktop build without its platform and format: --asset desktop:<platform>:<format>=<path>/],
      [[{ ...zip, target: { platform: "macOS", format: "zip" } }], /"macOS" is not a platform: <os>-<arch> as Node names them, such as darwin-arm64/],
      [[{ ...zip, target: { platform: "darwin-arm64", format: "Zip" } }], /"Zip" is not a format: lowercase letters and digits, in parts joined by dots, such as nsis or tar\.gz/],
      [[zip, { ...setup, target: { platform: "darwin-arm64", format: "zip" } }], /two desktop builds for darwin-arm64 as zip/],
    ];
    for (const [assets, message] of refused) {
      await expect(buildRelease(build.options({ platforms: ["linux-x64"], assets }), build.seams), String(message)).rejects.toThrow(message);
    }
    expect(build.compiled).toBe(0);
  });

  it("names the release's image in the compose file in place of the unreleased placeholder, changing no other line", async () => {
    build = fixtureBuild();
    await buildRelease(build.options({ platforms: ["linux-x64"], assets: otherAssets() }), build.seams);
    const before = text(COMPOSE_FILE).split("\n");
    const after = text(join(build.out, "compose.yaml")).split("\n");
    expect(after).toHaveLength(before.length);
    expect(before.flatMap((line, i) => (line === after[i] ? [] : [[line, after[i]]]))).toEqual([
      ["    image: ${AGENT_HARNESS_IMAGE:-git.systemtech.dev:5526/david/agent-harness:unreleased}", "    image: ${AGENT_HARNESS_IMAGE:-git.example.test:5526/david/agent-harness:0.5.0}"],
    ]);
  });

  it("are refused, before anything is built, when one is missing, not a kind, the artefacts' own kind, named as another asset or its sidecar is, or a compose file without the placeholder written once", async () => {
    build = fixtureBuild();
    const sources = join(build.out, "..", "sources");
    mkdirSync(sources, { recursive: true });
    const file = (name: string, content = "#!/bin/sh\n") => {
      writeFileSync(join(sources, name), content);
      return join(sources, name);
    };
    const refused: [{ kind: string; path: string }[], RegExp][] = [
      [[{ kind: "install-script", path: join(sources, "absent.sh") }], /absent\.sh.*does not exist/],
      [[{ kind: "Install Script", path: file("install.sh") }], /"Install Script" is not an asset kind/],
      [[{ kind: "environment", path: file("install.sh") }], /the build's own artefacts/],
      [[{ kind: "install-script", path: file("install.sh") }, { kind: "host-updater", path: file("install.sh") }], /two assets named install\.sh/],
      [[{ kind: "install-script", path: file("release.json", "{}\n") }], /two assets named release\.json/],
      [[{ kind: "install-script", path: file("agent-harness-linux-x64.tar.gz") }], /two assets named agent-harness-linux-x64\.tar\.gz/],
      [[{ kind: "install-script", path: file("agent-harness-linux-x64.tar.gz.sha256") }], /two assets named agent-harness-linux-x64\.tar\.gz\.sha256/],
      [[{ kind: "install-script", path: file("release.json.sha256") }], /two assets named release\.json\.sha256/],
      [[{ kind: "install-script", path: file("install.sh") }, { kind: "host-updater", path: file("install.sh.sha256") }], /two assets named install\.sh\.sha256/],
      [[{ kind: "host-updater", path: file("updater.sh.sha256") }, { kind: "install-script", path: file("updater.sh") }], /two assets named updater\.sh\.sha256/],
      [[{ kind: "compose", path: file("compose.yaml", "services: {}\n") }], /compose\.yaml names the image git\.systemtech\.dev:5526\/david\/agent-harness:unreleased 0 times, not once/],
      [[{ kind: "compose", path: file("twice.yaml", "a: git.systemtech.dev:5526/david/agent-harness:unreleased\nb: git.systemtech.dev:5526/david/agent-harness:unreleased\n") }], /2 times, not once/],
    ];
    for (const [assets, message] of refused) {
      await expect(buildRelease(build.options({ platforms: ["linux-x64"], assets }), build.seams), String(message)).rejects.toThrow(message);
    }
    expect(build.compiled).toBe(0);
    expect(existsSync(build.out) ? readdirSync(build.out) : []).toEqual([]);
  });
});

describe("the build's command line", () => {
  it("takes the tag, the output folder, the image's reference and digest, and platforms to build, the folder read from where pnpm was run", () => {
    const args = ["--tag", "v0.5.0", "--out", "release", "--image-reference", FIXTURE_IMAGE.reference, "--image-digest", FIXTURE_IMAGE.digest];
    expect(buildOptionsOf(args, "/work/checkout")).toEqual({ tag: "v0.5.0", out: "/work/checkout/release", image: FIXTURE_IMAGE });
    expect(buildOptionsOf([...args, "--platform", "linux-x64", "--platform", "win32-x64"], "/work")).toMatchObject({ platforms: ["linux-x64", "win32-x64"] });
  });

  it("takes the release's other assets as --asset <kind>=<path>, each path read from where pnpm was run", () => {
    const args = ["--tag", "v0.5.0", "--out", "release", "--image-reference", FIXTURE_IMAGE.reference, "--image-digest", FIXTURE_IMAGE.digest];
    expect(buildOptionsOf([...args, "--asset", "install-script=scripts/install.sh", "--asset", "schema=/abs/schema"], "/work/checkout")).toMatchObject({
      assets: [
        { kind: "install-script", path: "/work/checkout/scripts/install.sh" },
        { kind: "schema", path: "/abs/schema" },
      ],
    });
    expect(() => buildOptionsOf([...args, "--asset", "scripts/install.sh"], "/work")).toThrow(/--asset takes <kind>=<path> or <kind>:<platform>:<format>=<path>, not "scripts\/install\.sh"/);
    expect(() => buildOptionsOf([...args, "--asset", "install-script="], "/work")).toThrow(/--asset takes <kind>=<path>/);
  });

  it("takes a desktop build as --asset desktop:<platform>:<format>=<path>, and no platform without its format", () => {
    const args = ["--tag", "v0.5.0", "--out", "release", "--image-reference", FIXTURE_IMAGE.reference, "--image-digest", FIXTURE_IMAGE.digest];
    expect(buildOptionsOf([...args, "--asset", "desktop:win32-x64:nsis=desktop/agent-harness-desktop-win32-x64-setup.exe"], "/work/checkout")).toMatchObject({
      assets: [{ kind: "desktop", path: "/work/checkout/desktop/agent-harness-desktop-win32-x64-setup.exe", target: { platform: "win32-x64", format: "nsis" } }],
    });
    for (const asset of ["desktop:win32-x64=setup.exe", "desktop:win32-x64:nsis:x=setup.exe", "desktop::nsis=setup.exe", "desktop:win32-x64:=setup.exe"]) {
      expect(() => buildOptionsOf([...args, "--asset", asset], "/work"), asset).toThrow(/--asset takes <kind>=<path> or <kind>:<platform>:<format>=<path>/);
    }
  });

  it("refuses arguments missing one it needs, or one it does not know", () => {
    expect(() => buildOptionsOf(["--tag", "v0.5.0", "--out", "release"], "/work")).toThrow(/--image-reference and --image-digest/);
    expect(() => buildOptionsOf(["--out", "release"], "/work")).toThrow(/--tag/);
    expect(() => buildOptionsOf(["--tag", "v0.5.0", "--out", "r", "--image-reference", "x", "--image-digest", "y", "--sign"], "/work")).toThrow(/--sign/);
  });
});
