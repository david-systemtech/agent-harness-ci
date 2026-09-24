import { existsSync, rmSync } from "node:fs";
import { posix } from "node:path";
import { writeDefinition } from "./definition.js";
import { ServiceError } from "./errors.js";
import type { ServicePlatform } from "./platform.js";
import type { ServiceCommands } from "./runner.js";
import { LOG_DIRECTORY, LOG_FILE, serveArguments, SERVICE_LABEL, type InstallContext, type ServiceSpec } from "./spec.js";
import { escapeXml } from "./xml.js";

const string = (text: string): string => `<string>${escapeXml(text)}</string>`;

/**
 * The launchd agent: `serve` with the data directory and port, loaded at
 * login and started when loaded (`RunAtLoad`), kept alive unless it exits
 * cleanly (a drain's exit is left alone), its output in the data directory's
 * log.
 */
export const renderLaunchdPlist = (spec: ServiceSpec): string => {
  const log = posix.join(spec.dataDir, LOG_DIRECTORY, LOG_FILE);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    `<!-- The ${SERVICE_LABEL} environment. Written by "${SERVICE_LABEL} service install"; "${SERVICE_LABEL} service uninstall" removes it. -->`,
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    `\t${string(SERVICE_LABEL)}`,
    "\t<key>ProgramArguments</key>",
    "\t<array>",
    ...serveArguments(spec).map((arg) => `\t\t${string(arg)}`),
    "\t</array>",
    "\t<key>RunAtLoad</key>",
    "\t<true/>",
    "\t<key>KeepAlive</key>",
    "\t<dict>",
    "\t\t<key>SuccessfulExit</key>",
    "\t\t<false/>",
    "\t</dict>",
    "\t<key>StandardOutPath</key>",
    `\t${string(log)}`,
    "\t<key>StandardErrorPath</key>",
    `\t${string(log)}`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
};

/**
 * The agent in `~/Library/LaunchAgents`, which launchd loads at each login.
 * `launchctl` addresses it in the user's GUI domain, `gui/<uid>`: bootstrap
 * loads it (and `RunAtLoad` starts it), kickstart starts a loaded one, bootout
 * stops and unloads it.
 */
export const launchdPlatform = (installContext: InstallContext, commands: ServiceCommands): ServicePlatform => {
  if (installContext.uid === undefined) throw new ServiceError("launchd needs the user id to name the user's domain, and this process has none.");
  const domain = `gui/${installContext.uid}`;
  const target = `${domain}/${SERVICE_LABEL}`;
  const path = posix.join(installContext.homedir, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
  const launchctl = (...args: string[]) => commands.run("launchctl", args);

  /** What `launchctl print` says of the job: nothing when it is not loaded. */
  const printed = async (): Promise<string | undefined> => {
    const result = await commands.probe("launchctl", ["print", target]);
    return result.code === 0 ? result.stdout : undefined;
  };
  const running = (print: string | undefined) => print !== undefined && /^\s*state = running$/m.test(print);

  return {
    kind: "launchd",
    definitionPath: () => path,
    install: async (spec) => {
      const written = writeDefinition(path, renderLaunchdPlist(spec));
      let bootedOut = false;
      try {
        const print = await printed();
        if (print !== undefined) {
          // launchd keeps a loaded job's old definition: unload it, and load the new one only if the old one was running.
          await launchctl("bootout", target);
          bootedOut = true;
          if (running(print)) await launchctl("bootstrap", domain, path);
        }
      } catch (error) {
        written.restore();
        // The old agent was unloaded for the new one: load it again from its restored file.
        if (bootedOut && written.previous !== undefined) await commands.attempt("launchctl", ["bootstrap", domain, path]);
        throw error;
      }
      return { createdDirectories: written.createdDirectories };
    },
    uninstall: async () => {
      if ((await printed()) !== undefined) await launchctl("bootout", target);
      rmSync(path, { force: true });
    },
    start: async () => {
      if ((await printed()) === undefined) await launchctl("bootstrap", domain, path);
      else await launchctl("kickstart", target);
    },
    isInstalled: async () => existsSync(path),
    isRunning: async () => running(await printed()),
    notes: async () => [],
  };
};
