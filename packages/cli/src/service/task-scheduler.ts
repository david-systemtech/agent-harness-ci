import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServicePlatform } from "./platform.js";
import type { ServiceCommands } from "./runner.js";
import { serveArguments, SERVICE_LABEL, type InstallContext, type ServiceSpec } from "./spec.js";
import { escapeXml } from "./xml.js";

/** The file in the data directory the task XML is written to for `schtasks /Create`, and removed from after. */
export const TASK_XML_FILE = "service-task.xml";

/**
 * One argument as the Windows C runtime splits a command line: bare when it
 * has no space, tab or quote, else quoted, with each quote escaped and the
 * backslashes before a quote (or before the closing quote) doubled.
 */
const windowsArgument = (arg: string): string => {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  let quoted = '"';
  let backslashes = 0;
  for (const char of arg) {
    if (char === "\\") {
      backslashes++;
      continue;
    }
    quoted += "\\".repeat(char === '"' ? backslashes * 2 + 1 : backslashes) + char;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
};

/**
 * The Task Scheduler task: a logon trigger and an interactive, least-privilege
 * principal for the user, `serve` with the data directory and port, no time
 * limit, restarted when it fails. It runs through `conhost.exe --headless`:
 * node is a console program, and a task that starts one directly opens a
 * console window at every logon, which Windows 11 hands to Windows Terminal
 * whatever the window style asked for. Task Scheduler cannot redirect output,
 * so this service writes no log file.
 */
export const renderTaskXml = (spec: ServiceSpec, user: string): string =>
  [
    '<?xml version="1.0" encoding="UTF-16"?>',
    `<!-- The ${SERVICE_LABEL} environment. Written by "${SERVICE_LABEL} service install"; "${SERVICE_LABEL} service uninstall" removes it. -->`,
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    `    <Description>The ${escapeXml(SERVICE_LABEL)} environment, started at logon.</Description>`,
    "  </RegistrationInfo>",
    "  <Triggers>",
    "    <LogonTrigger>",
    "      <Enabled>true</Enabled>",
    `      <UserId>${escapeXml(user)}</UserId>`,
    "    </LogonTrigger>",
    "  </Triggers>",
    "  <Principals>",
    '    <Principal id="Author">',
    `      <UserId>${escapeXml(user)}</UserId>`,
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <AllowStartOnDemand>true</AllowStartOnDemand>",
    "    <Enabled>true</Enabled>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <RestartOnFailure>",
    "      <Interval>PT1M</Interval>",
    "      <Count>999</Count>",
    "    </RestartOnFailure>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    "      <Command>%SystemRoot%\\System32\\conhost.exe</Command>",
    `      <Arguments>${escapeXml(["--headless", ...serveArguments(spec).map(windowsArgument)].join(" "))}</Arguments>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\n");

/** The user the task runs as, `DOMAIN\name` when Windows names a domain (the machine name on a machine outside one). */
const taskUser = (installContext: InstallContext): string => {
  const domain = installContext.env["USERDOMAIN"];
  return domain ? `${domain}\\${installContext.username}` : installContext.username;
};

/**
 * The task in Task Scheduler's root folder under the label, managed with
 * `schtasks`. The definition is not a file the user owns: `/Create` takes the
 * XML from a file in the data directory, which is removed at once.
 */
export const taskSchedulerPlatform = (installContext: InstallContext, commands: ServiceCommands): ServicePlatform => {
  const name = SERVICE_LABEL;
  const schtasks = (...args: string[]) => commands.run("schtasks", args);
  const isRunning = async () => {
    const result = await commands.query("schtasks", ["/Query", "/TN", name, "/FO", "CSV", "/NH"]);
    // The status column is localised; "Running" is the English one (see the service install checklist).
    return result.code === 0 && /"Running"\s*$/m.test(result.stdout);
  };

  return {
    kind: "task-scheduler",
    definitionPath: () => `\\${name}`,
    install: async (spec) => {
      const wasRunning = await isRunning();
      const file = join(spec.dataDir, TASK_XML_FILE);
      // schtasks reads task XML reliably only as UTF-16 with a byte order mark.
      writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(renderTaskXml(spec, taskUser(installContext)), "utf16le")]));
      try {
        await schtasks("/Create", "/TN", name, "/XML", file, "/F");
      } finally {
        rmSync(file, { force: true });
      }
      if (wasRunning) {
        await schtasks("/End", "/TN", name);
        await schtasks("/Run", "/TN", name);
      }
      return { createdDirectories: [] };
    },
    uninstall: async () => {
      if (await isRunning()) await schtasks("/End", "/TN", name);
      await schtasks("/Delete", "/TN", name, "/F");
    },
    start: async () => {
      await schtasks("/Run", "/TN", name);
    },
    isInstalled: async () => (await commands.query("schtasks", ["/Query", "/TN", name])).code === 0,
    isRunning,
    notes: async () => [],
  };
};
