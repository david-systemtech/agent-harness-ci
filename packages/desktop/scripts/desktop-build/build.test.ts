import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";
import type { Configuration } from "electron-builder";
import { afterEach, describe, expect, it } from "vitest";
import { cleanUp, scratch } from "../../test/harness.js";
import { buildDesktop, type DesktopBuildOptions, type DesktopBuildSeams, type PackRequest } from "./build.js";

/**
 * The desktop build (#423) over a fake server artefact, with its compile and
 * electron-builder faked: the fake packer records the staged app, the
 * server artefact and the configuration it is handed, and writes the file
 * the configuration names, as electron-builder would. Observed through that
 * record and what lands in the out folder. What only a real build shows is
 * its run on a runner and the desktop checklist.
 */

afterEach(cleanUp);

/** The first bytes of each platform's Node executable, as its format lays them out: ELF, Mach-O and PE. */
const executableHeader = (platform: string): Buffer => {
  const bytes = Buffer.alloc(256);
  if (platform.startsWith("linux-")) {
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    bytes.writeUInt16LE(platform === "linux-x64" ? 0x3e : 0xb7, 18);
  } else if (platform.startsWith("darwin-")) {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(platform === "darwin-arm64" ? 0x0100000c : 0x01000007, 4);
  } else {
    bytes.write("MZ", 0, "latin1");
    bytes.writeUInt32LE(0x80, 0x3c);
    bytes.write("PE\0\0", 0x80, "latin1");
    bytes.writeUInt16LE(platform === "win32-x64" ? 0x8664 : 0xaa64, 0x84);
  }
  return bytes;
};

/**
 * A server artefact of `platform` and `version`, packed as the release build
 * packs one: its Node, and its CLI's `package.json`. A Windows artefact is a
 * zip on a release, made here with Python's zipfile when `zip` is asked,
 * else a gzipped tar, which every runner's `tar` unpacks.
 */
const serverArtefact = (platform: string, version = "0.5.0", zip = false): string => {
  const root = join(scratch(), "artefact");
  const node = platform.startsWith("win32-") ? ["node", "node.exe"] : ["node", "bin", "node"];
  mkdirSync(join(root, ...node.slice(0, -1)), { recursive: true });
  writeFileSync(join(root, ...node), executableHeader(platform), { mode: 0o755 });
  mkdirSync(join(root, "packages", "cli", "dist"), { recursive: true });
  writeFileSync(join(root, "packages", "cli", "package.json"), JSON.stringify({ name: "agent-harness", version }));
  writeFileSync(join(root, "packages", "cli", "dist", "main.js"), "export {};\n");
  mkdirSync(join(root, "node_modules", "@agent-harness", "contracts"), { recursive: true });
  writeFileSync(join(root, "node_modules", "@agent-harness", "contracts", "package.json"), JSON.stringify({ name: "@agent-harness/contracts", version }));
  mkdirSync(join(root, "node_modules", ".pnpm", "fixture"), { recursive: true });
  writeFileSync(join(root, "node_modules", ".pnpm", "fixture", "package.json"), "{}\n");
  const archive = join(scratch(), `agent-harness-${platform}.${zip ? "zip" : "tar.gz"}`);
  if (zip) execFileSync("python3", ["-m", "zipfile", "-c", archive, "node", "packages", "node_modules"], { cwd: root });
  else execFileSync("tar", ["-czf", archive, "-C", root, "node", "packages", "node_modules"]);
  return archive;
};

/** What the fake packer saw of the staged build when it was asked. */
interface Packed {
  readonly request: PackRequest;
  /** The staged app's `package.json`. */
  readonly manifest: Record<string, unknown>;
  /** Every file of the staged app, relative to it. */
  readonly app: string[];
  /** Every file of the server artefact the configuration carries, relative to it. */
  readonly server: string[];
  /** The NSIS include the configuration names, when it names one. */
  readonly nsisInclude?: string;
}

/** Every file under `root`, relative to it with `/` between folders. */
const files = (root: string): string[] =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();

interface Fixture {
  readonly options: (overrides?: Partial<DesktopBuildOptions>) => DesktopBuildOptions;
  readonly seams: DesktopBuildSeams;
  readonly packed: Packed[];
  readonly compiled: string[];
  readonly out: string;
  readonly work: string;
}

/** The section of electron-builder's configuration that names `format`'s file. */
const SECTION = { zip: "mac", nsis: "nsis", pacman: "pacman" } as const;

