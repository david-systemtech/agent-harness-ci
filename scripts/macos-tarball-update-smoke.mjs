import console from "node:console";
import process from "node:process";

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { stampPriorPackagedServer } from "./macos-desktop-update-smoke.mjs";

/**
 * The hosted proof of #1724: an environment the desktop installs from its
 * bundled server keeps its stored key in the login keychain, whose access
 * list names the Node that wrote it; its update from the release tarball
 * reads that key with the tarball's Node. The two must be signed alike, or
 * the trial raises a macOS prompt that no one answers on a runner. The
 * bundled server, stamped lower, is installed as the desktop installs it,
 * then updated from the tarball at once; the smoke fails as soon as the
 * credential-access record shows a start waiting on the keychain (#1689).
 */

const { fetch, AbortSignal } = globalThis;

const baseline = "0.0.0-0";
const discoveryPath = "/.well-known/agent-harness/environment";

/** The designated requirement `codesign` reads from the executable at `file`: what a keychain item's access list names. */
export function designatedRequirement(file, run = (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) {
  const line = run("codesign", ["-d", "-r-", file]).split("\n").find((entry) => entry.startsWith("designated => "));
  if (line === undefined) throw new Error(`codesign names no designated requirement for ${file}`);
  return line.slice("designated => ".length);
}

/** How many entries the environment in `dataDir` keeps in the OS keychain, by its keychain index; none fails, since the update would then prove nothing. */
export function keychainEntries(dataDir) {
  const index = join(dataDir, "keychain.json");
  const keys = existsSync(index) ? JSON.parse(readFileSync(index, "utf8")).keys : undefined;
  if (!Array.isArray(keys) || keys.length === 0) throw new Error(`The environment in ${dataDir} keeps no entry in the OS keychain, so its update would prove nothing about the keychain`);
  return keys.length;
}

/**
 * Waits for the environment in `dataDir` to answer `discover` as `version`
 * and ready, looking `attempts` times, `pause` between; a credential-access
 * record fails it at once, since that is a start waiting on a keychain prompt.
 */
export async function awaitUnpromptedUpdate({ dataDir, version, discover, pause = () => delay(1000), attempts = 300 }) {
  const record = join(dataDir, "credential-access.json");
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (existsSync(record)) {
      throw new Error(`The update to ${version} raised a keychain prompt: ${readFileSync(record, "utf8").trim()}. The tarball's Node is signed otherwise than the Node that wrote the environment's stored key (#1724).`);
    }
    const discovery = await discover();
    if (discovery?.harnessVersion === version && discovery.readiness === "ready") return discovery;
    await pause();
  }
  throw new Error(`The environment did not answer as ${version} and ready after ${attempts} looks`);
}

/** The discovery document of the environment in `dataDir`, at the address its bootstrap grant names, or undefined while it does not answer. */
async function discovery(dataDir) {
  try {
    const { address } = JSON.parse(readFileSync(join(dataDir, "bootstrap-grant.json"), "utf8"));
    return await (await fetch(`http://${address.host}:${address.port}${discoveryPath}`, { signal: AbortSignal.timeout(2000) })).json();
  } catch {
    return undefined;
  }
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

async function runSmoke(app, tarball, version) {
  const work = mkdtempSync(join(tmpdir(), "macos-tarball-update-"));
  const server = join(work, "bundled-server");
  const dataDir = join(work, "data");
  const node = join(server, "node", "bin", "node");
  const cli = (...args) => execFileSync(node, [join(server, "packages", "cli", "dist", "main.js"), ...args, "--data-dir", dataDir], { stdio: "inherit", timeout: 120_000 });
  let installAttempted = false;
  try {
    cpSync(join(app, "Contents", "Resources", "server"), server, { recursive: true, verbatimSymlinks: true });
    stampPriorPackagedServer(server, baseline);
    installAttempted = true;
    cli("service", "install", "--port", String(await freePort()));
    execFileSync(node, [join(server, "packages", "cli", "dist", "main.js"), "service", "start"], { stdio: "inherit", timeout: 120_000 });
    await awaitUnpromptedUpdate({ dataDir, version: baseline, discover: () => discovery(dataDir), attempts: 120 });
    console.log(`The bundled server's ${baseline} is ready, with ${keychainEntries(dataDir)} entries in the OS keychain`);
    cli("update", "apply", "--version", version, "--path", tarball, "--now");
    await awaitUnpromptedUpdate({ dataDir, version, discover: () => discovery(dataDir) });
    const bundled = designatedRequirement(node);
    const updated = designatedRequirement(join(dataDir, "versions", version, "node", "bin", "node"));
    if (bundled !== updated) throw new Error(`The desktop's Node (${bundled}) and the tarball's (${updated}) are signed otherwise (#1724)`);
    console.log(`Updated a desktop-installed ${baseline} to the tarball's ${version} with no keychain prompt; both Nodes are ${bundled}`);
  } finally {
    // A failed uninstall fails the smoke too, without hiding why the update failed.
    try {
      if (installAttempted) cli("service", "uninstall");
    } catch (error) {
      console.error("Uninstalling the smoke's service failed:", error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await runSmoke(resolve(process.argv[2]), resolve(process.argv[3]), process.env.VERSION);
  } catch (error) {
    console.error("The tarball update of a desktop-installed environment failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
