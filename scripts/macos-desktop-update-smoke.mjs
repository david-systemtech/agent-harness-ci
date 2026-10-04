import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import { randomUUID } from "node:crypto";
import process from "node:process";

import { spawn, execFileSync } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { collectMacosSmokeDiagnostics, finishSmoke, persistDesktopLog, persistSmokeFailure, redactDiagnostic } from "./macos-smoke-diagnostics.mjs";

const { fetch, AbortSignal, WebSocket } = globalThis;

const discoveryPath = "/.well-known/agent-harness/environment";
const credentialName = "packaged-update-check";
const baseline = "0.0.0-0";

/** Copies a packaged desktop for the prior install and its replacement. */
export function copyPackagedDesktop(source, destination) {
  cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
}

/** Prepares the prior install's runtime versions before installing its service. */
export function stampPriorPackagedServer(server, version) {
  // The release keeps only the CLI under packages; its workspace dependencies live under their scope.
  for (const directory of [join(server, "packages"), join(server, "node_modules", "@agent-harness")]) {
    for (const folder of readdirSync(directory)) {
      const manifest = join(directory, folder, "package.json");
      if (existsSync(manifest)) {
        const value = JSON.parse(readFileSync(manifest, "utf8"));
        value.version = version;
        writeFileSync(manifest, JSON.stringify(value));
      }
    }
  }
}

/** Writes the prior signed app that seeds the existing encrypted credential. */
export function prepareCredentialFixture(app) {
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "agent-harness", productName: "agent-harness", version: baseline, type: "module", main: "main.js" }));
  writeFileSync(join(app, "main.js"), `import { app, safeStorage } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
app.setName('agent-harness');
app.setPath('userData', process.env.DESKTOP_FIXTURE);
// Entry import must finish before Electron can emit ready.
app.whenReady().then(() => {
  try {
    const seed = JSON.parse(readFileSync(process.env.CREDENTIAL_FIXTURE, 'utf8'));
    writeFileSync(seed.file, safeStorage.encryptString(seed.token), { mode: 0o600 });
    app.exit(0);
  } catch { app.exit(1); }
}).catch(() => app.exit(1));
`);
}

/** Whether Settings has opened, queried through the packaged page's CDP boundary. */
export async function packagedSettingsOpen(evaluate) {
  return await evaluate("!!document.querySelector('section[aria-label=Settings]')", "Settings section readiness");
}

/** Progresses through first launch and opens Settings through the packaged page's CDP boundary. */
export async function clickPackagedSettings(evaluate) {
  return await evaluate(`(() => {
    const button = document.querySelector('button[aria-label=Settings]');
    if (button) {
      button.click();
      return true;
    }
    const clickNamed = (root, name) => {
      const action = Array.from(root?.querySelectorAll('button') ?? []).find(candidate => candidate.textContent.trim() === name);
      action?.click();
    };
    // The credential-only prior app has no completed GUI setup. Use the visible first-launch controls.
    const confirmation = Array.from(document.querySelectorAll('[role=dialog]')).find(dialog =>
      dialog.textContent.includes('Leave set up without an account?'));
    if (confirmation) clickNamed(confirmation, 'Leave for now');
    else clickNamed(document.querySelector('[data-setup-introduction]'), 'I’ll set up later');
    return false;
  })()`, "first-launch controls and Settings click");
}

/** Waits for the packaged page and opens its Settings control through CDP. */
export async function openPackagedSettings(evaluate) {
  // The target can appear while its execution context is still being replaced.
  const ready = (check, message) => until(() => check().catch(error => {
    if (error.smokeTimeout) throw error;
    return false;
  }), message);
  await ready(() => evaluate("typeof window.desktopShell === 'object'", "packaged preload readiness"), "The packaged preload did not load");
  await ready(() => clickPackagedSettings(evaluate), "The Settings control did not mount");
  await ready(() => packagedSettingsOpen(evaluate), "Settings did not open after replacement");
}