const fixture = (host: string, seams: Partial<DesktopBuildSeams> = {}): Fixture => {
  const out = join(scratch(), "out");
  const work = join(scratch(), "work");
  const packed: Packed[] = [];
  const compiled: string[] = [];
  return {
    out,
    work,
    packed,
    compiled,
    options: (overrides = {}) => ({ tag: "v0.5.0", platform: host, server: serverArtefact(host), out, ...overrides }),
    seams: {
      host,
      work,
      log: () => undefined,
      compile: async (app, version) => {
        compiled.push(version);
        mkdirSync(join(app, "renderer"), { recursive: true });
        writeFileSync(join(app, "main.js"), "export {};\n");
        writeFileSync(join(app, "preload.cjs"), "'use strict';\n");
        writeFileSync(join(app, "renderer", "index.html"), "<!doctype html>\n");
      },
      pack: async (request) => {
        const { config, target } = request;
        const app = String(config.directories?.app);
        const server = config.extraResources;
        const from = Array.isArray(server) && typeof server[0] === "object" && server[0] !== null ? String((server[0] as { from?: unknown }).from) : "";
        const include = config.nsis?.include;
        packed.push({
          request,
          manifest: JSON.parse(readFileSync(join(app, "package.json"), "utf8")) as Record<string, unknown>,
          app: files(app),
          server: files(join(from, "server")),
          ...(typeof include === "string" && { nsisInclude: readFileSync(include, "utf8") }),
        });
        const section = config[SECTION[target.format]] as { artifactName?: string } | null | undefined;
        const output = String(config.directories?.output);
        mkdirSync(output, { recursive: true });
        writeFileSync(join(output, String(section?.artifactName)), `a ${target.format} build`);
        writeFileSync(join(output, "builder-debug.yml"), "what electron-builder writes beside it\n");
      },
      ...seams,
    },
  };
};

/** Only electron-builder's resource copier is loaded; no Electron or packaging process runs. */
interface ResourceMatcher { readonly from: string; readonly to: string }
const requireBuilder = createRequire(createRequire(import.meta.url).resolve("electron-builder"));
const { getFileMatchers, copyFiles } = requireBuilder("app-builder-lib/out/fileMatcher.js") as {
  getFileMatchers(config: Configuration, name: "extraResources", destination: string, options: {
    readonly macroExpander: (pattern: string) => string;
    readonly customBuildOptions: Record<string, never>;
    readonly globalOutDir: string;
    readonly defaultSrc: string;
  }): ResourceMatcher[];
  copyFiles(matchers: ResourceMatcher[]): Promise<unknown>;
};

