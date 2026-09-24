import { existsSync, rmSync } from "node:fs";
import { posix } from "node:path";
import { installDefinition, prepareServiceDirectories } from "./definition.js";
import { ServiceError } from "./errors.js";
import type { ServicePlatform } from "./platform.js";
import type { ServiceCommands } from "./runner.js";
import { LOG_DIRECTORY, LOG_FILE, serveArguments, SERVICE_LABEL, type ServiceHost, type ServiceSpec } from "./spec.js";
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
    `<!-- The ${spec.label} environment. Written by "${SERVICE_LABEL} service install"; "${SERVICE_LABEL} service uninstall" removes it. -->`,
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    `\t${string(spec.label)}`,
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
export const launchdPlatform = (host: ServiceHost, commands: ServiceCommands): ServicePlatform => {
  if (host.uid === undefined) throw new ServiceError("launchd needs the user id to name the user's domain, and this process has none.");
  const domain = `gui/${host.uid}`;
  const target = `${domain}/${SERVICE_LABEL}`;
  const path = posix.join(host.homedir, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
  const launchctl = (...args: string[]) => commands.run("launchctl", args);

  /** What `launchctl print` says of the job: nothing when it is not loaded. */
  const printed = async (): Promise<string | undefined> => {
    const result = await commands.query("launchctl", ["print", target]);
    return result.code === 0 ? result.stdout : undefined;
  };
  const running = (print: string | undefined) => print !== undefined && /^\s*state = running$/m.test(print);

  return {
    kind: "launchd",
    definitionPath: () => path,
    render: renderLaunchdPlist,
    install: async (spec) => {
      prepareServiceDirectories(spec);
      await installDefinition(path, renderLaunchdPlist(spec), async () => {
        const print = await printed();
        if (print === undefined) return;
        // launchd keeps a loaded job's old definition: unload it, and load the new one only if the old one was running.
        await launchctl("bootout", target);
        if (running(print)) await launchctl("bootstrap", domain, path);
      });
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
