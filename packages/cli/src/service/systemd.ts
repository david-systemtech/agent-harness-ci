import { existsSync, rmSync } from "node:fs";
import { posix } from "node:path";
import { writeDefinition } from "./definition.js";
import type { ServicePlatform } from "./platform.js";
import type { ServiceCommands } from "./runner.js";
import { LOG_DIRECTORY, LOG_FILE, serveArguments, SERVICE_LABEL, type InstallContext, type ServiceSpec } from "./spec.js";

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
 * The `systemd --user` unit: `serve` with the data directory and port,
 * restarted when it fails (a clean exit, after a drain, is left alone), its
 * output appended to the log in the data directory, wanted by the user's
 * default target so it starts with the user's manager.
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
    `ExecStart=${serveArguments(spec).map(execWord).join(" ")}`,
    "Restart=on-failure",
    "RestartSec=5",
    `StandardOutput=append:${logPath(spec)}`,
    `StandardError=append:${logPath(spec)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");

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
  const systemctl = (...args: string[]) => commands.run("systemctl", ["--user", ...args]);

  return {
    kind: "systemd",
    definitionPath: () => path,
    install: async (spec) => {
      const written = writeDefinition(path, renderSystemdUnit(spec));
      let enabled = false;
      try {
        await systemctl("daemon-reload");
        await systemctl("enable", unit);
        enabled = true;
        // try-restart restarts a running unit onto the new definition and leaves a stopped one stopped.
        await systemctl("try-restart", unit);
      } catch (error) {
        // A unit that did not exist before is disabled again; a replaced one keeps the enablement it had.
        if (enabled && written.previous === undefined) await commands.attempt("systemctl", ["--user", "disable", unit]);
        written.restore();
        await commands.attempt("systemctl", ["--user", "daemon-reload"]);
        throw error;
      }
      return { createdDirectories: written.createdDirectories };
    },
    uninstall: async () => {
      await systemctl("disable", "--now", unit);
      rmSync(path, { force: true });
      await systemctl("daemon-reload");
    },
    start: async () => {
      await systemctl("start", unit);
    },
    isInstalled: async () => existsSync(path),
    isRunning: async () => (await commands.query("systemctl", ["--user", "is-active", unit])).code === 0,
    notes: async () => {
      const linger = await commands.query("loginctl", ["show-user", installContext.username, "--property=Linger", "--value"]);
      if (linger.code !== 0 || linger.stdout.trim() !== "no") return [];
      return [
        `Lingering is off for ${installContext.username}, so the service starts at your first login and stops at your last logout. ` +
          `To keep it running with nobody logged in, an administrator runs \`loginctl enable-linger ${installContext.username}\`.`,
      ];
    },
  };
};
