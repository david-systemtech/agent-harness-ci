import { UnsupportedPlatformError } from "./errors.js";
import { launchdPlatform } from "./launchd.js";
import { serviceCommands, type CommandRunner } from "./runner.js";
import type { ServiceHost, ServiceSpec } from "./spec.js";
import { systemdPlatform } from "./systemd.js";
import { taskSchedulerPlatform } from "./task-scheduler.js";

/**
 * One platform's user-level service manager: launchd on macOS, `systemd
 * --user` on Linux, Task Scheduler on Windows. Every one runs `serve` as the
 * current user, at logon, and is driven only through a `CommandRunner`.
 */
export interface ServicePlatform {
  readonly kind: "launchd" | "systemd" | "task-scheduler";
  /** Where the definition lives: a file for launchd and systemd, the task's path in Task Scheduler on Windows. */
  definitionPath(): string;
  /** The definition for `spec`, as written. Pure. */
  render(spec: ServiceSpec): string;
  /**
   * Prepares the data directory and its log folder, writes the definition and
   * registers it to run at logon. A definition already there is replaced; a
   * service that was running is restarted onto the new one, one that was not
   * is left stopped. On a refusal the previous definition is put back.
   */
  install(spec: ServiceSpec): Promise<void>;
  /** Stops the service and removes the definition. Call only when installed. */
  uninstall(): Promise<void>;
  /** Starts the installed service now. */
  start(): Promise<void>;
  isInstalled(): Promise<boolean>;
  /** Whether the service manager reports the service's process running. */
  isRunning(): Promise<boolean>;
  /** Anything about the platform's setup that the status should mention. */
  notes(): Promise<string[]>;
}

/** The service manager for `host`'s platform. */
export const createServicePlatform = (host: ServiceHost, runner: CommandRunner): ServicePlatform => {
  const commands = serviceCommands(runner);
  switch (host.platform) {
    case "darwin":
      return launchdPlatform(host, commands);
    case "linux":
      return systemdPlatform(host, commands);
    case "win32":
      return taskSchedulerPlatform(host, commands);
    default:
      throw new UnsupportedPlatformError(host.platform);
  }
};

export { ServiceCommandError, ServiceError, UnsupportedPlatformError } from "./errors.js";
