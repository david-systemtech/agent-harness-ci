import { UnsupportedPlatformError } from "./errors.js";
import { launchdPlatform } from "./launchd.js";
import { serviceCommands, type CommandRunner } from "./runner.js";
import type { InstallContext, ServiceSpec } from "./spec.js";
import { systemdPlatform } from "./systemd.js";
import { taskSchedulerPlatform } from "./task-scheduler.js";

/**
 * One platform's user-level service manager: launchd on macOS, `systemd
 * --user` on Linux, Task Scheduler on Windows. Every one runs the launcher
 * entry as the current user, at logon, and is driven only through a
 * `CommandRunner`.
 */
export interface ServicePlatform {
  readonly kind: "launchd" | "systemd" | "task-scheduler";
  /**
   * Whether stopping the service lets its running runs finish first: the
   * service manager sends the launcher a SIGTERM, the launcher drains its
   * child, and the command that stops it waits (launchd, systemd).
   */
  readonly drainsOnStop: boolean;
  /** Where the definition lives: a file for launchd and systemd, the task's path in Task Scheduler on Windows. */
  definitionPath(): string;
  /**
   * Writes the definition and registers it to run at logon; the data
   * directory must exist. A definition already there is replaced; a service
   * that was not running is left stopped, and one that was is restarted onto
   * the new definition when `restartRunning` says so, else left running to
   * take the new definition at its next start. On a refusal the previous
   * definition, and the service manager's hold on it, are put back.
   */
  install(spec: ServiceSpec, options: InstallOptions): Promise<InstalledDefinition>;
  /** Stops the service and removes the definition. Call only when installed. */
  uninstall(): Promise<void>;
  /** Starts the installed service now. */
  start(): Promise<void>;
  /** Stops the installed service now, leaving it installed to start at the next logon. */
  stop(): Promise<void>;
  isInstalled(): Promise<boolean>;
  /** Whether the service manager reports the service's process running. */
  isRunning(): Promise<boolean>;
  /** Anything about the platform's setup that the status should mention. */
  notes(): Promise<string[]>;
}

export interface InstallOptions {
  /** Whether a running service is restarted onto the new definition (a stop and a start), or left running. */
  readonly restartRunning: boolean;
}

/** What an install left outside the data directory beside the definition itself. */
export interface InstalledDefinition {
  /** The folders created to hold the definition, outermost first. */
  readonly createdDirectories: readonly string[];
}

/** The service manager for the install context's platform. */
export const createServicePlatform = (installContext: InstallContext, runner: CommandRunner): ServicePlatform => {
  const commands = serviceCommands(runner);
  switch (installContext.platform) {
    case "darwin":
      return launchdPlatform(installContext, commands);
    case "linux":
      return systemdPlatform(installContext, commands);
    case "win32":
      return taskSchedulerPlatform(installContext, commands);
    default:
      throw new UnsupportedPlatformError(installContext.platform);
  }
};

export { ServiceCommandError, ServiceError, UnsupportedPlatformError } from "./errors.js";
