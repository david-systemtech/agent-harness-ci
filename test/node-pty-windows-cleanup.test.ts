import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";

const require = createRequire(join(import.meta.dirname, "../packages/environment/package.json"));
const source = (name: string) => readFileSync(require.resolve(`node-pty/lib/${name}.js`), "utf8");
afterEach(() => vi.useRealTimers());

// Run the installed dependency's Windows boundary on any host; only native/OS calls are scripted.
function terminal(useConptyDll = false) {
  vi.useFakeTimers();
  const events: string[] = [];
  const resources = new Set<string>();
  const closeModes: boolean[] = [];
  let forks = 0;
  let nativeRegistered = true;
  let shellExited = false;
  let exit: (code: number) => void = () => { throw new Error("Native exit callback was not registered"); };
  const helper = Object.assign(new EventEmitter(), { kill: () => events.push("helper killed") });
  const native = { startProcess: () => { resources.add("console"); return { pty: 1, conin: "input" }; }, connect: (...args: unknown[]) => { exit = args[5] as (code: number) => void; return { pid: 123 }; },
    kill: (_pty: number, dll: boolean) => {
      closeModes.push(dll);
      if (nativeRegistered && resources.delete("console")) events.push("console closed");
      if (shellExited) nativeRegistered = false;
    } };
  const exports = {} as { WindowsPtyAgent: new (...args: unknown[]) => { kill(): void; readonly outSocket: EventEmitter } };
  runInNewContext(source("windowsPtyAgent"), {
    exports, __dirname: "/dependency/lib", setTimeout, clearTimeout,
    process: { kill: (pid: number) => events.push(`killed ${pid}`) },
    console: { error: (...args: unknown[]) => events.push(args.join(" ")) },
    require: (name: string) => {
      switch (name) {
        case "fs": return { openSync: () => 1 };
        case "os": return { release: () => "10.0.19045" };
        case "path": return require("node:path");
        case "child_process": return { fork: () => { forks++; return helper; } };
        case "net": return { Socket: class extends EventEmitter {
          private readonly resource: string;
          constructor(options?: { fd: number }) { super(); this.resource = options ? "input socket" : "output socket"; resources.add(this.resource); }
          setEncoding() {}
          destroy() { if (resources.delete(this.resource)) events.push(this.resource + " closed"); }
        } };
        case "./utils": return { loadNativeModule: () => ({ module: native }) };
        case "./windowsConoutConnection": return { ConoutConnection: class {
          constructor() { resources.add("output worker"); }
          onReady() {}
          dispose() { resources.delete("output worker"); events.push("worker disposed"); }
        } };
        default: throw new Error(`Unexpected dependency: ${name}`);
      }
    },
  });
  const pty = new exports.WindowsPtyAgent("cmd.exe", [], [], "/work", 80, 24, false, true, useConptyDll, false);
  return { pty, helper, events, resources, closeModes, get forks() { return forks; }, exit: (code: number) => { shellExited = true; if (!resources.has("console")) nativeRegistered = false; exit(code); } };
}

it("captures and kills the console's processes before closing it, even when kill is repeated", async () => {
  const { pty, helper, events } = terminal();
  pty.kill();
  expect(events).toEqual([]);
  pty.kill();
  helper.emit("message", { consoleProcessList: [123, 456] });
  await Promise.resolve();
  expect(events).toEqual(["killed 123", "killed 456", "console closed", "input socket closed", "worker disposed"]);
  expect(vi.getTimerCount()).toBe(0);
});

function listHelper(error: Error, shellGone: boolean) {
  const messages: unknown[] = [];
  const diagnostics: string[] = [];
  runInNewContext(source("conpty_console_list_agent"), {
    exports: {},
    require: () => ({ loadNativeModule: () => ({ module: { getConsoleProcessList: () => { throw error; } } }) }),
    process: { argv: ["node", "helper", "123"], send: (message: unknown) => messages.push(message), exit: () => {},
      kill: () => { if (shellGone) throw Object.assign(new Error("gone"), { code: "ESRCH" }); } },
    console: { error: (...args: unknown[]) => diagnostics.push(args.join(" ")) },
  });
  return { messages, diagnostics };
}

it("settles an already-gone console quietly instead of throwing an uncaught helper error", () => {
  const result = listHelper(new Error("AttachConsole failed"), true);
  expect(result.messages).toEqual([{ consoleProcessList: [] }]);
  expect(result.diagnostics).toEqual([]);
});

