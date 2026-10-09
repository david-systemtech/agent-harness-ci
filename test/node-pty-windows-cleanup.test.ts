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
function terminal() {
  vi.useFakeTimers();
  const events: string[] = [];
  const helper = Object.assign(new EventEmitter(), { kill: () => events.push("helper killed") });
  const native = { startProcess: () => ({ pty: 1, conin: "input" }), connect: () => ({ pid: 123 }),
    kill: () => events.push("console closed") };
  const exports = {} as { WindowsPtyAgent: new (...args: unknown[]) => { kill(): void } };
  runInNewContext(source("windowsPtyAgent"), {
    exports, __dirname: "/dependency/lib", setTimeout, clearTimeout,
    process: { kill: (pid: number) => events.push(`killed ${pid}`) },
    console: { error: (...args: unknown[]) => events.push(args.join(" ")) },
    require: (name: string) => {
      switch (name) {
        case "fs": return { openSync: () => 1 };
        case "os": return { release: () => "10.0.19045" };
        case "path": return require("node:path");
        case "child_process": return { fork: () => helper };
        case "net": return { Socket: class extends EventEmitter { setEncoding() {} } };
        case "./utils": return { loadNativeModule: () => ({ module: native }) };
        case "./windowsConoutConnection": return { ConoutConnection: class {
          onReady() {} dispose() { events.push("worker disposed"); }
        } };
        default: throw new Error(`Unexpected dependency: ${name}`);
      }
    },
  });
  const pty = new exports.WindowsPtyAgent("cmd.exe", [], [], "/work", 80, 24, false, true, false, false);
  return { pty, helper, events };
}

it("captures and kills the console's processes before closing it, even when kill is repeated", async () => {
  const { pty, helper, events } = terminal();
  pty.kill();
  expect(events).toEqual([]);
  pty.kill();
  helper.emit("message", { consoleProcessList: [123, 456] });
  await Promise.resolve();
  expect(events).toEqual(["killed 123", "killed 456", "console closed", "worker disposed"]);
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
