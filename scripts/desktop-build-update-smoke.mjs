import console from "node:console";
import process from "node:process";

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, createReadStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

/**
 * The hosted proof of #2196: an environment on macOS or Windows whose
 * release has no `kind: "environment"` asset for its platform updates from
 * the platform's desktop build. Run with the Node of the server the desktop
 * bundles (`<server>/node/...`), on the desktop build of this run:
 *
 * 1. A release manifest for this run's version is written with the desktop
 *    build as its only asset for the platform, carrying its `environment`
 *    payload field, and served by a forge double as the release's assets.
 * 2. The server's own release channel reads it, as an environment's check
 *    does, and must take the desktop build; the server's own shared desktop
 *    download and staging fetch it and unpack only the environment inside:
 *    on macOS `tar` (bsdtar) reads the zip's subtree, on Windows the setup's
 *    stored `app-64.7z` is carved out and the real `tar.exe` reads it. The
 *    staged tree must have the bundled server's top level.
 * 3. The bundled server, stamped lower, is installed as a service and
 *    updated to the staged tree; it must restart answering as this run's
 *    version.
 *
 * The forge double stands in for the release source because that is
 * compiled into the build; everything after the forge's answers is the
 * server's own code.
 */

const { fetch, AbortSignal } = globalThis;

/** The version the bundled server is stamped with, so this run's is newer. */
export const BASELINE = "0.0.0-0";
const discoveryPath = "/.well-known/agent-harness/environment";

/** Where the environment is in each platform's desktop build, as the release build writes it (`packages/cli/scripts/release/assets.ts`). */
export const DESKTOP_ENVIRONMENTS = {
  darwin: { path: "agent-harness.app/Contents/Resources/server" },
  win32: { payload: "app-64.7z", path: "resources/server" },
};

/** Each platform's desktop build: its file name on the release and its format. */
export const desktopBuildOf = (platform) => {
  const os = platform.split("-")[0];
  if (os === "darwin") return { name: `agent-harness-desktop-${platform}.zip`, format: "zip", environment: DESKTOP_ENVIRONMENTS.darwin };
  if (os === "win32") return { name: `agent-harness-desktop-${platform}-setup.exe`, format: "nsis", environment: DESKTOP_ENVIRONMENTS.win32 };
  throw new Error(`No environment updates from a desktop build on ${platform}`);
};

/**
 * The release manifest the smoke serves for `version`: no environment asset
 * for `platform` (another platform's stays, as a release has them), and the
 * platform's desktop build, of `size` and `sha256`, saying where the
 * environment is inside it.
 */
export function desktopOnlyManifest({ version, platform, launcherProtocol, size, sha256 }) {
  const { name, format, environment } = desktopBuildOf(platform);
  return {
    version,
    protocolVersion: 2,
    launcherProtocol,
    databaseSchemaVersion: 0,
    bundledClaudeCodeVersion: "smoke",
    assets: [
      { name: "agent-harness-linux-x64.tar.gz", kind: "environment", platform: "linux-x64", format: "tar.gz", size: 1, sha256: "0".repeat(64) },
      { name, kind: "desktop", platform, format, size, sha256, environment },
    ],
    image: { reference: `ghcr.io/david-systemtech/agent-harness:${version}`, digest: `sha256:${"0".repeat(64)}` },
  };
}

/** The SHA-256 of the file at `path`, in lowercase hexadecimal. */
export const sha256Of = (path) =>
  new Promise((done, fail) => {
    const hash = createHash("sha256");
    createReadStream(path).on("error", fail).on("data", (chunk) => hash.update(chunk)).on("end", () => done(hash.digest("hex")));
  });

/**
 * A forge double publishing one release, `v<version>`, whose assets are the
 * files `files` names (asset name to path): what the release channel asks of
 * the ForgeService, answered from this machine.
 */
export function releaseForge(version, files) {
  const assets = [...files].map(([name, path], index) => ({ id: index + 1, name, size: statSync(path).size, downloadUrl: pathToFileURL(path).href }));
  const release = { id: 1, tag: `v${version}`, name: `v${version}`, prerelease: version.includes("-"), publishedAt: new Date().toISOString(), assets };
  return {
    list: async () => ({ outcome: "done", value: [] }),
    releases: {
      list: async () => ({ outcome: "done", value: [release] }),
      byTag: async ({ tag }) => (tag === release.tag ? { outcome: "done", value: release } : { outcome: "failed", status: 404, message: `No release ${tag}` }),
      download: async ({ asset, destination }) => {
        const source = files.get(asset.name);
        if (source === undefined) return { outcome: "failed", status: 404, message: `No asset ${asset.name}` };
        copyFileSync(source, destination);
        return { outcome: "done", value: { size: statSync(destination).size, sha256: await sha256Of(destination) } };
      },
    },
  };
}

/**
 * What the smoke says when staging the desktop build failed with `message`
 * on `platform`: on Windows, plainly whether the carve found no 7z in the
 * setup or `tar.exe` could not read the 7z it found, which decides the
 * pinned 7zr.exe fallback.
 */