/** Your machines must mount during native access, rather than only the Settings frame. */
export async function openPackagedMachines(evaluate) {
  assert.equal(await evaluate(`(() => {
    const row = document.querySelector('nav[aria-label="Settings rows"] button[aria-label="Your machines"]');
    row?.click();
    return !!row;
  })()`, "open Your machines during credential access"), true);
  await until(() => evaluate(`!!document.querySelector('section[aria-label="Your machines"]')`, "Your machines readiness"), "Your machines did not mount during credential access");
}

/** Starts a real prior read without awaiting it, so responsiveness is checked while access is pending/refused. */
export async function startUnavailablePackagedCredential(evaluate) {
  await evaluate(`(() => {
    window.__packagedCredentialCheck = { result: window.desktopShell.secrets.get(${JSON.stringify(credentialName)})
      .then(() => 'read', () => 'unavailable') };
    return true;
  })()`, "begin locked prior credential");
  assert.equal(await evaluate("window.desktopShell.system().then(s => s.platform)", "main responsiveness during locked credential access"), "darwin");
  assert.equal(await packagedSettingsOpen(evaluate), true, "Settings must remain open during locked credential access");
}

/** Requires bounded settlement, rather than treating a harness timeout as a successful refusal. */
export async function checkUnavailablePackagedCredential(evaluate, observe = async () => {}) {
  await startUnavailablePackagedCredential(evaluate);
  await observe();
  const result = await evaluate(`(async () => {
    const result = await window.__packagedCredentialCheck.result;
    delete window.__packagedCredentialCheck;
    return result;
  })()`, "settle unavailable prior credential", 45_000);
  assert.equal(result, "unavailable", "The locked prior credential must be unavailable");
}

/** Exercises fresh storage after repair through the real packaged shell, without returning secrets. */
export async function checkFreshPackagedCredential(evaluate) {
  const result = await evaluate(`(async () => {
    const secrets = window.desktopShell.secrets;
    if (await secrets.protection() !== 'os') return false;
    const name = 'packaged-fresh-check';
    const value = 'credential-for-tests-fresh';
    await secrets.set(name, value);
    try { return await secrets.get(name) === value; }
    finally { await secrets.delete(name); }
  })()`, "fresh OS-protected credential storage and readback");
  assert.equal(result, true, "Fresh storage must be OS-protected and read back correctly");
}

/** Clicks the OS's own approval control, as a user would, only on the hosted smoke account. */
async function approveHostedKeychain(desktop, completed) {
  const deadline = Date.now() + 120_000;
  while (!completed() && desktop.exitCode === null && Date.now() < deadline) {
    const prompt = spawn("osascript", ["-e", `tell application "System Events"
      if exists process "SecurityAgent" then
        tell process "SecurityAgent"
          repeat with panel in windows
            if exists button "Always Allow" of panel then
              click button "Always Allow" of panel
            else if exists button "Allow" of panel then
              click button "Allow" of panel
            end if
          end repeat
        end tell
      end if
    end tell`], { stdio: "ignore" });
    await new Promise(resolve => {
      const timeout = globalThis.setTimeout(() => { prompt.kill("SIGKILL"); resolve(); }, 2000);
      prompt.on("error", () => { globalThis.clearTimeout(timeout); resolve(); });
      prompt.on("exit", () => { globalThis.clearTimeout(timeout); resolve(); });
    });
    await delay(250);
  }
}

