import { PassThrough } from "node:stream";
import { expect, it, onTestFinished } from "vitest";
import { smokeProcess } from "./smoke-process.js";

it.skipIf(process.platform === "win32")("a cancelled smoke phase stops its held descendant before finishing", async () => {
  const signal = new AbortController();
  const output = new PassThrough();
  let text = "";
  let pid: number | undefined;
  let ready!: () => void;
  const running = new Promise<void>(resolve => { ready = resolve; });
  output.on("data", chunk => {
    text += String(chunk);
    const match = /parent (\d+)/.exec(text);
    if (match) pid = Number(match[1]);
    if (text.includes("descendant ready")) ready();
  });
  onTestFinished(() => {
    signal.abort();
    if (pid) {
      try { process.kill(-pid, "SIGTERM"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    output.destroy();
  });
  const leaf = `process.on('SIGTERM', () => { console.log('descendant stopped'); process.exit(0); }); console.log('descendant ready'); setInterval(() => {}, 60000);`;
  const parent = `const {spawn} = require('node:child_process'); console.log('parent '+process.pid); spawn(process.execPath, ['-e', ${JSON.stringify(leaf)}], {stdio: ['ignore', 'inherit', 'inherit']}); setInterval(() => {}, 60000);`;
  const execution = smokeProcess(process.execPath, ["-e", parent], { cwd: process.cwd(), signal: signal.signal, stdout: output, stderr: output });
  const reason = new Error("The held smoke phase was cancelled.");
  const stopped = expect(execution).rejects.toBe(reason);
  // Attach a rejection handler before the event that cancels the process.
  await running;
  signal.abort(reason);
  await stopped;
  expect(text).toContain("descendant stopped");
});

it.skipIf(process.platform === "win32")("captures successful smoke output while streaming it to the job log", async () => {
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
