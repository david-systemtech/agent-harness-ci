import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRuntime, uuidv7 } from "../packages/client-runtime/src/index.js";
import { fakeWire } from "../packages/client-runtime/src/testing/fake-wire.js";
import { inMemoryPlatform, manualClock } from "../packages/client-runtime/src/testing/in-memory-platform.js";
import { afterEach, expect, it, onTestFinished } from "vitest";

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

const pairedRuntime = async () => {
  const clock = manualClock();
  const wire = fakeWire({ clock, name: "drain-smoke" });
  const runtime = createRuntime(inMemoryPlatform({ clock, fetch: wire.fetch, webSocket: wire.webSocket }));
  onTestFinished(() => runtime.close());
  await runtime.start();
  const adding = runtime.connections.add({ link: wire.link });
  await wire.server.accept();
  expect(await adding).toMatchObject({ status: "paired" });
  return { runtime, wire, commandId: () => uuidv7(clock.now()) };
};

it("opens and writes a drain-smoke terminal through the real runtime without queuing it", async () => {
  const { runtime, wire, commandId } = await pairedRuntime();
  const id = "4d3c2b1a-9e8f-4a7b-8c6d-5e4f3a2b1c0d";
  const sessionId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const terminal = { id, owner: "session", sessionId, openedAt: "2026-09-24T00:00:00.000Z", cols: 80, rows: 24, exitCode: null, signal: null };
  wire.answer("terminals.open", () => ({ result: { receipt: { status: "accepted", sequence: 0, changed: false }, result: { terminal } } }));
  wire.answer("terminals.write", () => ({ result: { receipt: { status: "accepted", sequence: 0, changed: false }, result: { id } } }));
  await expect(check.requestDrainCommand(runtime, wire.environmentId, "terminals.open", { id, sessionId }, commandId))
    .resolves.toEqual({ terminal });
  await expect(check.requestDrainCommand(runtime, wire.environmentId, "terminals.write", { id, data: "echo drain\r" }, commandId))
    .resolves.toEqual({ id });
});

it("applies the drain-smoke update through the real runtime's direct admin request", async () => {
  const { runtime, wire, commandId } = await pairedRuntime();
  const update = { updateId: "7c9e6679-7425-40de-944b-e07fc1f90ae7", toVersion: "99.0.0" };
  wire.answer("updates.apply", () => ({ result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: update } }));
  await expect(check.requestDrainCommand(runtime, wire.environmentId, "updates.apply", { version: "99.0.0", artefactPath: "C:\\smoke\\candidate", when: "now" }, commandId))
    .resolves.toEqual(update);
});

it("fails the drain smoke when a direct command errors or its receipt is rejected", async () => {
  const { runtime, wire, commandId } = await pairedRuntime();
  const id = "4d3c2b1a-9e8f-4a7b-8c6d-5e4f3a2b1c0d";
  wire.answer("terminals.write", () => ({ error: { code: "forbidden", message: "No terminal scope.", data: { scope: "terminal" } } }));
  await expect(check.requestDrainCommand(runtime, wire.environmentId, "terminals.write", { id, data: "exit\r" }, commandId))
    .rejects.toThrow("No terminal scope.");
  wire.answer("terminals.write", () => ({ result: { receipt: { status: "rejected", sequence: 0, changed: false,
    reason: "conflict", error: { code: "conflict", message: "The shell has exited.", data: { reason: "exited" } } } } }));
  await expect(check.requestDrainCommand(runtime, wire.environmentId, "terminals.write", { id, data: "exit\r" }, commandId))
    .rejects.toThrow("The shell has exited.");
});