/** Runs on hosted macOS only. The credential stays inside the page; no token is returned or logged. */
export async function askForPackagedUpdate(evaluate, version) {
  const deadline = Date.now() + 120_000;
  const run = (expression, stage) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw smokeTimeout(stage, expression);
    return evaluate(expression, stage, remaining);
  };
  // State stays inside the trusted page and is removed after the check. No credential returns over CDP.
  await run(`(async () => {
    const token = await window.desktopShell.secrets.get(${JSON.stringify(credentialName)});
    if (!token) throw new Error("The replacement could not read the prior install's credential");
    window.__packagedUpdateSmoke = { token };
    return true;
  })()`, "read prior credential");
  await run(`(async () => {
    const state = window.__packagedUpdateSmoke;
    state.grant = await window.desktopShell.localGrant.read();
    state.origin = 'http://' + state.grant.address.host + ':' + state.grant.address.port;
    return true;
  })()`, "read local grant");
  await run(`(async () => {
    const state = window.__packagedUpdateSmoke;
    state.before = await (await window.desktopShell.http(state.origin + ${JSON.stringify(discoveryPath)})).json();
    return true;
  })()`, "read prior discovery");
  await run(`(async () => {
    window.__packagedUpdateSmoke.bundled = await window.desktopShell.installer.bundledServer();
    return true;
  })()`, "read carried server");
  await run(`(async () => {
    const state = window.__packagedUpdateSmoke;
    state.response = await window.desktopShell.http(state.origin + '/api/update', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token },
      body: JSON.stringify({ version: state.bundled.version, artefactPath: state.bundled.path }),
    });
    delete state.token;
    return true;
  })()`, "authorize carried update");
  await run(`(async () => {
    const state = window.__packagedUpdateSmoke;
    state.toVersion = (await state.response.json()).toVersion;
    return true;
  })()`, "read update response");
  await run(`window.desktopShell.system().then(system => {
    window.__packagedUpdateSmoke.platform = system.platform;
    return true;
  })`, "main responsiveness after credential access");
  const result = await run(`(() => {
    const state = window.__packagedUpdateSmoke;
    const result = { fromVersion: state.before.harnessVersion, carriedVersion: state.bundled.version,
      status: state.response.status, toVersion: state.toVersion, platform: state.platform };
    delete window.__packagedUpdateSmoke;
    return result;
  })()`, "finish carried update check");
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
  throw smokeTimeout(message, check.toString());
}

async function connectCdp(port, options) {
  const page = await until(async () => {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
      return targets.find((target) => target.type === "page" && target.url.startsWith("agent-harness:"));
    } catch { return undefined; }
  }, "The packaged window did not expose its page");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => { socket.close(); reject(smokeTimeout("CDP connection", page.webSocketDebuggerUrl)); }, 30_000);
    socket.onopen = () => { globalThis.clearTimeout(timeout); resolve(); };
    socket.onerror = () => { globalThis.clearTimeout(timeout); reject(new Error("The packaged page's CDP connection failed")); };
  });
  return createCdpEvaluator(socket, options);
}

/** A timeout carries its operation without claiming which process is blocked. */
export function smokeTimeout(stage, expression) {
  return Object.assign(new Error(`Timed out at ${stage}; expression/check: ${expression}`), { smokeTimeout: true, stage, expression });
}

