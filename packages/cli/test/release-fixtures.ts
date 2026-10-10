import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { LAUNCHER_PROTOCOL, PROTOCOL_VERSION, type PreflightReport } from "@agent-harness/contracts";
import type { BuildOptions, BuildSeams } from "../scripts/release/build.js";
import type { DependencyRequest } from "../scripts/release/stage.js";
import type { ArtefactTarget } from "../scripts/release/targets.js";

/**
 * What the release build's tests run over (#356): a fixture workspace with
 * built packages, a dependency install that lays out `node_modules` as pnpm's
 * hoisted linker does for the platform asked, Node's archives for each
 * platform with their pins, and a host check answering a preflight report.
 * Nothing is downloaded, installed or run for real.
 */

/** The Node version the fixture archives are named for. */
export const FIXTURE_NODE_VERSION = "24.0.0";

/** The report the fixture's host check answers, for the version it was asked about. */
export const fixtureReport = (version: string): PreflightReport => ({
  version,
  protocolVersion: PROTOCOL_VERSION,
  launcherProtocol: LAUNCHER_PROTOCOL,
  databaseSchemaVersion: 17,
  bundledClaudeCodeVersion: "2.1.283 (Claude Code)",
});

/** The image reference and digest a release is given, faked. */
export const FIXTURE_IMAGE = { reference: "git.example.test:5526/david/agent-harness:0.5.0", digest: `sha256:${"0".repeat(64)}` };

const write = (path: string, content: string, mode?: number): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
};

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The fixture workspace: the CLI depending on contracts and the environment,
 * the environment on contracts, the separately bundled extension, and a GUI package no artefact carries; each
 * with a `dist`, and a lockfile whose importers name them all.
 */
