import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";

import { spawn, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const { fetch, AbortSignal, WebSocket } = globalThis;

const discoveryPath = "/.well-known/agent-harness/environment";
const credentialName = "packaged-update-check";
const baseline = "0.0.0-0";

/** Whether Settings has opened, queried through the packaged page's CDP boundary. */
export async function packagedSettingsOpen(evaluate) {
  return await evaluate("!!document.querySelector('section[aria-label=Settings]')");
}

/** Opens Settings through the packaged page's CDP boundary. */
export async function clickPackagedSettings(evaluate) {
  return await evaluate(`(() => {
    const button = document.querySelector('button[aria-label=Settings]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
}

/** Waits for the packaged page and opens its Settings control through CDP. */
export async function openPackagedSettings(evaluate) {
  // The target can appear while its execution context is still being replaced.
  const ready = (check, message) => until(() => check().catch(() => false), message);
  await ready(() => evaluate("typeof window.desktopShell === 'object'"), "The packaged preload did not load");
  await ready(() => clickPackagedSettings(evaluate), "The Settings control did not mount");
  await ready(() => packagedSettingsOpen(evaluate), "Settings did not open after replacement");
}

/** Runs on hosted macOS only. The credential stays inside the page; no token is returned or logged. */
export async function askForPackagedUpdate(evaluate, version) {
  const result = await evaluate(`(async () => {
    const shell = window.desktopShell;
    const token = await shell.secrets.get(${JSON.stringify(credentialName)});
    if (!token) throw new Error("The replacement could not read the prior install's credential");
    const grant = await shell.localGrant.read();
    const origin = 'http://' + grant.address.host + ':' + grant.address.port;
    const before = await (await shell.http(origin + ${JSON.stringify(discoveryPath)})).json();
    const bundled = await shell.installer.bundledServer();
    const response = await shell.http(origin + '/api/update', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ version: bundled.version, artefactPath: bundled.path }),
    });
    return { fromVersion: before.harnessVersion, carriedVersion: bundled.version, status: response.status,
      toVersion: (await response.json()).toVersion, platform: (await shell.system()).platform };
  })()`);
  assert.notEqual(result.fromVersion, version, "This must exercise an upgrade, not a fresh install");
  assert.equal(result.carriedVersion, version);
  assert.equal(result.status, 200, "The existing credential must authorize the carried update");
  assert.equal(result.toVersion, version);
  assert.equal(result.platform, "darwin", "The main process still answers after the Keychain read");
}

async function until(check, message, milliseconds = 120_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(250);
  }
  throw new Error(message);
}

async function connectCdp(port) {
  const page = await until(async () => {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
      return targets.find((target) => target.type === "page" && target.url.startsWith("agent-harness:"));
    } catch { return undefined; }
  }, "The packaged window did not expose its page");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error("The packaged page did not accept CDP")); }, 30_000);
    socket.onopen = () => { clearTimeout(timeout); resolve(); };
    socket.onerror = () => { clearTimeout(timeout); reject(new Error("The packaged page's CDP connection failed")); };
  });
  let id = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const frame = JSON.parse(data);
    const answer = pending.get(frame.id);
    if (!answer) return;
    pending.delete(frame.id);
    if (frame.error || frame.result.exceptionDetails) answer.reject(new Error("Packaged page evaluation failed"));
    else answer.resolve(frame.result.result.value);
  };
  socket.onclose = () => { for (const answer of pending.values()) answer.reject(new Error("The packaged window disconnected")); };
  return {
    evaluate: (expression) => new Promise((resolve, reject) => {
      const next = ++id;
      const timeout = setTimeout(() => {
        pending.delete(next);
        reject(new Error("The packaged main process did not answer within two minutes"));
      }, 120_000);
      pending.set(next, { resolve: (value) => { clearTimeout(timeout); resolve(value); }, reject: (error) => { clearTimeout(timeout); reject(error); } });
      socket.send(JSON.stringify({ id: next, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    }),
    close: () => socket.close(),
  };
}

async function configureIdle(origin, credential, protocolVersion) {
  const socket = new WebSocket(origin.replace("http:", "ws:") + "/ws");
  let timeout;
  try {
    await new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("The fixture did not answer the idle-window request")), 30_000);
      socket.onopen = () => socket.send(JSON.stringify({ type: "auth", token: credential.token, protocolVersion, clientKind: "tui", harnessVersion: baseline }));
      socket.onerror = () => reject(new Error("Could not authenticate the upgrade fixture"));
      socket.onmessage = ({ data }) => {
        const frame = JSON.parse(data);
        if (frame.type === "hello") socket.send(JSON.stringify({ type: "request", id: "idle", method: "updates.settings.set", params: {
          commandId: randomUUID(), values: { "updates.idleWindowMinutes": 1, "updates.autoUpdate": false },
        } }));
        if (frame.type === "bye" || frame.error || frame.result?.receipt?.status === "rejected") reject(new Error("The fixture could not set the update idle window"));
        if (frame.type === "response" && frame.id === "idle" && !frame.error) resolve();
      };
    });
  } finally { clearTimeout(timeout); socket.close(); }
}

async function runSmoke(source, version) {
  assert.equal(process.platform, "darwin");
  const data = join(homedir(), "Library", "Application Support", "agent-harness");
  assert.equal(existsSync(data), false, "The hosted smoke user must have no existing environment data");
  const work = mkdtempSync(join(tmpdir(), "macos-desktop-update-"));
  const installed = join(work, "agent-harness.app");
  const keychain = join(work, "smoke.keychain-db");
  const originalKeychain = execFileSync("security", ["default-keychain", "-d", "user"], { encoding: "utf8" }).trim().replace(/^"|"$/g, "");
  const originalSearchList = [...execFileSync("security", ["list-keychains", "-d", "user"], { encoding: "utf8" }).matchAll(/"([^"\n]+)"/g)].map((match) => match[1]);
  let desktop;
  let cdp;
  let fixtureCli;
  const execute = (command, args) => execFileSync(command, args, { stdio: "pipe", timeout: 120_000 });
  const executable = (app) => join(app, "Contents", "MacOS", execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", join(app, "Contents", "Info.plist")], { encoding: "utf8" }).trim());
  const stopDesktop = async () => {
    if (!desktop || desktop.exitCode !== null || desktop.signalCode !== null) return;
    desktop.kill("SIGTERM");
    await until(() => desktop.exitCode !== null || desktop.signalCode !== null, "The packaged desktop did not respond to SIGTERM", 10_000);
  };
  try {
    cpSync(source, installed, { recursive: true });
    const resources = join(installed, "Contents", "Resources");
    // A prior-install fixture of the release's server code, stamped lower, tests the real launcher handover.
    // Actual 0.1.0 data migration and interactive OS approval are the manual checklist.
    const server = join(resources, "server");
    for (const folder of readdirSync(join(server, "packages"))) {
      const manifest = join(server, "packages", folder, "package.json");
      if (existsSync(manifest)) {
        const value = JSON.parse(readFileSync(manifest, "utf8"));
        value.version = baseline;
        writeFileSync(manifest, JSON.stringify(value));
      }
    }
    fixtureCli = [join(server, "node", "bin", "node"), join(server, "packages", "cli", "dist", "main.js")];
    execute(fixtureCli[0], [fixtureCli[1], "service", "install"]);
    execute(fixtureCli[0], [fixtureCli[1], "service", "start"]);
    const grant = await until(() => {
      try { return JSON.parse(readFileSync(join(data, "bootstrap-grant.json"), "utf8")); } catch { return undefined; }
    }, "The prior environment did not write its grant");
    const origin = `http://${grant.address.host}:${grant.address.port}`;
    const discovery = await until(async () => {
      try {
        const document = await (await fetch(origin + discoveryPath, { signal: AbortSignal.timeout(2000) })).json();
        return document.readiness === "ready" && document.harnessVersion === baseline ? document : undefined;
      } catch { return undefined; }
    }, "The prior environment did not become ready");
    const response = await fetch(origin + "/api/bootstrap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: grant.secret, kind: "tui", label: "Packaged update smoke" }) });
    assert.equal(response.status, 200);
    const credential = await response.json();
    await configureIdle(origin, credential, discovery.protocolVersion);
    const secrets = join(data, "desktop", "secrets");
    mkdirSync(secrets, { recursive: true, mode: 0o700 });
    const seed = join(work, "credential.json");
    writeFileSync(seed, JSON.stringify({ token: credential.token, file: join(secrets, `${credentialName}.secret`) }), { mode: 0o600 });
    // Seed with synchronous safeStorage in a differently signed app, then replace that app at the same path.
    rmSync(join(resources, "app.asar"), { force: true });
    const app = join(resources, "app");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "agent-harness", productName: "agent-harness", version: baseline, type: "module", main: "main.js" }));
    writeFileSync(join(app, "main.js"), `import { app, safeStorage } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
app.setName('agent-harness');
app.setPath('userData', process.env.DESKTOP_FIXTURE);
await app.whenReady();
try {
  const seed = JSON.parse(readFileSync(process.env.CREDENTIAL_FIXTURE, 'utf8'));
  writeFileSync(seed.file, safeStorage.encryptString(seed.token), { mode: 0o600 });
  app.exit(0);
} catch { app.exit(1); }
`);
    execute("codesign", ["--force", "--deep", "--sign", "-", installed]);
    execute("security", ["create-keychain", "-p", "password-for-tests", keychain]);
    execute("security", ["unlock-keychain", "-p", "password-for-tests", keychain]);
    execute("security", ["default-keychain", "-d", "user", "-s", keychain]);
    execute("security", ["list-keychains", "-d", "user", "-s", keychain, ...originalSearchList]);
    // Both signatures are authorized for unattended CI; a real approval/cancel is checked manually.
    execute("security", ["add-generic-password", "-a", "agent-harness", "-s", "agent-harness Safe Storage", "-w", "password-for-tests", "-T", executable(installed), "-T", executable(source), keychain]);
    execFileSync(executable(installed), [], { env: { ...process.env, CREDENTIAL_FIXTURE: seed, DESKTOP_FIXTURE: join(data, "desktop") }, stdio: "pipe", timeout: 120_000 });
    const kept = readFileSync(join(secrets, `${credentialName}.secret`));
    assert.equal(kept.subarray(0, 3).toString(), "v10");
    assert.equal(kept.includes(Buffer.from(credential.token)), false);
    // Put the server CLI outside the app too, so cleanup still works after replacement.
    const cleanupServer = join(work, "cleanup-server");
    cpSync(server, cleanupServer, { recursive: true });
    fixtureCli = [join(cleanupServer, "node", "bin", "node"), join(cleanupServer, "packages", "cli", "dist", "main.js")];
    rmSync(installed, { recursive: true });
    cpSync(source, installed, { recursive: true });
    const port = 19280;
    desktop = spawn(executable(installed), [`--remote-debugging-port=${port}`], { stdio: "ignore" });
    // Record a spawn failure so it is surfaced by the bounded page check and still cleans the service.
    desktop.on("error", () => {});
    cdp = await connectCdp(port);
    await openPackagedSettings(cdp.evaluate);
    await askForPackagedUpdate(cdp.evaluate, version);
    assert.deepEqual(readFileSync(join(secrets, `${credentialName}.secret`)), kept, "Reading the existing credential must preserve it");
    const after = await until(async () => {
      try {
        const current = JSON.parse(readFileSync(join(data, "bootstrap-grant.json"), "utf8"));
        const doc = await (await fetch(`http://${current.address.host}:${current.address.port}${discoveryPath}`, { signal: AbortSignal.timeout(2000) })).json();
        return doc.harnessVersion === version && doc.readiness === "ready" ? doc : undefined;
      } catch { return undefined; }
    }, "The carried environment upgrade did not complete", 240_000);
    assert.equal(after.environmentId, discovery.environmentId, "The replacement must preserve the environment's identity");
    assert.equal(await cdp.evaluate("window.desktopShell.system().then(s => s.platform)"), "darwin");
    await cdp.evaluate("window.desktopShell.window.close()");
    await until(() => desktop.exitCode !== null, "The replacement window did not quit", 10_000);
    console.log(`Packaged replacement read the existing credential and upgraded ${baseline} to ${version}`);
  } finally {
    cdp?.close();
    let cleanupError;
    if (desktop) {
      try { await stopDesktop(); } catch (error) { cleanupError = error; }
      finally { if (desktop.exitCode === null && desktop.signalCode === null) desktop.kill("SIGKILL"); }
    }
    try {
      if (fixtureCli) execute(fixtureCli[0], [fixtureCli[1], "service", "uninstall"]);
    } finally {
      execute("security", ["default-keychain", "-d", "user", "-s", originalKeychain]);
      execute("security", ["list-keychains", "-d", "user", "-s", ...originalSearchList]);
      if (existsSync(keychain)) execute("security", ["delete-keychain", keychain]);
      rmSync(data, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
    assert.ifError(cleanupError);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runSmoke(resolve(process.argv[2]), process.env.VERSION);
}