describe("the desktop build", () => {
  it.each(["linux-x64", "darwin-arm64", "win32-x64"])("copies the whole %s server tree, including dependencies, through electron-builder's resource filter", async (platform) => {
    const build = fixture(platform === "win32-x64" ? "linux-x64" : platform);
    const resources = join(scratch(), "resources");
    const pack = build.seams.pack;
    await buildDesktop(build.options({ platform, server: serverArtefact(platform, "0.5.0", platform === "win32-x64") }), { ...build.seams, pack: async (request) => {
      const matchers = getFileMatchers(request.config, "extraResources", resources, {
        macroExpander: (pattern) => pattern,
        customBuildOptions: {},
        globalOutDir: String(request.config.directories?.output),
        defaultSrc: request.projectDir,
      });
      await copyFiles(matchers);
      await pack?.(request);
    } });
    expect(files(resources)).toEqual([
      platform === "win32-x64" ? "server/node/node.exe" : "server/node/bin/node",
      "server/node_modules/.pnpm/fixture/package.json",
      "server/node_modules/@agent-harness/contracts/package.json",
      "server/packages/cli/dist/main.js",
      "server/packages/cli/package.json",
    ]);
    const node = join(resources, "server", platform === "win32-x64" ? "node/node.exe" : "node/bin/node");
    expect(readFileSync(node)).toEqual(executableHeader(platform));
    if (platform !== "win32-x64" && process.platform !== "win32") expect(statSync(node).mode & 0o111).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(join(resources, "server/node_modules/@agent-harness/contracts/package.json"), "utf8"))).toEqual({ name: "@agent-harness/contracts", version: "0.5.0" });
  });

  it("builds the Arch package on linux-x64 as agent-harness-desktop-linux-x64.pacman in the out folder, and nothing else there", async () => {
    const build = fixture("linux-x64");
    await buildDesktop(build.options(), build.seams);
    expect(readdirSync(build.out)).toEqual(["agent-harness-desktop-linux-x64.pacman"]);
    expect(readFileSync(join(build.out, "agent-harness-desktop-linux-x64.pacman"), "utf8")).toBe("a pacman build");
    expect(build.packed.map(({ request }) => request.target.format)).toEqual(["pacman"]);
  });

  it("stamps the app with the tag's version, which app.getVersion() answers, and builds the gui with it, and packs it on the Electron the desktop depends on", async () => {
    const build = fixture("linux-x64");
    await buildDesktop(build.options({ tag: "v0.6.0-beta.2", server: serverArtefact("linux-x64", "0.6.0-beta.2") }), build.seams);
    const [packed] = build.packed;
    expect(packed?.manifest).toMatchObject({ version: "0.6.0-beta.2", productName: "agent-harness", type: "module", main: "main.js" });
    expect(packed?.app).toEqual(["main.js", "package.json", "preload.cjs", "renderer/index.html"]);
    expect(build.compiled).toEqual(["0.6.0-beta.2"]);
    const desktop = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8")) as { devDependencies: Record<string, string> };
    expect(packed?.request.config.electronVersion).toBe(desktop.devDependencies["electron"]);
  });

  it("carries the platform's server artefact unpacked in the app's resources, at server/, where the shell's service and bundledServer() read it", async () => {
    const build = fixture("linux-x64");
    await buildDesktop(build.options(), build.seams);
    const [packed] = build.packed;
    expect(packed?.request.config.extraResources).toEqual([{ from: expect.any(String), to: ".", filter: ["server/**/*"] }]);
    expect(packed?.server).toEqual(["node/bin/node", "node_modules/.pnpm/fixture/package.json", "node_modules/@agent-harness/contracts/package.json", "packages/cli/dist/main.js", "packages/cli/package.json"]);
  });

  it("refuses a tag that is not v and a semantic version, before it builds anything", async () => {
    const build = fixture("linux-x64");
    for (const tag of ["0.5.0", "v0.5", "release-0.5.0", ""]) {
      await expect(buildDesktop(build.options({ tag }), build.seams), tag).rejects.toThrow(/is not v and a semantic version/);
    }
    expect(build.compiled).toEqual([]);
    expect(existsSync(build.out) ? readdirSync(build.out) : []).toEqual([]);
  });

  it("refuses a server artefact of another version, since the desktop hands its local environment the one it carries, before it packs anything", async () => {
    const build = fixture("linux-x64");
    const server = serverArtefact("linux-x64", "0.4.9");
    await expect(buildDesktop(build.options({ server }), build.seams)).rejects.toThrow(`The server artefact ${server} is 0.4.9, not 0.5.0: a desktop carries the server artefact of its own version.`);
    expect(build.packed).toEqual([]);
    expect(readdirSync(build.out)).toEqual([]);
  });

  it("refuses a server artefact whose Node is built for another platform, naming both", async () => {
    for (const [host, other] of [
      ["darwin-arm64", "linux-x64"],
      ["darwin-arm64", "darwin-x64"],
      ["linux-x64", "linux-arm64"],
      ["linux-x64", "darwin-arm64"],
      ["win32-x64", "win32-arm64"],
    ] as const) {
      const build = fixture(host);
      const server = serverArtefact(other);
      await expect(buildDesktop(build.options({ server }), build.seams), `${host} with ${other}`).rejects.toThrow(
        `The server artefact ${server} is ${other}'s, not ${host}'s: its Node is built for ${other}.`,
      );
      expect(build.packed).toEqual([]);
    }
  });

  it("refuses a server artefact with no Node where its platform's is, or no CLI naming a release version", async () => {
    const build = fixture("win32-x64");
    const server = serverArtefact("linux-x64");
    await expect(buildDesktop(build.options({ server }), build.seams)).rejects.toThrow(`The server artefact ${server} is not a win32-x64 artefact: it has no node/node.exe.`);
    const unversioned = join(scratch(), "unversioned");
    mkdirSync(join(unversioned, "node", "bin"), { recursive: true });
    writeFileSync(join(unversioned, "node", "bin", "node"), executableHeader("linux-x64"));
    const archive = join(scratch(), "unversioned.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", unversioned, "node"]);
    await expect(buildDesktop(fixture("linux-x64").options({ server: archive }), fixture("linux-x64").seams)).rejects.toThrow(/names no release version/);
  });

  it("builds only on a platform it is built on, naming the runner that builds it", async () => {
    const cases = [
      ["darwin-arm64", "linux-x64", "The darwin-arm64 desktop is built on darwin-arm64, not linux-x64: run it on CI's `macos` runner."],
      ["linux-x64", "linux-arm64", "The linux-x64 desktop is built on linux-x64, not linux-arm64: run it on CI's `ci-x64` runner."],
      ["win32-x64", "darwin-arm64", "The win32-x64 desktop is built on win32-x64 or linux-x64, not darwin-arm64: run it on CI's `ci-x64` runner."],
    ] as const;
    for (const [platform, host, message] of cases) {
      const build = fixture(host);
      await expect(buildDesktop(build.options({ platform, server: serverArtefact(platform) }), build.seams), platform).rejects.toThrow(message);
      expect(build.compiled).toEqual([]);
    }
  });

  it("refuses an out folder that is not empty, and leaves it as it was", async () => {
    const build = fixture("linux-x64");
    mkdirSync(build.out, { recursive: true });
    writeFileSync(join(build.out, "agent-harness-desktop-linux-x64.pacman"), "an earlier build");
    await expect(buildDesktop(build.options(), build.seams)).rejects.toThrow(`${build.out} is not empty: the build writes a desktop into an empty folder.`);
    expect(readFileSync(join(build.out, "agent-harness-desktop-linux-x64.pacman"), "utf8")).toBe("an earlier build");
    expect(build.compiled).toEqual([]);
  });

  it("says so when electron-builder wrote no file of the platform's name, and removes what it staged either way", async () => {
    const build = fixture("linux-x64", { pack: async () => undefined });
    await expect(buildDesktop(build.options(), build.seams)).rejects.toThrow("electron-builder wrote no agent-harness-desktop-linux-x64.pacman (it wrote nothing).");
    expect(existsSync(build.work)).toBe(false);
    expect(readdirSync(build.out)).toEqual([]);
  });

  it("builds the macOS zip on darwin-arm64: the arm64 bundle signed ad hoc with no hardened runtime, claiming the agent-harness scheme in its Info.plist", async () => {
    const build = fixture("darwin-arm64");
    await buildDesktop(build.options(), build.seams);
    expect(readdirSync(build.out)).toEqual(["agent-harness-desktop-darwin-arm64.zip"]);
    const config = build.packed[0]?.request.config;
    expect(config).toMatchObject({
      appId: "dev.systemtech.agent-harness",
      productName: "agent-harness",
      protocols: [{ name: "agent-harness", schemes: ["agent-harness"] }],
      mac: { target: [{ target: "zip", arch: ["arm64"] }], identity: "-", hardenedRuntime: false, notarize: false, extendInfo: { NSCameraUsageDescription: "Scan a pairing QR from another machine to add it." } },
    });
    expect(Object.keys(config ?? {}).filter((key) => ["mac", "win", "nsis", "linux", "pacman"].includes(key))).toEqual(["mac"]);
  });

  // An environment's keychain item names the Node that wrote it, so both install paths carry one Node (ticket 1724).
  it("leaves the bundled server's Node signed as the release tarball's, re-signing every other file of the bundle", async () => {
    const build = fixture("darwin-arm64");
    await buildDesktop(build.options(), build.seams);
    // electron-builder skips signing a file whose absolute path one of `signIgnore`'s patterns matches.
    const patterns = [build.packed[0]?.request.config.mac?.signIgnore ?? []].flat().map((pattern) => new RegExp(pattern));
    const skipped = (file: string) => patterns.some((pattern) => pattern.test(file));
    const contents = "/private/var/folders/x/agent-harness-desktop-build-a/dist/mac-arm64/agent-harness.app/Contents";
    expect(skipped(`${contents}/Resources/server/node/bin/node`)).toBe(true);
    for (const signed of [
      `${contents}/MacOS/agent-harness`,
      `${contents}/Frameworks/agent-harness Helper.app/Contents/MacOS/agent-harness Helper`,
      `${contents}/Resources/server/node/bin/node-gyp`,
      `${contents}/Resources/server/node/bin/node.bak`,
      `${contents}/Resources/server/node_modules/node-pty/build/Release/pty.node`,
      `${contents}/Resources/server/node_modules/@agent-harness/x/node/bin/node`,
    ]) {
      expect(skipped(signed), signed).toBe(false);
    }
  });

  it("builds the Windows setup on win32-x64: NSIS, one click, per user, and registering the agent-harness scheme for the user, kept when an update uninstalls the old version", async () => {
    const build = fixture("win32-x64");
    await buildDesktop(build.options(), build.seams);
    expect(readdirSync(build.out)).toEqual(["agent-harness-desktop-win32-x64-setup.exe"]);
    const [packed] = build.packed;
    expect(packed?.request.config).toMatchObject({ win: { target: [{ target: "nsis", arch: ["x64"] }] }, nsis: { oneClick: true, perMachine: false } });
    expect(packed?.nsisInclude?.split("\n")).toEqual([
      "; The desktop build's NSIS include: the setup registers the app's scheme for this user.",
      "!macro customInstall",
      '  WriteRegStr SHELL_CONTEXT "Software\\Classes\\agent-harness" "" "URL:agent-harness"',
      '  WriteRegStr SHELL_CONTEXT "Software\\Classes\\agent-harness" "URL Protocol" ""',
      '  WriteRegStr SHELL_CONTEXT "Software\\Classes\\agent-harness\\shell\\open\\command" "" \'"$INSTDIR\\${APP_EXECUTABLE_FILENAME}" "%1"\'',
      "!macroend",
      "",
      "!macro customUnInstall",
      "  ${ifNot} ${isUpdated}",
      "    ClearErrors",
      '    ExecWait \'"$INSTDIR\\resources\\server\\node\\node.exe" "$INSTDIR\\resources\\server\\packages\\cli\\dist\\main.js" service uninstall\' $0',
      "    ${if} ${Errors}",
      "      SetErrorLevel 1",
      '      Abort "Could not run environment service cleanup. The app has been kept."',
      "    ${endIf}",
      "    ${if} $0 != 0",
      "      SetErrorLevel 1",
      '      Abort "Could not uninstall the environment service. The app has been kept."',
      "    ${endIf}",
      '    DeleteRegKey SHELL_CONTEXT "Software\\Classes\\agent-harness"',
      "  ${endIf}",
      "!macroend",
      "",
    ]);
  });

  it("builds the Windows setup on linux-x64 too, where electron-builder runs Wine, from the release's zip artefact, unpacked as Windows unpacks it", async () => {
    const build = fixture("linux-x64");
    await buildDesktop(build.options({ platform: "win32-x64", server: serverArtefact("win32-x64", "0.5.0", true) }), build.seams);
    expect(readdirSync(build.out)).toEqual(["agent-harness-desktop-win32-x64-setup.exe"]);
    const [packed] = build.packed;
    expect(packed?.request.target.platform).toBe("win32-x64");
    expect(packed?.request.config).toMatchObject({ win: { target: [{ target: "nsis", arch: ["x64"] }] }, nsis: { oneClick: true, perMachine: false } });
    expect(packed?.server).toEqual(["node/node.exe", "node_modules/.pnpm/fixture/package.json", "node_modules/@agent-harness/contracts/package.json", "packages/cli/dist/main.js", "packages/cli/package.json"]);
    expect(packed?.nsisInclude).toContain("!macro customInstall");
  });

  it("builds the Arch package on linux-x64: one package name for every version, its executable not the CLI's name, a desktop entry claiming the scheme, and dependencies in Arch's repositories", async () => {
    const build = fixture("linux-x64");
    await buildDesktop(build.options(), build.seams);
    const [packed] = build.packed;
    expect(packed?.request.config).toMatchObject({
      protocols: [{ name: "agent-harness", schemes: ["agent-harness"] }],
      linux: { target: [{ target: "pacman", arch: ["x64"] }], executableName: "agent-harness-desktop" },
      pacman: { packageName: "agent-harness-desktop" },
    });
    expect(packed?.manifest).toMatchObject({ desktopName: "agent-harness-desktop.desktop" });
    const depends = packed?.request.config.pacman?.depends;
    expect(depends).toContain("gtk3");
    expect(depends).not.toContain("http-parser");
    expect(depends).not.toContain("libappindicator-gtk3");
  });

  it("makes the Arch package depend on polkit, whose pkexec the desktop installs its own update through", async () => {
    const build = fixture("linux-x64");
    await buildDesktop(build.options(), build.seams);
    expect(build.packed[0]?.request.config.pacman?.depends).toContain("polkit");
  });
});
