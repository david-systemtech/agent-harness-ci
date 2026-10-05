import { execFileSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { smokeProcess } from "./smoke-process.js";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const runningProcess = (pid: number) => {
  try { return !/\) [ZX] /.test(readFileSync(`/proc/${pid}/stat`, "utf8")); }
  catch (error) { if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false; throw error; }
};

it.each(["ENOENT", "ESRCH"])("observes a process that disappears during a procfs read as exited (%s)", code => {
  const error = Object.assign(new Error("The process disappeared during read."), { code });
  const read = vi.mocked(readFileSync).mockImplementationOnce(() => { throw error; });
  try { expect(runningProcess(123)).toBe(false); }
  finally { read.mockReset(); }
});

it.each(["EACCES", "EIO"])("propagates an unrelated procfs read error (%s)", code => {
  const error = Object.assign(new Error("Cannot read process state."), { code });
  const read = vi.mocked(readFileSync).mockImplementationOnce(() => { throw error; });
  try { expect(() => runningProcess(123)).toThrow(error); }
  finally { read.mockReset(); }
});

it.skipIf(process.platform !== "linux").each([false, true])("cancellation stops a held descendant after its command has exited (detached: %s)", async detached => {
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
    vi.useRealTimers(); signal.abort(reason);
    for (const pid of [parentPid, descendantPid]) {
      if (pid === undefined) continue;
      try { process.kill(pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    output.destroy();
  });
  const leaf = "process.on('SIGTERM',()=>{}); console.log('descendant ready '+process.pid); process.send('ready'); setInterval(()=>{},60000);";
  const parent = `const {spawn}=require('node:child_process'); console.log('parent '+process.pid); const child=spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{detached:${detached},stdio:['ignore','inherit','inherit','ipc']}); child.once('message',()=>process.exit(0));`;
  const execution = smokeProcess(process.execPath, ["-e", parent], { cwd: process.cwd(), signal: signal.signal, stdout: output, stderr: output });
  const reason = new Error("The exited command's smoke phase was cancelled.");
  const stopped = expect(execution).rejects.toBe(reason);
  try {
    await started;
    while (runningProcess(parentPid!)) await new Promise<void>(resolve => setImmediate(resolve));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    signal.abort(reason);
    await vi.advanceTimersByTimeAsync(5_000);
    await stopped;
    expect(runningProcess(descendantPid!)).toBe(false);
  } finally {
    // Observation errors must still settle the cancellation assertion before this test finishes.
    if (!signal.signal.aborted) vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    signal.abort(reason);
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(5_000);
    await stopped;
  }
});

it.skipIf(process.platform !== "linux").each([false, true])("cancellation kills an ignoring descendant whose output is separate (detached: %s)", async detached => {
  const dir = mkdtempSync(join(tmpdir(), "smoke-descendant-"));
  const signal = new AbortController();
  const output = new PassThrough();
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
    signal.abort(reason);
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
  try {
    await started;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    signal.abort(reason);
    if (!detached) await terminationIgnored;
    // Observe command exit while its ignoring descendant still belongs to this phase.
    while (runningProcess(pids[0]!)) await new Promise<void>(resolve => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(5_000);
    await stopped;
    expect(runningProcess(pids[1]!)).toBe(false);
  } finally {
    // Observation errors must still settle the cancellation assertion before this test finishes.
    if (!signal.signal.aborted) vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    signal.abort(reason);
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(5_000);
    await stopped;
  }
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
    signal.abort(reason);
    if (pid) {
      try { process.kill(pid, "SIGKILL"); }
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
  try {
    // Attach a rejection handler before the event that cancels the process.
    await running;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    signal.abort(reason);
    await terminationIgnored;
    await vi.advanceTimersByTimeAsync(5_000);
    await stopped;
    if (!ignoresTermination) expect(text).toContain("descendant stopped");
  } finally {
    // Observation errors must still settle the cancellation assertion before this test finishes.
    if (!signal.signal.aborted) vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    signal.abort(reason);
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(5_000);
    await stopped;
  }
});

it.skipIf(process.platform !== "linux")("captures successful smoke output while streaming it to the job log", async () => {
  const output = new PassThrough();
  let log = "";
  output.on("data", chunk => { log += String(chunk); });
  onTestFinished(() => { output.destroy(); });
  const result = await smokeProcess(process.execPath, ["-e", "console.error('phase diagnostic'); process.stdin.on('end',()=>console.log('phase complete')); process.stdin.resume();"], {
    cwd: process.cwd(), signal: new AbortController().signal, stdout: output, stderr: output,
  });
  expect(result.stdout).toBe("phase complete\n");
  expect(log).toContain("phase complete\n");
  expect(log).toContain("phase diagnostic\n");
});

it.skipIf(process.platform !== "linux")("preserves the command's failure status after reaping its process tree", async () => {
  const output = new PassThrough();
  output.resume();
  onTestFinished(() => { output.destroy(); });
  await expect(smokeProcess(process.execPath, ["-e", "process.exit(7);"], {
    cwd: process.cwd(), signal: new AbortController().signal, stdout: output, stderr: output,
  })).rejects.toThrow(`${process.execPath} exited with 7.`);
});

it.skipIf(process.platform !== "linux")("cancellation preserves its reason when the caller cannot signal an owned descendant", async () => {
  const controller = new AbortController();
  const output = new PassThrough();
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  let pid = 0;
  output.on("data", chunk => {
    const match = /protected ready (\d+)/.exec(String(chunk));
    if (match) { pid = Number(match[1]); ready(); }
  });
  const originalKill = process.kill.bind(process);
  const kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
    if (target === pid) throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    return originalKill(target, signal);
  });
  const reason = new Error("Installer deadline expired.");
  const execution = smokeProcess(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); console.log('protected ready '+process.pid); setInterval(()=>{},60000);"], {
    cwd: process.cwd(), signal: controller.signal, stdout: output, stderr: output,
  });
  const stopped = expect(execution).rejects.toBe(reason);
  try {
    await started;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(5_000);
    await stopped;
    expect(runningProcess(pid)).toBe(false);
  } finally {
    kill.mockRestore(); vi.useRealTimers();
    if (pid && runningProcess(pid)) originalKill(pid, "SIGKILL");
    output.destroy();
  }
});


