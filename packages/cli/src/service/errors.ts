import type { CommandResult } from "./runner.js";

/** Service install, start and removal are sentences a user reads; the CLI prints the message alone. */
export class ServiceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ServiceError";
  }
}

export class UnsupportedPlatformError extends ServiceError {
  constructor(platform: string) {
    super(`${platform} has no service install: it supports macOS (launchd), Linux (systemd --user) and Windows (Task Scheduler).`);
    this.name = "UnsupportedPlatformError";
  }
}

/** A service manager command exited non-zero. */
export class ServiceCommandError extends ServiceError {
  readonly result: CommandResult;

  constructor(command: string, args: readonly string[], result: CommandResult) {
    const said = result.stderr.trim() || result.stdout.trim() || "no output";
    super(`${[command, ...args].join(" ")} exited ${result.code}: ${said}`);
    this.name = "ServiceCommandError";
    this.result = result;
  }
}
