import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const check = await import(pathToFileURL(join(import.meta.dirname, "../scripts/check-packaged-terminal-drain.mjs")).href);
let scratch = "";
afterEach(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

it("requires the gone-console helper to reply, exit normally and keep stderr quiet", async () => {
  scratch = mkdtempSync(join(tmpdir(), "terminal-drain-check-"));
  const fixture = join(scratch, "helper.cjs");
  writeFileSync(fixture, `process.send({ consoleProcessList: [] }, () => process.exit(0));`);
  await expect(check.checkGoneConsole(fixture, 123)).resolves.toBeUndefined();
  writeFileSync(fixture, `console.error('Error: AttachConsole failed'); process.send({ consoleProcessList: [] }, () => process.exit(0));`);
  await expect(check.checkGoneConsole(fixture, 123)).rejects.toThrow("Gone-console helper must not print an uncaught stack trace");
  writeFileSync(fixture, `process.exit(0);`);
  await expect(check.checkGoneConsole(fixture, 123)).rejects.toThrow();
});

it("observes an owned process alive before its exit and gone after its exit", async () => {
  scratch = mkdtempSync(join(tmpdir(), "terminal-drain-process-"));
  const fixture = join(scratch, "owned.cjs");
  writeFileSync(fixture, `process.on('message', () => process.exit(0)); process.send('ready');`);
  const child = fork(fixture, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  try {
    await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); });
    expect(check.alive(child.pid)).toBe(true);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.send("stop");
    await exited;
    await check.waitFor(() => !check.alive(child.pid), "owned process gone");
  } finally { if (child.exitCode === null) child.kill(); }
});

it("refuses invalid PIDs so cleanup can never signal a process group", () => {
  for (const pid of [0, -1, NaN, undefined]) expect(() => check.alive(pid)).toThrow("Expected an owned process PID");
});
