import { execFile } from "node:child_process";
import { ServiceCommandError, ServiceError } from "./errors.js";

/** What a finished command left: its exit code and its output. */
export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs a service manager command (`launchctl`, `systemctl`, `loginctl`,
 * `schtasks`) and resolves with its exit code, whatever the code; it rejects
 * only when the command could not be run at all. The seam the tests stub.
 */
export type CommandRunner = (command: string, args: readonly string[]) => Promise<CommandResult>;

/** How long one service manager command may take before it is killed. */
const COMMAND_TIMEOUT_MS = 30_000;

export const processRunner: CommandRunner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { encoding: "utf8", windowsHide: true, timeout: COMMAND_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error === null) return resolve({ code: 0, stdout, stderr });
        // A numeric code is the command's exit status; anything else (ENOENT, a kill on timeout) means it did not run to an end.
        if (typeof error.code === "number") return resolve({ code: error.code, stdout, stderr });
        reject(error);
      },
    );
  });

/** The runner, with the two ways the platforms call it. */
export interface ServiceCommands {
  /** Runs a command and returns what it left, whatever its exit code. */
  query(command: string, args: readonly string[]): Promise<CommandResult>;
  /** Runs a command that must succeed; a non-zero exit is a `ServiceCommandError`. */
  run(command: string, args: readonly string[]): Promise<CommandResult>;
  /** Runs a command while putting things back after a failure: its own failure is ignored, so the first error is the one reported. */
  attempt(command: string, args: readonly string[]): Promise<void>;
}

export const serviceCommands = (runner: CommandRunner): ServiceCommands => {
  const query = async (command: string, args: readonly string[]) => {
    try {
      return await runner(command, args);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ServiceError(`Could not run ${command}: ${reason}`, { cause: error });
    }
  };
  return {
    query,
    attempt: async (command, args) => {
      await query(command, args).catch(() => undefined);
    },
    run: async (command, args) => {
      const result = await query(command, args);
      if (result.code !== 0) throw new ServiceCommandError(command, args, result);
      return result;
    },
  };
};