/** The packaged page evaluation boundary, independent of target discovery. */
export function createCdpEvaluator(socket, { onTimeout = async () => {}, redact = (text) => text } = {}) {
  let id = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const frame = JSON.parse(data);
    const answer = pending.get(frame.id);
    if (!answer) return;
    pending.delete(frame.id);
    if (frame.error || frame.result.exceptionDetails) {
      const reason = frame.error?.message ?? frame.result.exceptionDetails?.exception?.description ?? frame.result.exceptionDetails?.text ?? "Packaged page evaluation failed";
      answer.reject(new Error(redact(`Evaluation failed at ${answer.stage}; expression/check: ${answer.expression}\n${reason}`)));
    }
    else answer.resolve(frame.result.result.value);
  };
  socket.onclose = () => { for (const answer of pending.values()) answer.reject(new Error("The packaged window disconnected")); };
  return {
    evaluate: (expression, stage = "packaged page evaluation", milliseconds = 120_000) => new Promise((resolve, reject) => {
      const next = ++id;
      const timeout = globalThis.setTimeout(() => {
        pending.delete(next);
        const error = smokeTimeout(stage, redact(expression));
        Promise.resolve().then(() => onTimeout(error)).catch(() => {}).finally(() => reject(error));
      }, milliseconds);
      pending.set(next, { stage, expression, resolve: (value) => { globalThis.clearTimeout(timeout); resolve(value); }, reject: (error) => { globalThis.clearTimeout(timeout); reject(error); } });
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
      timeout = globalThis.setTimeout(() => reject(smokeTimeout("configure prior idle window", "updates.settings.set")), 30_000);
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
  } finally { globalThis.clearTimeout(timeout); socket.close(); }
}

async function runSmoke(source, version, { diagnostics, secretsToRedact }) {
  assert.equal(process.platform, "darwin");
  const data = join(homedir(), "Library", "Application Support", "agent-harness");
  assert.equal(existsSync(data), false, "The hosted smoke user must have no existing environment data");
  const work = mkdtempSync(join(tmpdir(), "macos-desktop-update-"));
  const installed = join(work, "agent-harness.app");
  const keychain = join(work, "smoke.keychain-db");
  let originalKeychain;
  let originalSearchList;
  let desktop;
  let cdp;
  let fixtureCli;
  let failure;
  let evidence;
  const privateDiagnostics = join(work, "diagnostics-private");
  mkdirSync(privateDiagnostics, { mode: 0o700 });
  const capture = (error) => evidence ??= collectMacosSmokeDiagnostics({
    directory: diagnostics, privateDirectory: privateDiagnostics, pid: desktop?.pid ?? error.pid,
    error, secrets: secretsToRedact,
  });
  const logFailure = (prefix, error) => console.error(prefix, redactDiagnostic(error.stack ?? String(error), secretsToRedact));
  const execute = (command, args, options = {}) => {
    try { return execFileSync(command, args, { stdio: "pipe", timeout: 120_000, ...options }); }
    catch (error) {
      if (error.code === "ETIMEDOUT") throw Object.assign(smokeTimeout(`command ${command}`, redactDiagnostic(JSON.stringify(args), secretsToRedact)), { pid: error.pid });
      throw error;
    }
  };
  const executable = (app) => join(app, "Contents", "MacOS", execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", join(app, "Contents", "Info.plist")], { encoding: "utf8" }).trim());
  const stopDesktop = async () => {
    if (!desktop || desktop.exitCode !== null || desktop.signalCode !== null) return;
    desktop.kill("SIGTERM");
    await until(() => desktop.exitCode !== null || desktop.signalCode !== null, "The packaged desktop did not respond to SIGTERM", 10_000);
  };
  try {
    originalKeychain = execute("security", ["default-keychain", "-d", "user"], { encoding: "utf8" }).trim().replace(/^"|"$/g, "");
    originalSearchList = [...execute("security", ["list-keychains", "-d", "user"], { encoding: "utf8" }).matchAll(/"([^"\n]+)"/g)].map((match) => match[1]);
    copyPackagedDesktop(source, installed);
    const resources = join(installed, "Contents", "Resources");
    // A prior-install fixture of the release's server code, stamped lower, tests the real launcher handover.
    // Actual 0.1.0 data migration and interactive OS approval are the manual checklist.
    const server = join(resources, "server");
    stampPriorPackagedServer(server, baseline);
    fixtureCli = [join(server, "node", "bin", "node"), join(server, "packages", "cli", "dist", "main.js")];
    execute(fixtureCli[0], [fixtureCli[1], "service", "install"]);
    execute(fixtureCli[0], [fixtureCli[1], "service", "start"]);
    const grant = await until(() => {
      try { return JSON.parse(readFileSync(join(data, "bootstrap-grant.json"), "utf8")); } catch { return undefined; }
    }, "The prior environment did not write its grant");
    secretsToRedact.push(grant.secret);
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
    secretsToRedact.push(credential.token);
    await configureIdle(origin, credential, discovery.protocolVersion);
    const secrets = join(data, "desktop", "secrets");
    mkdirSync(secrets, { recursive: true, mode: 0o700 });
    const seed = join(work, "credential.json");
    writeFileSync(seed, JSON.stringify({ token: credential.token, file: join(secrets, `${credentialName}.secret`) }), { mode: 0o600 });
    // Seed with synchronous safeStorage in a differently signed app, then replace that app at the same path.
    rmSync(join(resources, "app.asar"), { force: true });
    const app = join(resources, "app");
    prepareCredentialFixture(app);
    execute("codesign", ["--force", "--deep", "--sign", "-", installed]);
    execute("security", ["create-keychain", "-p", "password-for-tests", keychain]);
    execute("security", ["unlock-keychain", "-p", "password-for-tests", keychain]);
    execute("security", ["default-keychain", "-d", "user", "-s", keychain]);
    execute("security", ["list-keychains", "-d", "user", "-s", keychain, ...originalSearchList]);
    // Only the prior app is authorized. Replacement access follows a real OS request and repair.
    execute("security", ["add-generic-password", "-a", "agent-harness", "-s", "agent-harness Safe Storage", "-w", "password-for-tests", "-T", executable(installed), keychain]);
    const seedLog = openSync(join(privateDiagnostics, "desktop.log"), "a", 0o600);
    try { execute(executable(installed), [], { env: { ...process.env, CREDENTIAL_FIXTURE: seed, DESKTOP_FIXTURE: join(data, "desktop") }, stdio: ["ignore", seedLog, seedLog] }); }
    finally { closeSync(seedLog); }
    const kept = readFileSync(join(secrets, `${credentialName}.secret`));
    assert.equal(kept.subarray(0, 3).toString(), "v10");
    assert.equal(kept.includes(Buffer.from(credential.token)), false);
    // Put the server CLI outside the app too, so cleanup still works after replacement.
    const cleanupServer = join(work, "cleanup-server");
    cpSync(server, cleanupServer, { recursive: true });
    fixtureCli = [join(cleanupServer, "node", "bin", "node"), join(cleanupServer, "packages", "cli", "dist", "main.js")];
    rmSync(installed, { recursive: true });
    copyPackagedDesktop(source, installed);
    const port = 19280;
    const launchDesktop = async () => {
      const desktopLog = openSync(join(privateDiagnostics, "desktop.log"), "a", 0o600);
      try { desktop = spawn(executable(installed), [`--remote-debugging-port=${port}`], { stdio: ["ignore", desktopLog, desktopLog] }); }
      finally { closeSync(desktopLog); }
      // Record a spawn failure so it is surfaced by the bounded page check and still cleans the service.
      desktop.on("error", () => {});
      cdp = await connectCdp(port, { onTimeout: capture, redact: text => redactDiagnostic(text, secretsToRedact) });
      await openPackagedSettings(cdp.evaluate);
      await openPackagedMachines(cdp.evaluate);
    };
    // A locked test Keychain creates actual native pending/refused access, with no provider stub.
    execute("security", ["lock-keychain", keychain]);
    await launchDesktop();
    await startUnavailablePackagedCredential(cdp.evaluate);
    await until(async () => (await cdp.evaluate("window.desktopShell.secrets.access()", "native access started")) !== null, "Native credential access did not start");
    await cdp.evaluate("window.desktopShell.window.close()", "quit with native credential access pending");
    await until(() => desktop.exitCode !== null, "The replacement did not quit during pending Keychain access", 10_000);
    cdp.close();
    assert.deepEqual(readFileSync(join(secrets, `${credentialName}.secret`)), kept);
    await launchDesktop();
    await checkUnavailablePackagedCredential(cdp.evaluate);
    assert.deepEqual(readFileSync(join(secrets, `${credentialName}.secret`)), kept);
    // Unlock is the user's repair action. Approval is through the native prompt; no ACL or partition-list rewrite.
    execute("security", ["unlock-keychain", "-p", "password-for-tests", keychain]);
    let completed = false;
    const approval = approveHostedKeychain(desktop, () => completed);
    try {
      await askForPackagedUpdate(cdp.evaluate, version);
      await checkFreshPackagedCredential(cdp.evaluate);
    } finally { completed = true; await approval; }
    assert.deepEqual(readFileSync(join(secrets, `${credentialName}.secret`)), kept, "Reading the existing credential must preserve it");
    const after = await until(async () => {
      try {
        const current = JSON.parse(readFileSync(join(data, "bootstrap-grant.json"), "utf8"));
        const doc = await (await fetch(`http://${current.address.host}:${current.address.port}${discoveryPath}`, { signal: AbortSignal.timeout(2000) })).json();
        return doc.harnessVersion === version && doc.readiness === "ready" ? doc : undefined;
      } catch { return undefined; }
    }, "The carried environment upgrade did not complete", 240_000);
    assert.equal(after.environmentId, discovery.environmentId, "The replacement must preserve the environment's identity");
    assert.equal(await cdp.evaluate("window.desktopShell.system().then(s => s.platform)", "post-upgrade main responsiveness"), "darwin");
    await cdp.evaluate("window.desktopShell.window.close()", "close replacement window");
    await until(() => desktop.exitCode !== null, "The replacement window did not quit", 10_000);
    console.log(`Packaged replacement read the existing credential and upgraded ${baseline} to ${version}`);
  } catch (error) {
    failure = error;
    logFailure("Packaged replacement failed before cleanup:", error);
    try { persistSmokeFailure(diagnostics, error, secretsToRedact); }
    catch (recordError) { logFailure("Failure persistence failed:", recordError); }
    if (error.smokeTimeout) {
      try { await capture(error); } catch (collectionError) { logFailure("Timeout evidence collection failed:", collectionError); }
    }
  } finally {
    await finishSmoke(failure, [
      async () => { cdp?.close(); },
      async () => {
        if (!desktop) return;
        try { await stopDesktop(); }
        finally { if (desktop.exitCode === null && desktop.signalCode === null) desktop.kill("SIGKILL"); }
      },
      async () => { if (existsSync(diagnostics)) persistDesktopLog(diagnostics, privateDiagnostics, secretsToRedact); },
      async () => { if (fixtureCli) execute(fixtureCli[0], [fixtureCli[1], "service", "uninstall"]); },
      async () => { if (originalKeychain !== undefined) execute("security", ["default-keychain", "-d", "user", "-s", originalKeychain]); },
      async () => { if (originalSearchList !== undefined) execute("security", ["list-keychains", "-d", "user", "-s", ...originalSearchList]); },
      async () => { if (existsSync(keychain)) execute("security", ["delete-keychain", keychain]); },
      async () => { rmSync(data, { recursive: true, force: true }); },
      async () => { rmSync(work, { recursive: true, force: true }); },
    ], error => {
      logFailure("Packaged replacement cleanup failed:", error);
      persistSmokeFailure(diagnostics, error, secretsToRedact);
      persistDesktopLog(diagnostics, privateDiagnostics, secretsToRedact);
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const diagnostics = resolve(process.env.SMOKE_DIAGNOSTICS ?? "macos-update-diagnostics");
  const secretsToRedact = ["password-for-tests"];
  try { await runSmoke(resolve(process.argv[2]), process.env.VERSION, { diagnostics, secretsToRedact }); }
  catch (error) {
    try { persistSmokeFailure(diagnostics, error, secretsToRedact); }
    catch (recordError) { console.error("Failure persistence failed:", redactDiagnostic(recordError.stack ?? String(recordError), secretsToRedact)); }
    // Log only the sanitized stack, never the child-process object with output or environment fields.
    console.error("Packaged replacement failed:", redactDiagnostic(error.stack ?? String(error), secretsToRedact));
    process.exitCode = 1;
  }
}
