import type { Pty, PtyProcess, PtySpawnOptions } from "../src/terminals/pty.js";
import { PtyUnavailableError } from "../src/terminals/pty.js";

/**
 * A fake pseudo-terminal for the terminals module's lower tests: every spawn
 * is recorded, and a test makes the process print and exit when it likes.
 */

export interface FakeProcess extends PtyProcess {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: PtySpawnOptions;
  readonly written: string[];
  readonly resized: [number, number][];
  readonly signals: string[];
  /** Prints `data`, as the process writing to the terminal. */
  print(data: string): void;
  /** Ends the process with `exitCode`, and the signal that ended it when one did. */
  exit(exitCode: number, signal?: number): void;
  /** Whether a command typed at the shell runs in the terminal's foreground: what `commandRunning` answers; preset false, the shell at its prompt. */
  running: boolean;
}

export interface FakePty extends Pty {
  readonly spawned: FakeProcess[];
  /** Makes `check` throw, as an environment whose node-pty did not load. */
  unavailable: boolean;
  /** Makes the next spawn throw this message. */
  failNext: string | undefined;
}

export const fakePty = (): FakePty => {
  const spawned: FakeProcess[] = [];
  const pty: FakePty = {
    spawned,
    unavailable: false,
    failNext: undefined,
    check() {
      if (pty.unavailable) throw new PtyUnavailableError(new Error("no binding"));
    },
    spawn(file, args, options) {
      if (pty.failNext !== undefined) {
        const message = pty.failNext;
        pty.failNext = undefined;
        throw new Error(message);
      }
      const data: ((data: string) => void)[] = [];
      const exits: ((exit: { exitCode: number; signal?: number }) => void)[] = [];
      let exited = false;
      const process: FakeProcess = {
        pid: 1000 + spawned.length,
        file,
        args,
        options,
        written: [],
        resized: [],
        signals: [],
        write: (text) => void process.written.push(text),
        resize: (cols, rows) => void process.resized.push([cols, rows]),
        kill: (signal) => void process.signals.push(signal ?? "SIGHUP"),
        running: false,
        commandRunning: () => process.running,
        onData: (listener) => void data.push(listener),
        onExit: (listener) => void exits.push(listener),
        print: (text) => {
          for (const listener of data) listener(text);
        },
        exit: (exitCode, signal) => {
          if (exited) return;
          exited = true;
          for (const listener of exits) listener(signal === undefined ? { exitCode } : { exitCode, signal });
        },
      };
      spawned.push(process);
      return process;
    },
  };
  return pty;
};
