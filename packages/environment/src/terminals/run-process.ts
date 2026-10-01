import { spawn } from "node:child_process";
import { constants } from "node:os";
import type { Pty } from "./pty.js";

/** The terminal process port over pipes: closed stdin and no controlling terminal. */
export const runProcess: Pty = {
  check() {},
  spawn(file, args, options) {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    let running = true;
    let output: (data: string) => void = () => undefined;
    return {
      pid: child.pid ?? -1,
      write() {},
      resize() {},
      kill(signal = "SIGHUP") {
        if (process.platform === "win32") child.kill();
        else if (child.pid !== undefined) process.kill(-child.pid, signal as NodeJS.Signals);
      },
      onData(listener) {
        output = listener;
        // Terminal emulators need carriage returns as well as pipe output's line feeds.
        for (const stream of [child.stdout, child.stderr]) {
          let previousCR = false;
          stream.setEncoding("utf8");
          stream.on("data", (data: string) => {
            const text = (previousCR ? "\r" + data : data).replace(/(?<!\r)\n/g, "\r\n").slice(previousCR ? 1 : 0);
            previousCR = data.endsWith("\r");
            listener(text);
          });
        }
      },
      onExit(listener) {
        let failed = false;
        child.on("error", (error) => {
          failed = true;
          // A spawn error is asynchronous; keep its explanation in the terminal's output.
          output(`The command could not start: ${error.message}\r\n`);
        });
        // close follows the draining of both pipes, so the exit never precedes its output.
        child.on("close", (code, signal) => {
          running = false;
          listener({ exitCode: failed ? -1 : code ?? 0, signal: signal === null ? undefined : constants.signals[signal] });
        });
      },
      commandRunning: () => running,
    };
  },
};