export function stagingFailure(platform, message) {
  if (!platform.startsWith("win32")) return `Staging the environment from the macOS desktop zip failed: ${message}`;
  if (message.includes("holds no 7z archive")) return `CARVE FAILED: the Windows setup holds no stored 7z the carve could find, so tar.exe was never tried (#2196): ${message}`;
  if (message.includes("did not unpack")) {
    return `WINDOWS TAR.EXE CANNOT READ THE SETUP'S 7Z: the carve found app-64.7z, and tar.exe could not unpack resources/server from it, so the environment needs the pinned 7zr.exe fallback (#2196): ${message}`;
  }
  return `Staging the environment from the Windows setup failed: ${message}`;
}

/** Why the staged tree at `staged` is not the bundled server's, whose top level is `expected`, at `version`; undefined when it is. */
export function stagedTreeDefect(staged, expected, version, platform = process.platform) {
  const found = readdirSync(staged).sort();
  if (found.join(",") !== [...expected].sort().join(",")) return `its top level is ${found.join(", ")}, and the bundled server's is ${[...expected].sort().join(", ")}`;
  const node = join(staged, ...(platform === "win32" ? ["node", "node.exe"] : ["node", "bin", "node"]));
  if (!existsSync(node)) return `it has no Node at ${node}`;
  if (!existsSync(join(staged, "packages", "cli", "dist", "main.js"))) return "it has no CLI entry";
  const declared = JSON.parse(readFileSync(join(staged, "packages", "cli", "package.json"), "utf8")).version;
  return declared === version ? undefined : `its CLI declares ${declared}, not ${version}`;
}

/** Stamps every package of the server artefact at `server` with `version`, as the macOS update smokes do. */
export function stampVersion(server, version) {
  for (const directory of [join(server, "packages"), join(server, "node_modules", "@agent-harness")]) {
    for (const folder of readdirSync(directory)) {
      const manifest = join(directory, folder, "package.json");
      if (!existsSync(manifest)) continue;
      writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), version }));
    }
  }
}

/** The discovery document of the environment in `dataDir`, or undefined while it does not answer. */
async function discovery(dataDir) {
  try {
    const { address } = JSON.parse(readFileSync(join(dataDir, "bootstrap-grant.json"), "utf8"));
    return await (await fetch(`http://${address.host}:${address.port}${discoveryPath}`, { signal: AbortSignal.timeout(2000) })).json();
  } catch {
    return undefined;
  }
}

/** Waits for the environment in `dataDir` to answer as `version` and ready, within `seconds`. */
async function awaitVersion(dataDir, version, seconds) {
  let last;
  for (let attempt = 0; attempt < seconds; attempt += 1) {
    last = await discovery(dataDir);
    if (last?.harnessVersion === version && last.readiness === "ready") return;
    await delay(1000);
  }
  throw new Error(`The environment did not answer as ${version} and ready within ${seconds} s; it last answered ${JSON.stringify(last ?? null)}`);
}