const writeWorkspace = (root: string): void => {
  write(join(root, "package.json"), json({ name: "fixture-workspace", private: true }));
  write(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  write(
    join(root, "pnpm-lock.yaml"),
    [
      "lockfileVersion: '9.0'",
      "",
      "importers:",
      "",
      "  .: {}",
      "",
      "  packages/cli:",
      "    dependencies:",
      "      uqr:",
      "        specifier: ^0.1.3",
      "        version: 0.1.3",
      "",
      "  packages/contracts: {}",
      "",
      "  packages/environment: {}",
      "",
      "  packages/extension: {}",
      "",
      "  packages/gui: {}",
      "",
      "packages: {}",
      "",
    ].join("\n"),
  );
  const packages = {
    cli: {
      name: "agent-harness",
      version: "0.0.0",
      launcherProtocol: LAUNCHER_PROTOCOL,
      private: true,
      type: "module",
      bin: { "agent-harness": "./dist/main.js" },
      dependencies: { "@agent-harness/contracts": "workspace:*", "@agent-harness/environment": "workspace:*", uqr: "^0.1.3" },
    },
    contracts: { name: "@agent-harness/contracts", version: "0.0.0", private: true, type: "module", dependencies: { zod: "^4.6.5" } },
    environment: {
      name: "@agent-harness/environment",
      version: "0.0.0",
      private: true,
      type: "module",
      exports: { ".": { default: "./dist/index.js" } },
      dependencies: { "@agent-harness/contracts": "workspace:*", "@anthropic-ai/claude-agent-sdk": "0.3.283" },
      optionalDependencies: { "@napi-rs/keyring": "2.1.0", "node-pty": "1.1.0" },
    },
    extension: { name: "@agent-harness/extension", version: "0.0.0", private: true, type: "module", dependencies: { "@agent-harness/contracts": "workspace:*" } },
    gui: { name: "@agent-harness/gui", version: "0.0.0", private: true, type: "module", dependencies: { "@agent-harness/contracts": "workspace:*" } },
  };
  for (const [dir, manifest] of Object.entries(packages)) {
    write(join(root, "packages", dir, "package.json"), json(manifest));
    write(join(root, "packages", dir, "src", "index.ts"), "export {};\n");
  }
};

/** How the stand-in CLI misbehaves, for a check that must catch it: the version its `serve` reports on discovery or health, and a Claude binary it names from outside the artefact. */
export interface CliQuirks {
  readonly discoveryVersion?: string;
  readonly healthVersion?: string;
  readonly claudeOutside?: string;
}

/**
 * The stand-in for the CLI's build, `dist/main.js`, as the host check runs
 * it: `--version` and `preflight` from its own stamped `package.json`, the
 * preflight running the Claude binary its environment package resolves;
 * `serve` refusing root as the real one does, then answering discovery and
 * health on loopback until SIGTERM; and `where`, saying which Node runs it,
 * on which entry, with which arguments.
 */
export const fixtureCli = (quirks: CliQuirks = {}): string => `
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const [verb, ...args] = process.argv.slice(2);
if (verb === "--version") console.log("agent-harness " + manifest.version);
else if (verb === "where") console.log(JSON.stringify({ node: process.env.FIXTURE_NODE ?? null, entry: fileURLToPath(import.meta.url), args }));
else if (verb === "preflight") {
  const { bundledExecutable } = await import("@agent-harness/environment");
  const claude = execFileSync(bundledExecutable(), ["--version"], { encoding: "utf8" }).trim();
  console.log(JSON.stringify({ version: manifest.version, protocolVersion: ${PROTOCOL_VERSION}, launcherProtocol: manifest.launcherProtocol, databaseSchemaVersion: 17, bundledClaudeCodeVersion: claude }));
} else if (verb === "serve") {
  if (process.getuid?.() === 0) {
    console.error("agent-harness serve refuses to run as root");
    process.exit(1);
  }
  const port = Number(args[args.indexOf("--port") + 1]);
  const answers = {
    "/.well-known/agent-harness/environment": { harnessVersion: ${JSON.stringify(quirks.discoveryVersion ?? null)} ?? manifest.version, readiness: "ready" },
    "/health": { status: "ready", version: ${JSON.stringify(quirks.healthVersion ?? null)} ?? manifest.version },
  };
  const server = createServer((request, response) => {
    const answer = answers[request.url];
    response.writeHead(answer ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify(answer ?? {}));
  });
  server.listen(port, "127.0.0.1", () => console.log("http://127.0.0.1:" + port + "/.well-known/agent-harness/environment"));
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
} else {
  console.error("unknown verb " + verb);
  process.exit(2);
}
`;

/** The stand-in for the environment's build: `bundledExecutable` finding the SDK's Claude binary beside the SDK, as the real one resolves it. */
const fixtureEnvironment = (quirks: CliQuirks): string => `
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
export const bundledExecutable = () => {
  if (${JSON.stringify(quirks.claudeOutside ?? null)} !== null) return ${JSON.stringify(quirks.claudeOutside ?? null)};
  const scope = dirname(dirname(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk/package.json")));
  const own = readdirSync(scope).find((entry) => entry.startsWith("claude-agent-sdk-"));
  return join(scope, own, "claude");
};
`;

/** What the workspace compilation and extension build leave: each package's `dist`, the GUI's included; the CLI, environment and extension as stand-ins. */
export const compileWorkspace = (root: string, quirks: CliQuirks = {}, version = "0.5.0"): void => {
  write(join(root, "packages/extension/dist/manifest.json"), json({ manifest_version: 3, version_name: version, background: { service_worker: "worker.js" }, options_ui: { page: "options.html" } }));
  for (const asset of ["worker.js", "options.js", "options.html"]) write(join(root, "packages/extension/dist", asset), "fixture extension asset\n");
  write(join(root, "packages", "cli", "dist", "main.js"), fixtureCli(quirks));
  write(join(root, "packages", "environment", "dist", "index.js"), fixtureEnvironment(quirks));
  write(join(root, "packages/gui/dist/index.html"), '<html><script type="module" src="./assets/app.js"></script></html>');
  write(join(root, "packages/gui/dist/assets/app.js"), "// fixture web client\n");
  write(join(root, "packages/gui/dist/version.json"), json({ version }));
  for (const dir of ["contracts", "gui"]) write(join(root, "packages", dir, "dist", "index.js"), `export const name = ${JSON.stringify(dir)};\n`);
};

/**
 * What pnpm's hoisted linker lays out in the staged workspace for `target`:
 * the third-party packages in its root `node_modules`, with `.bin` links and
 * pnpm's own files; each workspace package's workspace dependencies as links
 * in its own `node_modules`; `node-pty` with the prebuilds its npm package
 * carries (and, where its install script ran, the build it compiled); and
 * the Claude Agent SDK's package for the target only.
 */
export const fixtureInstall = async ({ repoRoot, workspace, packages, target, runScripts }: DependencyRequest): Promise<void> => {
  const modules = join(workspace, "node_modules");
  write(join(workspace, "package.json"), json({ name: "fixture-workspace", private: true }));
  write(join(workspace, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  write(join(workspace, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  write(join(modules, ".modules.yaml"), "hoistPattern: []\n");
  write(join(modules, ".pnpm", "lock.yaml"), "lockfileVersion: '9.0'\n");
  write(join(modules, "uqr", "package.json"), json({ name: "uqr", version: "0.1.3", bin: { uqr: "cli.js" } }));
  write(join(modules, "uqr", "cli.js"), "console.log('uqr');\n", 0o755);
  mkdirSync(join(modules, ".bin"), { recursive: true });
  symlinkSync("../uqr/cli.js", join(modules, ".bin", "uqr"));
  write(join(modules, "zod", "package.json"), json({ name: "zod", version: "4.6.5" }));
  const pty = join(modules, "node-pty");
  write(join(pty, "package.json"), json({ name: "node-pty", version: "1.1.0", main: "./lib/index.js" }));
  write(join(pty, "src/win/conpty.cc"), "patched native console ownership\n");
  write(join(pty, "lib", "index.js"), "module.exports = {};\n");
  write(join(pty, "prebuilds", "darwin-arm64", "pty.node"), "mach-o pty\n");
  // node-pty's npm package ships the helper without its execute bit.
  write(join(pty, "prebuilds", "darwin-arm64", "spawn-helper"), "mach-o helper\n", 0o644);
  write(join(pty, "prebuilds", "darwin-x64", "pty.node"), "mach-o x64 pty\n");
  write(join(pty, "prebuilds", "win32-x64", "pty.node"), "pe pty\n");
  write(join(pty, "prebuilds", "win32-x64", "pty.pdb"), "debug symbols\n");
  write(join(pty, "prebuilds", "win32-x64", "conpty", "conpty.dll"), "pe conpty\n");
  // Its install script compiles it where its npm package has no prebuild for the platform it runs on: every Linux.
  if (runScripts && target.os === "linux") {
    write(join(pty, "build", "Release", "pty.node"), `elf pty for ${target.platform}\n`, 0o755);
  }
  if (target.os === "darwin" || target.os === "win32") {
    const prebuild = target.os === "win32" ? `${target.platform}-msvc` : target.platform;
    write(join(modules, "@napi-rs", "keyring", "package.json"), json({ name: "@napi-rs/keyring", version: "2.1.0" }));
    write(join(modules, "@napi-rs", `keyring-${prebuild}`, `keyring.${prebuild}.node`), "fixture keychain prebuild\n");
  }
  const sdk = join(modules, "@anthropic-ai");
  write(join(sdk, "claude-agent-sdk", "package.json"), json({ name: "@anthropic-ai/claude-agent-sdk", version: "0.3.283" }));
  const claude = target.os === "win32" ? "claude.exe" : "#!/bin/sh\necho '2.1.283 (Claude Code)'\n";
  write(join(sdk, `claude-agent-sdk-${target.platform}`, target.os === "win32" ? "claude.exe" : "claude"), claude, 0o755);
  const directories = new Map(packages.map((each) => [each.name, each.directory]));
  for (const each of packages) {
    write(join(workspace, each.directory, "package.json"), readFileSync(join(repoRoot, each.directory, "package.json"), "utf8"));
    for (const dependency of each.workspaceDependencies) {
      const link = join(workspace, each.directory, "node_modules", dependency);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(relative(dirname(link), join(workspace, directories.get(dependency) ?? "")), link);
    }
  }
};

/** A fixture build: its workspace, output folder and seams, removed with `remove`. */
export interface FixtureBuild {
  readonly root: string;
  readonly out: string;
  /** How many times the build compiled the workspace. */
  readonly compiled: number;
  /** The archives the host check was asked about, with their target. */
  readonly verified: readonly { readonly archive: string; readonly target: ArtefactTarget }[];
  /** The Node archives downloaded, by URL. */
  readonly downloaded: readonly string[];
  readonly seams: BuildSeams;
  /** The build's options: tag `v0.5.0`, the fixture's output folder and image, then `overrides`. */
  options(overrides?: Partial<BuildOptions>): BuildOptions;
  remove(): void;
}

/** Node's archive for each platform, as nodejs.org names and lays it out, with a stand-in binary and its licence. */
const writeNodeArchives = (into: string): Record<string, string> => {
  const pins: Record<string, string> = {};
  for (const [platform, top, binary] of [
    ["linux-x64", `node-v${FIXTURE_NODE_VERSION}-linux-x64`, "bin/node"],
    ["darwin-arm64", `node-v${FIXTURE_NODE_VERSION}-darwin-arm64`, "bin/node"],
    ["win32-x64", `node-v${FIXTURE_NODE_VERSION}-win-x64`, "node.exe"],
  ] as const) {
    const tree = join(into, "trees", top);
    // A stand-in running the test's own Node, telling the CLI which platform's Node it stands for.
    const node = `#!/bin/sh\nFIXTURE_NODE='node ${FIXTURE_NODE_VERSION} for ${platform}' exec '${process.execPath}' "$@"\n`;
    write(join(tree, binary), platform === "win32-x64" ? "node.exe\n" : node, 0o755);
    write(join(tree, "LICENSE"), "Node.js is licensed for use as follows\n");
    write(join(tree, "include", "node", "node.h"), "/* headers the artefact leaves out */\n");
    const archive = join(into, platform === "win32-x64" ? `${top}.zip` : `${top}.tar.gz`);
    if (platform === "win32-x64") {
      // Written by Python's zipfile, not the build's own zip code, as nodejs.org's zip is written by other code.
      execFileSync("python3", ["-c", "import sys,zipfile,os\nz=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED)\nfor d,_,fs in os.walk(sys.argv[2]):\n  for f in fs:\n    p=os.path.join(d,f); z.write(p, os.path.relpath(p, os.path.dirname(sys.argv[2])))\nz.close()", archive, tree]);
    } else {
      execFileSync("tar", ["-czf", archive, "-C", join(into, "trees"), top]);
    }
    pins[platform] = createHash("sha256").update(readFileSync(archive)).digest("hex");
  }
  return pins;
};

/** A fixture build's knobs: the platform it runs on (preset linux-x64), whether the host's artefact is really unpacked and run (preset: a report is answered), and how its CLI misbehaves. */
export interface FixtureBuildOptions {
  readonly host?: string;
  readonly runHostArtefact?: boolean;
  readonly quirks?: CliQuirks;
}

export const fixtureBuild = ({ host = "linux-x64", runHostArtefact = false, quirks = {} }: FixtureBuildOptions = {}): FixtureBuild => {
  const base = mkdtempSync(join(tmpdir(), "release-build-"));
  const root = join(base, "workspace");
  const out = join(base, "out");
  const archives = join(base, "nodejs.org");
  writeWorkspace(root);
  const sha256 = writeNodeArchives(archives);
  const state = { compiled: 0, verified: [] as { archive: string; target: ArtefactTarget }[], downloaded: [] as string[] };
  let seams: BuildSeams = {
    repoRoot: root,
    host,
    work: join(base, "work"),
    compile: async (repository, version) => {
      state.compiled += 1;
      compileWorkspace(repository, quirks, version);
    },
    installDependencies: fixtureInstall,
    nodeRuntime: { version: FIXTURE_NODE_VERSION, sha256 },
    download: async (url, file) => {
      state.downloaded.push(url);
      copyFileSync(join(archives, basename(new URL(url).pathname)), file);
    },
    log: () => undefined,
  };
  if (!runHostArtefact) {
    seams = {
      ...seams,
      verify: async (archive, target, version) => {
        state.verified.push({ archive, target });
        return fixtureReport(version);
      },
    };
  }
  return {
    root,
    out,
    get compiled() {
      return state.compiled;
    },
    get verified() {
      return state.verified;
    },
    get downloaded() {
      return state.downloaded;
    },
    seams,
    options: (overrides = {}) => ({ tag: "v0.5.0", out, image: FIXTURE_IMAGE, windowsPtyBuild: fixtureWindowsPty(join(base, "windows-native")), ...overrides }),
    remove: () => rmSync(base, { recursive: true, force: true }),
  };
};

/** A repaired Windows native build supplied by the same run, with independently stamped fixture provenance. */
export const fixtureWindowsPty = (folder: string): string => {
  const files: Record<string, string> = {};
  for (const name of ["pty.node", "conpty.node", "conpty_console_list.node", "winpty-agent.exe", "winpty.dll", "conpty/conpty.dll", "conpty/OpenConsole.exe"]) {
    const binary = Buffer.alloc(160);
    binary.write("MZ"); binary.writeUInt32LE(64, 60); binary.write("PE\0\0", 64); binary.writeUInt16LE(0x8664, 68);
    binary.write(`repaired ${name}`, 80);
    mkdirSync(dirname(join(folder, "Release", name)), { recursive: true });
    writeFileSync(join(folder, "Release", name), binary);
    files[name] = createHash("sha256").update(binary).digest("hex");
  }
  write(join(folder, "manifest.json"), json({ platform: "win32-x64", version: "1.1.0", sourceSha256: createHash("sha256").update("patched native console ownership\n").digest("hex"), files }));
  return folder;
};
