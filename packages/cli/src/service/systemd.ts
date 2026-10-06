import { existsSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { posix } from "node:path";
import { writeDefinition } from "./definition.js";
import type { ServicePlatform } from "./platform.js";
import type { ServiceCommands } from "./runner.js";
import { ENTRY_SHELL, LOG_DIRECTORY, LOG_FILE, SERVICE_LABEL, STOP_TIMEOUT_S, type InstallContext, type ServiceSpec } from "./spec.js";

/** Characters that make systemd split or unescape a word: whitespace, quotes, backslash, and `;` which separates commands. */
const NEEDS_QUOTES = /[\s"'\\;]/;

/** `%` starts a specifier and `$` a variable everywhere on an `ExecStart=` line; doubling makes each literal. */
const escapeExpansions = (text: string): string => text.replaceAll("%", "%%").replaceAll("$", "$$$$");

/** One `ExecStart=` word: expansions escaped, and double-quoted with C escapes when systemd would otherwise split it. */
const execWord = (word: string): string => {
  const escaped = escapeExpansions(word);
  if (word !== "" && !NEEDS_QUOTES.test(word)) return escaped;
  return `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
};

/** The unit's log path: specifiers are expanded in it, variables are not. */
const logPath = (spec: ServiceSpec): string => posix.join(spec.dataDir, LOG_DIRECTORY, LOG_FILE).replaceAll("%", "%%");

/**
 * The `systemd --user` unit: the launcher entry through `sh`, restarted when
 * it fails (a crash, or a launcher's exit to hand over to a newer one; a
 * clean exit is a stop), the launcher alone sent the stop's SIGTERM
 * (`KillMode=mixed`: it drains its child) and given `STOP_TIMEOUT_S` before
 * the SIGKILL, its output appended to the log in the data directory, wanted
 * by the user's default target so it starts with the user's manager.
 */
export const renderSystemdUnit = (spec: ServiceSpec): string =>
  [
    `# The ${SERVICE_LABEL} environment. Written by "${SERVICE_LABEL} service install";`,
    `# "${SERVICE_LABEL} service uninstall" removes it.`,
    "[Unit]",
    `Description=${SERVICE_LABEL} environment`,
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${[ENTRY_SHELL, spec.entry].map(execWord).join(" ")}`,
    "Restart=on-failure",
    "RestartSec=5",
    "KillMode=mixed",
    `TimeoutStopSec=${STOP_TIMEOUT_S / 60}min`,
    `StandardOutput=append:${logPath(spec)}`,
    `StandardError=append:${logPath(spec)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");

/** Removes a directory only when it exists and holds nothing. */
const removeIfEmpty = (dir: string): void => {
  try {
    if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    // A directory that cannot be read or removed is left alone.
  }
};

/**
 * The unit in the user's systemd configuration directory (`$XDG_CONFIG_HOME`
 * when absolute, as systemd reads it, else `~/.config`). Starting at logon is
 * the user manager's: with lingering off it starts at the first login and
 * stops at the last logout, which `notes` says.
 */
export const systemdPlatform = (installContext: InstallContext, commands: ServiceCommands): ServicePlatform => {
  const unit = `${SERVICE_LABEL}.service`;
  const xdg = installContext.env["XDG_CONFIG_HOME"];
  const configHome = xdg && posix.isAbsolute(xdg) ? xdg : posix.join(installContext.homedir, ".config");
  const path = posix.join(configHome, "systemd", "user", unit);
  const wantsDir = posix.join(configHome, "systemd", "user", "default.target.wants");
  const systemctl = (...args: string[]) => commands.run("systemctl", ["--user", ...args]);
  /** A `systemctl` command that stops the unit and waits while the launcher drains. */
  const systemctlStopping = (...args: string[]) => commands.stop("systemctl", ["--user", ...args]);
  const isEnabled = async () => {
    const result = await commands.probe("systemctl", ["--user", "is-enabled", unit]);
    return result.code === 0 && result.stdout.trim() === "enabled";
  };

  return {
    kind: "systemd",
    drainsOnStop: true,
    definitionPath: () => path,
    install: async (spec, { restartRunning }) => {
      const written = writeDefinition(path, renderSystemdUnit(spec));
      const wantsExisted = existsSync(wantsDir);
      // A unit that was running before is started again on a refusal, since a failed try-restart leaves it stopped.
      const wasRunning = written.previous !== undefined && (await commands.probe("systemctl", ["--user", "is-active", unit])).code === 0;
      let enabled = false;
      let wasEnabled = false;
      try {
        // What the manager held before: a replaced unit that was enabled keeps its enablement on a refusal; anything else is disabled again.
        wasEnabled = written.previous !== undefined && (await isEnabled());
        await systemctl("daemon-reload");
        await systemctl("enable", unit);
        enabled = true;
        // try-restart restarts a running unit onto the new definition and leaves a stopped one stopped. Left running, the
        // unit takes the reloaded definition at its next start.
        if (restartRunning) await systemctlStopping("try-restart", unit);
      } catch (error) {
        if (enabled && !wasEnabled) {
          await commands.attempt("systemctl", ["--user", "disable", unit]);
          if (!wantsExisted) removeIfEmpty(wantsDir);
        }
        written.restore();
        await commands.attempt("systemctl", ["--user", "daemon-reload"]);
        if (wasRunning) await commands.attempt("systemctl", ["--user", "start", unit]);
        throw error;
      }
      return { createdDirectories: written.createdDirectories };
    },
    uninstall: async () => {
      await systemctlStopping("disable", "--now", unit);
      rmSync(path, { force: true });
      // `enable` created the wants directory when it was absent; an empty one goes with the unit.
      removeIfEmpty(wantsDir);
      await systemctl("daemon-reload");
    },
    start: async () => {
      await systemctl("start", unit);
    },
    stop: async () => {
      await systemctlStopping("stop", unit);
    },
    isInstalled: async () => existsSync(path),
    isRunning: async () => (await commands.probe("systemctl", ["--user", "is-active", unit])).code === 0,
    notes: async () => {
      const linger = await commands.probe("loginctl", ["show-user", installContext.username, "--property=Linger", "--value"]);
      if (linger.code !== 0 || linger.stdout.trim() !== "no") return [];
      return [
        `Lingering is off for ${installContext.username}, so the service starts at your first login and stops at your last logout. ` +
          `To keep it running with nobody logged in, an administrator runs \`loginctl enable-linger ${installContext.username}\`.`,
      ];
    },
  };
};