/** A free loopback port. */
function freePort() {
  return new Promise((done, fail) => {
    const server = createServer().on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

/** Steps 1 and 2: the manifest, the channel's choice and the staged tree; answers the staged folder. */
async function stageFromDesktopBuild({ server, build, version, work }) {
  const dist = (path) => import(pathToFileURL(join(server, "node_modules", "@agent-harness", "environment", "dist", "updates", path)).href);
  const [{ createReleaseChannel, RELEASE_SOURCE, RUNNING_PLATFORM }, { fetchDesktopBuild }, { stageArtefact, tarUnpack }] = await Promise.all([
    dist("channel.js"),
    dist("desktop-builds.js"),
    dist("staging.js"),
  ]);
  const { launcherProtocol } = JSON.parse(readFileSync(join(server, "packages", "cli", "package.json"), "utf8"));
  const manifest = desktopOnlyManifest({ version, platform: RUNNING_PLATFORM, launcherProtocol, size: statSync(build).size, sha256: await sha256Of(build) });
  const manifestFile = join(work, "release.json");
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  const { name } = desktopBuildOf(RUNNING_PLATFORM);
  console.log(`Serving a release ${version} with no environment asset for ${RUNNING_PLATFORM}: ${name} (${manifest.assets[1].size} bytes) with ${JSON.stringify(manifest.assets[1].environment)}`);

  const channel = createReleaseChannel({ forge: releaseForge(version, new Map([["release.json", manifestFile], [name, build]])), source: RELEASE_SOURCE, harnessVersion: BASELINE, databaseSchemaVersion: () => 0 });
  const reading = await channel.read({ autoUpdate: true, channel: version.includes("-") ? "beta" : "stable", pinnedVersion: null }, { launcherProtocol, failedVersions: [] });
  if (reading.outcome !== "read") throw new Error(`The release channel could not read the release: ${reading.message}`);
  const stage = reading.stage;
  if (stage === null) throw new Error(`The release channel staged nothing: ${JSON.stringify(reading.passedOver ?? reading.blocked)}`);
  if (stage.artefact.kind !== "desktop" || stage.artefact.environment === undefined) throw new Error(`The release channel took ${stage.artefact.name}, not the desktop build`);
  console.log(`The release channel takes ${stage.artefact.name} for ${stage.version}`);

  if (process.platform === "win32") {
    // The tar an environment runs is the one Windows ships (bsdtar), not one a runner put ahead of it.
    process.env.PATH = `${join(process.env.SystemRoot ?? "C:\\Windows", "System32")};${process.env.PATH ?? ""}`;
  }
  console.log(`tar: ${execFileSync("tar", ["--version"], { encoding: "utf8" }).split("\n")[0]}`);
  const dataDir = join(work, "staging-data");
  const started = Date.now();
  const staged = await fetchDesktopBuild(dataDir, stage, (asset, destination) => channel.download(asset, destination), async (path) => {
    try {
      return await stageArtefact({ dataDir, version, artefact: path, unpack: tarUnpack, within: stage.artefact.environment });
    } catch (error) {
      throw new Error(stagingFailure(RUNNING_PLATFORM, error instanceof Error ? error.message : String(error)), { cause: error });
    }
  });
  if (typeof staged !== "string") throw new Error(`The desktop build did not download: ${staged.message}`);
  const expected = readdirSync(server);
  const defect = stagedTreeDefect(staged, expected, version);
  if (defect !== undefined) throw new Error(`The tree staged from ${name} is not the bundled server: ${defect}`);
  const route = process.platform === "win32" ? "carved app-64.7z read by tar.exe" : "zip subtree read by bsdtar";
  console.log(`Staged ${version} from ${name} (${route}) in ${Date.now() - started} ms, kept in ${basename(dataDir)}/desktop-builds; top level: ${readdirSync(staged).sort().join(", ")}`);
  return staged;
}

/** Step 3: the bundled server, stamped lower, installed as a service and updated to `staged`. */
async function updateTo({ server, staged, version, work }) {
  const from = join(work, "bundled-server");
  const dataDir = join(work, "data");
  const node = join(from, ...(process.platform === "win32" ? ["node", "node.exe"] : ["node", "bin", "node"]));
  const main = join(from, "packages", "cli", "dist", "main.js");
  const cli = (...args) => execFileSync(node, [main, ...args, "--data-dir", dataDir], { stdio: "inherit", timeout: 180_000 });
  let installed = false;
  let entry;
  try {
    cpSync(server, from, { recursive: true, verbatimSymlinks: true });
    stampVersion(from, BASELINE);
    installed = true;
    cli("service", "install", "--port", String(await freePort()));
    if (process.platform === "win32") {
      // As the ordinary-user smoke starts it: the launcher entry, without Task Scheduler's interactive token.
      entry = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${join(dataDir, "launcher-entry.cmd")}"`], { cwd: dataDir, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true });
    } else {
      execFileSync(node, [main, "service", "start"], { stdio: "inherit", timeout: 120_000 });
    }
    await awaitVersion(dataDir, BASELINE, 120);
    console.log(`The bundled server's ${BASELINE} is ready; updating it to the tree staged from the desktop build`);
    cli("update", "apply", "--version", version, "--path", staged, "--now");
    await awaitVersion(dataDir, version, 300);
    console.log(`The environment restarted as ${version}, updated from the desktop build of this run`);
  } finally {
    // The launcher entry started by hand is no task's: its tree is ended before the service is uninstalled.
    if (entry?.pid !== undefined) {
      try {
        execFileSync("taskkill", ["/pid", String(entry.pid), "/t", "/f"], { stdio: "ignore" });
      } catch {
        // Already gone.
      }
      // Whatever of the smoke's still runs from its folder (a launcher or environment whose parent exited) is ended too.
      const sweep = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${work.replaceAll("'", "''")}\\*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      try {
        execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", sweep], { stdio: "inherit", timeout: 60_000 });
      } catch (error) {
        console.error("Ending the smoke's leftover processes failed:", error instanceof Error ? error.message : String(error));
      }
    }
    try {
      if (installed) cli("service", "uninstall");
    } catch (error) {
      console.error("Uninstalling the smoke's service failed:", error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}

export async function runSmoke(server, build, version) {
  if (!version) throw new Error("VERSION names no version to update to");
  const work = mkdtempSync(join(tmpdir(), "desktop-build-update-"));
  try {
    const staged = await stageFromDesktopBuild({ server, build, version, work });
    await updateTo({ server, staged, version, work });
  } finally {
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
    } catch (error) {
      // A file still held open is the runner's to clean up; it never fails the update the smoke proved.
      console.error(`Removing ${work} failed:`, error instanceof Error ? error.message : String(error));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await runSmoke(resolve(process.argv[2]), resolve(process.argv[3]), process.env.VERSION);
  } catch (error) {
    console.error("The update from the desktop build failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
