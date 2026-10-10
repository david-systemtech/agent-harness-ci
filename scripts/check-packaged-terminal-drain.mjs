import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { log } from "node:console";
import { randomUUID } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export async function waitFor(check, description) {
  const deadline = Date.now() + 120_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `Timed out: ${description}`);
    await delay(100);
  }
}

export function alive(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "Expected an owned process PID");
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

// Exercise the real native helper against a PID whose console has already gone.
export async function checkGoneConsole(helperPath, pid) {
  const helper = fork(helperPath, [String(pid)], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stderr = "";
  let message;
  helper.stderr.on("data", (bytes) => { stderr += bytes; });
  helper.on("message", (value) => { message = value; });
  const deadline = setTimeout(() => helper.kill(), 10_000);
  try {
    const code = await new Promise((resolve, reject) => {
      helper.on("error", reject);
      helper.on("close", resolve);
    });
    assert.equal(code, 0, "Gone-console helper must exit normally");
    assert.equal(stderr, "", "Gone-console helper must not print an uncaught stack trace");
    assert.deepEqual(message, { consoleProcessList: [] });
  } finally { clearTimeout(deadline); if (helper.exitCode === null) helper.kill(); }
}

// The runtime boundary used by the packaged drain's terminal and update commands.
export async function requestDrainCommand(runtime, environmentId, name, params, newCommandId) {
  const answer = await runtime.requests.call(environmentId, name, { ...params, commandId: newCommandId() });
  assert.ok(answer.ok, JSON.stringify(answer));
  assert.equal(answer.result.receipt.status, "accepted", JSON.stringify(answer.result));
  return answer.result.result;
}

// Real shipped CLI, launcher, environment, node-pty and OS processes. No service manager or owner data.
export async function checkPackagedTerminalDrain(server) {
  assert.equal(process.platform, "win32", "This check needs real Windows ConPTY");
  const require = createRequire(join(server, "packages/cli/package.json"));
  const { startLauncher } = await import(pathToFileURL(join(server, "packages/cli/dist/launch/launcher.js")));
  const screenless = require.resolve("@agent-harness/tui/screenless");
  const { selectTerminalEnvironment } = await import(pathToFileURL(screenless));
  const { uuidv7 } = await import(pathToFileURL(createRequire(screenless).resolve("@agent-harness/client-runtime")));
  const version = JSON.parse(readFileSync(join(server, "packages/cli/package.json"))).version;
  const target = version === "99.0.0" ? "99.0.1" : "99.0.0";
  const work = mkdtempSync(join(tmpdir(), "packaged-terminal-drain-"));
  const dataDir = join(work, "data");
  const candidate = join(work, "candidate");
  const output = openSync(join(work, "service.log"), "a");
  const owned = new Set();
  const shellPidFile = join(work, "shell-pid");
  const childPidFile = join(work, "child-pids.json");
  const readPid = (file) => {
    if (!existsSync(file)) return undefined;
    const pid = Number(readFileSync(file, "utf8").trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  };
  const terminateOwned = () => {
    for (const pid of owned) {
      assert.ok(Number.isSafeInteger(pid) && pid > 0, "Expected an owned process PID");
      try { process.kill(pid); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  };
  let launcher;
  let selection;
  try {
    const initial = join(dataDir, "versions", version);
    cpSync(server, initial, { recursive: true });
    writeFileSync(join(initial, ".complete"), "");
    cpSync(server, candidate, { recursive: true });
    // Same release's code and dependencies, a distinct version to enter a real update trial.
    for (const path of ["packages/cli/package.json", "node_modules/@agent-harness/environment/package.json"]) {
      const file = join(candidate, path);
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file)), version: target }));
    }
    writeFileSync(join(dataDir, "service-state.json"), JSON.stringify({ activeVersion: version, previousVersion: null,
      launcherVersion: version, pendingUpdate: null, watchDeadline: null, watchedUpdateId: null, stagedVersion: null, failedHandover: null }));
    const listener = createServer();
    await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = listener.address().port;
    await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    const ready = async (expected) => {
      try {
        const response = await globalThis.fetch(`http://127.0.0.1:${port}/.well-known/agent-harness/environment`, { signal: globalThis.AbortSignal.timeout(2000) });
        const discovery = await response.json();
        return discovery.readiness === "ready" && discovery.harnessVersion === expected;
      } catch { return false; }
    };
    launcher = startLauncher({ dataDir, version, port, output, log: (line) => log(line) });
    await waitFor(() => ready(version), "initial packaged environment ready");
    const chosen = await selectTerminalEnvironment({ dataDir, version, stateDir: join(work, "client"),
      report: (message) => { throw new Error(message); } });
    assert.ok(chosen.ok, chosen.message);
    selection = chosen.selection;
    const environmentId = selection.environment.environmentId;
    const command = async (name, params) => {
      const answer = await selection.runtime.commands.dispatch(environmentId, name, params);
      assert.ok(answer.ok, JSON.stringify(answer));
      return answer.result;
    };
    const request = (name, params) => requestDrainCommand(selection.runtime, environmentId, name, params, () => uuidv7(new Date()));
    const sessionId = randomUUID();
    await command("sessions.create", { id: sessionId, title: "Terminal drain smoke", workspace: { kind: "directory", path: work } });
    const gonePidFile = join(work, "gone-pid");
    const fixture = join(work, "children.cjs");
    writeFileSync(fixture, `
      const { spawn } = require('node:child_process');
      const { renameSync, writeFileSync } = require('node:fs');
      if (process.argv[2] !== 'leaf') {
        spawn(process.execPath, [__filename, 'leaf', String(process.pid), process.argv[2]], { stdio: 'inherit' });
      } else {
        const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
        writeFileSync(process.argv[4] + ".partial", JSON.stringify([Number(process.argv[3]), process.pid, grandchild.pid]));
        renameSync(process.argv[4] + ".partial", process.argv[4]);
      }
      setInterval(() => {}, 1000);
    `);
    const quote = (text) => `'${text.replaceAll("'", "''")}'`;
    const runningId = randomUUID();
    await request("terminals.open", { id: runningId, sessionId });
    await request("terminals.write", { id: runningId, data: `Set-Content -LiteralPath ${quote(shellPidFile)} -Value $PID; & ${quote(process.execPath)} ${quote(fixture)} ${quote(childPidFile)}\r` });
    await waitFor(() => existsSync(childPidFile) && readPid(shellPidFile) !== undefined, "shell and its child/grandchild ready");
    owned.add(readPid(shellPidFile));
    for (const pid of JSON.parse(readFileSync(childPidFile))) owned.add(pid);
    assert.equal(owned.size, 4, "Owns a shell, command, child and grandchild");
    for (const pid of owned) assert.ok(alive(pid), `Owned process ${pid} is running before drain`);
    const goneId = randomUUID();
    await request("terminals.open", { id: goneId, sessionId });
    await request("terminals.write", { id: goneId, data: `Set-Content -LiteralPath ${quote(gonePidFile)} -Value $PID; exit\r` });
    await waitFor(() => readPid(gonePidFile) !== undefined && !alive(readPid(gonePidFile)), "second console exited before drain");
    const nativeRequire = createRequire(require.resolve("@agent-harness/environment"));
    await checkGoneConsole(nativeRequire.resolve("node-pty/lib/conpty_console_list_agent.js"), readPid(gonePidFile));
    await request("updates.apply", { version: target, artefactPath: candidate, when: "now" });
    await waitFor(() => [...owned].every((pid) => !alive(pid)), "all terminal-owned processes exited during update drain");
    await waitFor(() => ready(target), "packaged update trial committed and ready");
    const state = JSON.parse(readFileSync(join(dataDir, "service-state.json")));
    assert.equal(state.activeVersion, target);
    assert.equal(state.pendingUpdate, null);
    assert.doesNotMatch(readFileSync(join(work, "service.log"), "utf8"), /AttachConsole failed|conpty_console_list_agent\.js:\d|node-pty:|UnhandledPromiseRejection/);
    log("Verified packaged Windows terminal drain: shell, child and grandchild exited; gone console quiet; update trial ready");
  } catch (error) {
    log(readFileSync(join(work, "service.log"), "utf8"));
    throw error;
  } finally {
    // Read any processes started before a readiness assertion failed, too.
    if (readPid(shellPidFile) !== undefined) owned.add(readPid(shellPidFile));
    if (existsSync(childPidFile)) for (const pid of JSON.parse(readFileSync(childPidFile))) owned.add(pid);
    try {
      await selection?.close();
    } finally {
      try {
        await launcher?.end();
      } finally {
        try { terminateOwned(); } finally {
          closeSync(output);
          rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        }
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.ok(process.argv[2], "Expected packaged server directory");
  await checkPackagedTerminalDrain(resolve(process.argv[2]));
}