const hostedOrdinaryUser = process.env["GITHUB_ACTIONS"] === "true" && process.env["RUNNER_ENVIRONMENT"] === "github-hosted" && process.getuid?.() !== 0;

it.skipIf(!hostedOrdinaryUser).each([false, true])("an ordinary caller cancels a privileged installer descendant (detached: %s)", async detached => {
  const controller = new AbortController();
  const output = new PassThrough();
  let text = "";
  let pid = 0;
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  output.on("data", chunk => {
    text += String(chunk);
    const match = /privileged ready (\d+) uid=0/.exec(text);
    if (match) { pid = Number(match[1]); ready(); }
  });
  const leaf = `import os, signal, time; ${detached ? "child = os.fork(); os._exit(0) if child else None; os.setsid();" : ""} signal.signal(signal.SIGTERM, lambda *_: None); print('privileged ready '+str(os.getpid())+' uid='+str(os.getuid()), flush=True); time.sleep(600)`;
  const parent = `const {spawn}=require('node:child_process'); console.log('installer uid='+process.getuid()); spawn('sudo',['-n','--','python3','-c',${JSON.stringify(leaf)}],{stdio:'inherit'});`;
  const reason = new Error("Privileged installer deadline expired.");
  onTestFinished(() => { vi.useRealTimers(); controller.abort(reason); });
  const execution = smokeProcess(process.execPath, ["-e", parent], {
    cwd: process.cwd(), signal: controller.signal, stdout: output, stderr: output, privilegedCleanup: true,
  });
  const stopped = expect(execution).rejects.toBe(reason);
  try {
    await started;
    expect(text).toContain(`installer uid=${process.getuid!()}`);
    expect(() => process.kill(pid, "SIGKILL")).toThrow(expect.objectContaining({ code: "EPERM" }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(5_000);
    await stopped;
    expect(runningProcess(pid)).toBe(false);
  } finally {
    vi.useRealTimers(); controller.abort(reason);
    if (pid && runningProcess(pid)) execFileSync("sudo", ["-n", "--", "kill", "-KILL", String(pid)]);
    output.destroy();
  }
});

it.skipIf(process.platform !== "linux")("cancellation leaves an unrelated process alive", async () => {
  const { spawn } = await import("node:child_process");
  const unrelated = spawn(process.execPath, ["-e", "console.log('ready'); setInterval(()=>{},60000);"], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise<void>(resolve => { unrelated.stdout!.once("data", () => resolve()); });
  const controller = new AbortController();
  const output = new PassThrough();
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  output.once("data", () => ready());
  const reason = new Error("Only the owned tree was cancelled.");
  const execution = smokeProcess(process.execPath, ["-e", "console.log('ready'); setInterval(()=>{},60000);"], {
    cwd: process.cwd(), signal: controller.signal, stdout: output, stderr: output,
  });
  const stopped = expect(execution).rejects.toBe(reason);
  try {
    await started;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(5_000);
    await stopped;
    expect(runningProcess(unrelated.pid!)).toBe(true);
  } finally {
    vi.useRealTimers(); controller.abort(reason); unrelated.kill("SIGKILL"); output.destroy();
  }
});

it.skipIf(!hostedOrdinaryUser)("bounded cleanup reports a privileged survivor and preserves the original abort reason", async () => {
  const controller = new AbortController();
  const output = new PassThrough();
  let text = "";
  let pid = 0;
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  output.on("data", chunk => {
    text += String(chunk);
    const match = /unreachable ready (\d+)/.exec(text);
    if (match) { pid = Number(match[1]); ready(); }
  });
  const leaf = "import os, signal, time; child = os.fork(); os._exit(0) if child else None; os.setsid(); signal.signal(signal.SIGTERM, lambda *_: None); print('unreachable ready '+str(os.getpid()), flush=True); time.sleep(600)";
  const reason = new Error("Unprivileged installer deadline expired.");
  onTestFinished(() => { vi.useRealTimers(); controller.abort(reason); });
  const execution = smokeProcess("sudo", ["-n", "--", "python3", "-c", leaf], {
    cwd: process.cwd(), signal: controller.signal, stdout: output, stderr: output,
  });
  const stopped = expect(execution).rejects.toBe(reason);
  try {
    await started;
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const startedAt = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(5_000);
    await stopped;
    expect(runningProcess(pid)).toBe(true);
    expect(text).toContain("SMOKE CLEANUP remaining owned descendants:");
    expect(text).toContain(`"pid": ${pid}`);
    expect(text).toContain(`"started": "${startedAt}"`);
    expect(text).toContain('"uids": ["0", "0", "0", "0"]');
  } finally {
    vi.useRealTimers(); controller.abort(reason);
    if (pid && runningProcess(pid)) execFileSync("sudo", ["-n", "--", "kill", "-KILL", String(pid)]);
    output.destroy();
  }
});
