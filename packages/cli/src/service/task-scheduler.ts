import { rmSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import type { ServicePlatform } from "./platform.js";
import type { ServiceCommands } from "./runner.js";
import { SERVICE_LABEL, type InstallContext, type ServiceSpec } from "./spec.js";
import { escapeXml } from "./xml.js";
import { stopWindowsTask } from "./windows-stop.js";

/** The file in the data directory the task XML is written to for `schtasks /Create`, and removed from after. */
export const TASK_XML_FILE = "service-task.xml";

/**
 * The Task Scheduler task: a logon trigger and an interactive, least-privilege
 * principal for the user, the launcher entry through `cmd.exe`, no time
 * limit, restarted when it fails to start. It runs through `conhost.exe
 * --headless`: cmd and node are console programs, and a task that starts one
 * directly opens a console window at every logon, which Windows 11 hands to
 * Windows Terminal whatever the window style asked for. cmd runs the entry by
 * its name in the entry's folder, the task's working directory: conhost
 * passes on the rest of its command line re-quoted as the C runtime reads it,
 * quoting a path only for a space, and cmd would read an `&` or `^` in a bare
 * path, or strip the quotes of one that is quoted, so no command line carries
 * the path. Task Scheduler cannot redirect output, and has no stop timeout:
 * the entry writes the service log. Uninstall captures and stops the task's
 * process tree because End alone leaves its descendants running.
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
    `      <Arguments>--headless cmd.exe /d /c .\\${escapeXml(win32.basename(spec.entry))}</Arguments>`,
    `      <WorkingDirectory>${escapeXml(win32.dirname(spec.entry))}</WorkingDirectory>`,
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
 * What `schtasks /Query /XML` printed, as text. The runner decodes output as
 * UTF-8; when schtasks writes UTF-16 instead (as its exported task XML is),
 * the decoded text carries a NUL after every ASCII character and a mangled
 * byte order mark in front of the first `<`. Dropping those recovers ASCII XML exactly, which
 * is what the rendered task is; a non-ASCII user name would come back
 * damaged, which the checklist's Windows section asks to check.
 */
export const decodeTaskXml = (output: string): string => output.split("\u0000").join("").replace(/^[^<]+/, "");

/**
 * The task in Task Scheduler's root folder under the label, managed with
 * `schtasks`. The definition is not a file the user owns: `/Create` takes the
 * XML from a file in the data directory, which is removed at once.
 */
export const taskSchedulerPlatform = (installContext: InstallContext, commands: ServiceCommands): ServicePlatform => {
  const name = SERVICE_LABEL;
  const schtasks = (...args: string[]) => commands.run("schtasks", args);
  const isRunning = async () => {
    const result = await commands.probe("schtasks", ["/Query", "/TN", name, "/FO", "CSV", "/NH"]);
    // The status column is localised; "Running" is the English one (see the service install checklist).
    // Matched as a CSV field, wherever the column sits, so a verbose row with trailing columns still counts.
    return result.code === 0 && /(^|,)\s*"Running"\s*(,|$)/m.test(result.stdout);
  };

  return {
    kind: "task-scheduler",
    // A stop ends the task's process tree at once and drains nothing: `/End` sends the launcher no signal.
    drainsOnStop: false,
    definitionPath: () => `\\${name}`,
    install: async (spec, { restartRunning }) => {
      const existed = (await commands.probe("schtasks", ["/Query", "/TN", name])).code === 0;
      const wasRunning = existed && (await isRunning());
      // The previous task, kept so a refusal after /Create can put it back (the ServicePlatform contract).
      const previous = existed ? await commands.query("schtasks", ["/Query", "/TN", name, "/XML"]) : undefined;
      const previousXml =
        previous !== undefined && previous.code === 0 && previous.stdout.trim() !== "" ? decodeTaskXml(previous.stdout) : undefined;
      const file = join(spec.dataDir, TASK_XML_FILE);
      const createFrom = async (xml: string) => {
        // schtasks reads task XML reliably only as UTF-16 with a byte order mark.
        writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]));
        try {
          await schtasks("/Create", "/TN", name, "/XML", file, "/F");
        } finally {
          rmSync(file, { force: true });
        }
      };
      await createFrom(renderTaskXml(spec, taskUser(installContext)));
      // A running task left running takes the new definition at its next start.
      if (wasRunning && restartRunning) {
        try {
          await schtasks("/End", "/TN", name);
          await schtasks("/Run", "/TN", name);
        } catch (error) {
          // Put the previous task back and run it again (a running task always existed before). One that could not be
          // read back is left as the new definition rather than deleted. The original error is the one reported.
          if (previousXml !== undefined) {
            await createFrom(previousXml).catch(() => undefined);
            await commands.attempt("schtasks", ["/Run", "/TN", name]);
          }
          throw error;
        }
      }
      return { createdDirectories: [] };
    },
    uninstall: async () => {
      await stopWindowsTask(commands, "uninstall");
      await schtasks("/Delete", "/TN", name, "/F");
    },
    start: async () => {
      await schtasks("/Run", "/TN", name);
    },
    stop: async () => {
      await stopWindowsTask(commands, "stop");
    },
    isInstalled: async () => (await commands.probe("schtasks", ["/Query", "/TN", name])).code === 0,
    isRunning,
    notes: async () => [],
  };
};
