import { execFile } from "node:child_process";
import { PRODUCT_NAME } from "@agent-harness/contracts";
import { ServiceCommandError, ServiceError } from "./errors.js";
import { STOP_TIMEOUT_S } from "./spec.js";

/** What a finished command left: its exit code and its output. */
export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs a service manager command (`launchctl`, `systemctl`, `loginctl`,
 * `schtasks`), killing it after `timeoutMs`, and resolves with its exit code,
 * whatever the code; it rejects when the command could not be run at all,
 * and with a `CommandTimeoutError` when it was killed at its timeout. The
 * seam the tests stub.
 */
export type CommandRunner = (command: string, args: readonly string[], timeoutMs: number) => Promise<CommandResult>;

/** How long a service manager command may take before it is killed. */
export const COMMAND_TIMEOUT_MS = 30_000;

/**
 * How long a command that stops the service may take: the definitions' stop
 * timeout, which lets the launcher drain its child, and a minute, so the
 * command is not killed while the service manager waits on the stop.
 */
export const STOP_COMMAND_TIMEOUT_MS = (STOP_TIMEOUT_S + 60) * 1000;

/** A command the runner killed because it outlived its timeout. */
export class CommandTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`killed after ${timeoutMs} ms`);
    this.name = "CommandTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export const processRunner: CommandRunner = (command, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(command, [...args], { encoding: "utf8", windowsHide: true, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error === null) return resolve({ code: 0, stdout, stderr });
      // Node sets `killed` only for a kill it sent, here the timeout's, whatever the command then exited with.
      if (error.killed === true) return reject(new CommandTimeoutError(timeoutMs));
      // A numeric code is the command's exit status; anything else (ENOENT) means it did not run.
      if (typeof error.code === "number") return resolve({ code: error.code, stdout, stderr });
      reject(error);
    });
  });

/** A timeout as the sentence says it: whole minutes, else seconds. */
const duration = (ms: number): string => (ms % 60_000 === 0 ? `${ms / 60_000} minutes` : `${ms / 1000} seconds`);

/** The runner, with the two ways the platforms call it. */
export interface ServiceCommands {
  /** Runs a command and returns what it left, whatever its exit code. */
  query(command: string, args: readonly string[]): Promise<CommandResult>;
  /** Like `query`, but a binary that cannot be spawned reads as a refusal (code 1) rather than an error: for probes. */
  probe(command: string, args: readonly string[]): Promise<CommandResult>;
  /** Runs a command that must succeed; a non-zero exit is a `ServiceCommandError`. */
  run(command: string, args: readonly string[]): Promise<CommandResult>;
  /** Runs a command while putting things back after a failure: its own failure is ignored, so the first error is the one reported. */
  attempt(command: string, args: readonly string[]): Promise<void>;
  /**
   * Like `run`, for a command that stops the service and waits until it has
   * stopped: it gets `STOP_COMMAND_TIMEOUT_MS` rather than
   * `COMMAND_TIMEOUT_MS`, since the launcher drains its child first.
   */
  stop(command: string, args: readonly string[]): Promise<CommandResult>;
}

/** How long a kind of command is given, and how the sentence for one that outlived it ends. */
interface Wait {
  readonly timeoutMs: number;
  readonly afterTimeout: string;
}

const ORDINARY: Wait = { timeoutMs: COMMAND_TIMEOUT_MS, afterTimeout: "." };
const STOPPING: Wait = {
  timeoutMs: STOP_COMMAND_TIMEOUT_MS,
  afterTimeout: `, so the service may still be stopping: \`${PRODUCT_NAME} service status\` says whether it still runs.`,
};

export const serviceCommands = (runner: CommandRunner): ServiceCommands => {
  const call = async (command: string, args: readonly string[], wait: Wait) => {
    try {
      return await runner(command, args, wait.timeoutMs);
    } catch (error) {
      if (error instanceof CommandTimeoutError) {
        throw new ServiceError(`${[command, ...args].join(" ")} did not finish within ${duration(error.timeoutMs)}${wait.afterTimeout}`, { cause: error });
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new ServiceError(`Could not run ${command}: ${reason}`, { cause: error });
    }
  };
  const succeeded = async (command: string, args: readonly string[], wait: Wait) => {
    const result = await call(command, args, wait);
    if (result.code !== 0) throw new ServiceCommandError(command, args, result);
    return result;
  };
  const query = (command: string, args: readonly string[]) => call(command, args, ORDINARY);
  return {
    query,
    probe: async (command, args) => query(command, args).catch(() => ({ code: 1, stdout: "", stderr: "" })),
    attempt: async (command, args) => {
      await query(command, args).catch(() => undefined);
    },
    run: (command, args) => succeeded(command, args, ORDINARY),
    stop: (command, args) => succeeded(command, args, STOPPING),
  };
};