it("reports a live shell's attach failure and other native failures instead of swallowing them", () => {
  expect(listHelper(new Error("AttachConsole failed"), false).messages)
    .toEqual([{ consoleProcessList: [123], error: "AttachConsole failed" }]);
  expect(listHelper(new Error("FreeConsole failed"), true).messages)
    .toEqual([{ consoleProcessList: [123], error: "FreeConsole failed" }]);
});

it("does not spend the fallback deadline waiting for a helper which already failed", async () => {
  const { pty, helper, events } = terminal();
  pty.kill();
  helper.emit("exit", 1, null);
  await Promise.resolve();
  expect(events.join("\n")).toContain("console list helper exited without a result");
  expect(events).toContain("killed 123");
  expect(events).toContain("console closed");
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds a stuck helper, reports the timeout, and still releases the console", async () => {
  const { pty, events } = terminal();
  pty.kill();
  await vi.advanceTimersByTimeAsync(5000);
  expect(events.join("\n")).toContain("console list helper timed out after 5000ms");
  expect(events).toContain("helper killed");
  expect(events).toContain("killed 123");
  expect(events).toContain("console closed");
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps genuine helper errors actionable and settles cleanup just once", async () => {
  const { pty, helper, events } = terminal();
  pty.kill();
  helper.emit("message", { consoleProcessList: [123], error: "FreeConsole failed" });
  helper.emit("exit", 0, null);
  await Promise.resolve();
  expect(events.filter((event) => event.includes("FreeConsole failed"))).toHaveLength(1);
  expect(events.filter((event) => event === "console closed")).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])("releases a naturally exited console after its final output drains, so the environment can exit (DLL=%s)", async (dll) => {
  const { resources, exit, closeModes } = terminal(dll);
  expect([...resources].sort()).toEqual(["console", "input socket", "output socket", "output worker"]);
  exit(0);
  await vi.advanceTimersByTimeAsync(999);
  expect(resources.size).toBe(4);
  await vi.advanceTimersByTimeAsync(1);
  expect([...resources]).toEqual([]);
  expect(closeModes).toEqual([dll]);
  expect(vi.getTimerCount()).toBe(0);
});

it("closes the input pipe after forced console cleanup even before the native exit callback", async () => {
  const { pty, helper, events, resources, exit } = terminal();
  pty.kill();
  expect(resources.has("input socket")).toBe(true);
  helper.emit("message", { consoleProcessList: [123, 456] });
  await Promise.resolve();
  expect([...resources]).toEqual(["output socket"]);
  expect(events.indexOf("input socket closed")).toBeGreaterThan(events.indexOf("console closed"));
  exit(0);
  await vi.advanceTimersByTimeAsync(999);
  expect(resources.has("output socket")).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect([...resources]).toEqual([]);
  expect(events.filter(event => event === "console closed")).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])("never enumerates a shell PID again after native exit, because that PID can be reused (DLL=%s)", async (dll) => {
  const ended = terminal(dll);
  ended.exit(0);
  await vi.advanceTimersByTimeAsync(1000);
  expect(ended.forks).toBe(0);
  expect(ended.events.filter(event => event.startsWith("killed "))).toEqual([]);
  expect([...ended.resources]).toEqual([]);
  expect(ended.events.filter(event => event === "console closed")).toHaveLength(1);
});


it.each([false, true])("waits for the last output before releasing naturally exited resources (DLL=%s)", async (dll) => {
  const ended = terminal(dll);
  ended.exit(0);
  await vi.advanceTimersByTimeAsync(999);
  ended.pty.outSocket.emit("data", "final output");
  await vi.advanceTimersByTimeAsync(999);
  expect(ended.resources.size).toBe(4);
  await vi.advanceTimersByTimeAsync(1);
  expect([...ended.resources]).toEqual([]);
  expect(ended.closeModes).toEqual([dll]);
  expect(ended.forks).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("releases DLL-mode sockets and worker after a forced exit without requiring another output event", async () => {
  const ended = terminal(true);
  ended.pty.kill();
  expect([...ended.resources].sort()).toEqual(["output socket", "output worker"]);
  ended.exit(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect([...ended.resources]).toEqual([]);
  expect(ended.events.filter(event => event === "console closed")).toHaveLength(1);
  expect(ended.closeModes.every(mode => mode)).toBe(true);
  expect(ended.forks).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
