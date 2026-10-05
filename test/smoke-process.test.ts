import { PassThrough, type Readable } from "node:stream";
import { mkdtempSync, readFileSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { smokeProcess } from "./smoke-process.js";

const runningProcess = (pid: number) => {
  try { return !/\) [ZX] /.test(readFileSync(`/proc/${pid}/stat`, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
};

it.skipIf(process.platform !== "linux")("cancellation stops a held descendant after its command has exited", async () => {
  const signal = new AbortController();
  const output = new PassThrough();
  let text = "";
  let parentPid: number | undefined;
  let descendantPid: number | undefined;
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  output.on("data", chunk => {
    text += String(chunk);
    const parent = /parent (\d+)/.exec(text);
    const descendant = /descendant ready (\d+)/.exec(text);
    if (parent) parentPid = Number(parent[1]);
    if (descendant) { descendantPid = Number(descendant[1]); ready(); }
  });
  onTestFinished(() => {
    vi.useRealTimers(); signal.abort();
    for (const pid of [parentPid, descendantPid]) {
      if (pid === undefined) continue;
      try { process.kill(pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    output.destroy();
  });
  const leaf = "process.on('SIGTERM',()=>{}); console.log('descendant ready '+process.pid); process.send('ready'); setInterval(()=>{},60000);";
  const parent = `const {spawn}=require('node:child_process'); console.log('parent '+process.pid); const child=spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:['ignore','inherit','inherit','ipc']}); child.once('message',()=>process.exit(0));`;
  const execution = smokeProcess(process.execPath, ["-e", parent], { cwd: process.cwd(), signal: signal.signal, stdout: output, stderr: output });
  const reason = new Error("The exited command's smoke phase was cancelled.");
  const stopped = expect(execution).rejects.toBe(reason);
  await started;
  while (runningProcess(parentPid!)) await new Promise<void>(resolve => setImmediate(resolve));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  signal.abort(reason);
  await vi.advanceTimersByTimeAsync(5_000);
  await stopped;
  expect(runningProcess(descendantPid!)).toBe(false);
});

it.skipIf(process.platform !== "linux").each([false, true])("cancellation kills an ignoring descendant whose output is separate (detached: %s)", async detached => {
  const dir = mkdtempSync(join(tmpdir(), "smoke-descendant-"));
  const signal = new AbortController();
  const output = new PassThrough();
  let closed = 0;
  let outputClosed!: () => void;
  const pipesClosed = new Promise<void>(resolve => { outputClosed = resolve; });
  output.on("pipe", (source: Readable) => { source.once("close", () => { if (++closed === 2) outputClosed(); }); });
  const pids: number[] = [];
  let ready!: () => void;
  let ignored!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const terminationIgnored = new Promise<void>(resolve => { ignored = resolve; });
  const watcher = watch(dir, (_, filename) => { if (filename === "ignored") ignored(); });
  output.on("data", chunk => {
    const match = /ready (\d+) (\d+)/.exec(String(chunk));
    if (match) { pids.push(Number(match[1]), Number(match[2])); ready(); }
  });
  onTestFinished(() => {
    vi.useRealTimers();
    signal.abort();
    for (const pid of pids) {
      try { process.kill(pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    watcher.close(); output.destroy(); rmSync(dir, { recursive: true, force: true });
  });
  const leaf = `const {writeFileSync}=require('node:fs'); process.on('SIGTERM',()=>writeFileSync(${JSON.stringify(join(dir, "ignored"))},'ignored')); process.send(process.pid); setInterval(()=>{},60000);`;
  const parent = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{detached:${detached},stdio:['ignore','ignore','ignore','ipc']}); child.on('message',pid=>console.log('ready '+process.pid+' '+pid)); setInterval(()=>{},60000);`;
  const execution = smokeProcess(process.execPath, ["-e", parent], { cwd: process.cwd(), signal: signal.signal, stdout: output, stderr: output });
  const reason = new Error("The smoke phase was cancelled.");
  const stopped = expect(execution).rejects.toBe(reason);
  await started;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  signal.abort(reason);
  if (!detached) await terminationIgnored;
  // Observe parent exit before advancing the grace period: its output no longer holds close open.
  while (runningProcess(pids[0]!)) await new Promise<void>(resolve => setImmediate(resolve));
  await pipesClosed;
  await vi.advanceTimersByTimeAsync(5_000);
  await stopped;
  expect(runningProcess(pids[1]!)).toBe(false);
});

it.skipIf(process.platform !== "linux").each([
  { ignoresTermination: false, detached: false },
  { ignoresTermination: true, detached: false },
  { ignoresTermination: true, detached: true },
])("a cancelled smoke phase stops its held descendant (ignores termination: $ignoresTermination, detached: $detached)", async ({ ignoresTermination, detached }) => {
  const signal = new AbortController();
  const output = new PassThrough();
  let text = "";
  let pid: number | undefined;
  let descendant: number | undefined;
  let ready!: () => void;
  let ignored!: () => void;
  const terminationIgnored = new Promise<void>(resolve => { ignored = resolve; });
  const running = new Promise<void>(resolve => { ready = resolve; });
  output.on("data", chunk => {
    text += String(chunk);
    const match = /parent (\d+)/.exec(text);
    if (match) pid = Number(match[1]);
    const leaf = /descendant ready (\d+)/.exec(text);
    if (leaf) descendant = Number(leaf[1]);
    if (text.includes("descendant ready")) ready();
    if (text.includes("descendant ignored termination")) ignored();
    if (text.includes("descendant stopped")) ignored();
  });
  onTestFinished(() => {
    vi.useRealTimers();
    signal.abort();
    if (pid) {
      try { process.kill(-pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    if (descendant) {
      try { process.kill(descendant, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    output.destroy();
  });
  const leaf = `process.on('SIGTERM', () => { ${ignoresTermination ? "console.log('descendant ignored termination');" : "console.log('descendant stopped'); process.exit(0);"} }); console.log('descendant ready '+process.pid); setInterval(() => {}, 60000);`;
  const parent = `const {spawn} = require('node:child_process'); console.log('parent '+process.pid); spawn(process.execPath, ['-e', ${JSON.stringify(leaf)}], {detached:${detached},stdio: ['ignore', 'inherit', 'inherit']}); setInterval(() => {}, 60000);`;
  const execution = smokeProcess(process.execPath, ["-e", parent], { cwd: process.cwd(), signal: signal.signal, stdout: output, stderr: output });
  const reason = new Error("The held smoke phase was cancelled.");
  const stopped = expect(execution).rejects.toBe(reason);
  // Attach a rejection handler before the event that cancels the process.
  await running;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  signal.abort(reason);
  await terminationIgnored;
  await vi.advanceTimersByTimeAsync(5_000);
  await stopped;
  if (!ignoresTermination) expect(text).toContain("descendant stopped");
});

it.skipIf(process.platform !== "linux")("captures successful smoke output while streaming it to the job log", async () => {
  const output = new PassThrough();
  let log = "";
  output.on("data", chunk => { log += String(chunk); });
  onTestFinished(() => { output.destroy(); });
  const result = await smokeProcess(process.execPath, ["-e", "console.log('phase complete');"], {
    cwd: process.cwd(), signal: new AbortController().signal, stdout: output, stderr: output,
  });
  expect(result.stdout).toBe("phase complete\n");
  expect(log).toBe("phase complete\n");
});
