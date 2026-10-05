import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installContextAt, makeTempDir, stubRunner, type Answer } from "../../test/service-helpers.js";
import { renderLaunchdPlist } from "./launchd.js";
import { createServicePlatform, ServiceCommandError, UnsupportedPlatformError } from "./platform.js";
import { COMMAND_TIMEOUT_MS, STOP_COMMAND_TIMEOUT_MS } from "./runner.js";
import type { ServiceSpec } from "./spec.js";
import { renderSystemdUnit } from "./systemd.js";
import { renderTaskXml, decodeTaskXml } from "./task-scheduler.js";
import { windowsStopArguments } from "./windows-stop.js";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

const tempHome = (): string => {
  const dir = makeTempDir();
  cleanups.push(dir.remove);
  return dir.path;
};

const specIn = (home: string): ServiceSpec => ({
  dataDir: join(home, "state", "agent-harness"),
  entry: join(home, "state", "agent-harness", "launcher-entry.sh"),
});

/** A spec whose data directory exists, as the install verb leaves it before the platform writes into it. */
const preparedSpecIn = (home: string): ServiceSpec => {
  const spec = specIn(home);
  mkdirSync(spec.dataDir, { recursive: true });
  return spec;
};

/** An install that restarts a running service onto its new definition, as one over a service that runs no launcher is. */
const RESTART = { restartRunning: true } as const;

const platformFor = (platform: NodeJS.Platform, home: string, answer?: Answer, env: Record<string, string> = {}) => {
  const stub = stubRunner(answer);
  return { ...stub, service: createServicePlatform(installContextAt(platform, home, env), stub.runner) };
};

describe("the platform choice", () => {
  it("is launchd on macOS, systemd on Linux and Task Scheduler on Windows", () => {
    const home = tempHome();
    expect(platformFor("darwin", home).service.kind).toBe("launchd");
    expect(platformFor("linux", home).service.kind).toBe("systemd");
    expect(platformFor("win32", home).service.kind).toBe("task-scheduler");
  });

  it("refuses any other platform with a sentence naming the three it supports", () => {
    expect(() => platformFor("freebsd", tempHome())).toThrow(UnsupportedPlatformError);
    expect(() => platformFor("freebsd", tempHome())).toThrow(/macOS.*Linux.*Windows/);
  });
});

describe("the systemd user unit", () => {
  const unitPath = (home: string) => join(home, ".config", "systemd", "user", "agent-harness.service");

  it("lives under ~/.config/systemd/user, or under an absolute XDG_CONFIG_HOME", () => {
    const home = tempHome();
    expect(platformFor("linux", home).service.definitionPath()).toBe(unitPath(home));
    const xdg = join(home, "xdg");
    expect(platformFor("linux", home, undefined, { XDG_CONFIG_HOME: xdg }).service.definitionPath()).toBe(
      join(xdg, "systemd", "user", "agent-harness.service"),
    );
    expect(platformFor("linux", home, undefined, { XDG_CONFIG_HOME: "relative" }).service.definitionPath()).toBe(
      unitPath(home),
    );
  });

  it("install writes the unit, reloads, enables, restarts only a running unit, and reports the folders it created", async () => {
    const home = tempHome();
    const spec = specIn(home);
    const { service, calls } = platformFor("linux", home);

    const installed = await service.install(spec, RESTART);

    expect(readFileSync(unitPath(home), "utf8")).toBe(renderSystemdUnit(spec));
    expect(installed.createdDirectories).toEqual([
      join(home, ".config"),
      join(home, ".config", "systemd"),
      join(home, ".config", "systemd", "user"),
    ]);
    expect((await service.install(spec, RESTART)).createdDirectories).toEqual([]);
    expect(calls.slice(0, 3)).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable agent-harness.service",
      "systemctl --user try-restart agent-harness.service",
    ]);
  });

  it("install removes the unit and the folders it wrote when systemd refuses it, reloads, and says what systemd said", async () => {
    const home = tempHome();
    let reloads = 0;
    const { service, calls } = platformFor("linux", home, (_, args) =>
      args.includes("daemon-reload") && reloads++ === 0 ? { code: 1, stderr: "Failed to connect to bus: No medium found" } : undefined,
    );

    const failure = service.install(specIn(home), RESTART);
    await expect(failure).rejects.toThrow(ServiceCommandError);
    await expect(failure).rejects.toThrow(/systemctl --user daemon-reload.*Failed to connect to bus/s);
    expect(existsSync(unitPath(home))).toBe(false);
    expect(existsSync(join(home, ".config"))).toBe(false);
    expect(calls).toEqual(["systemctl --user daemon-reload", "systemctl --user daemon-reload"]);
  });

  it("install disables a new unit it had enabled when a later step fails, then removes it and reloads", async () => {
    const home = tempHome();
    const { service, calls } = platformFor("linux", home, (_, args) => (args.includes("try-restart") ? { code: 1 } : undefined));

    await expect(service.install(specIn(home), RESTART)).rejects.toThrow(ServiceCommandError);
    expect(existsSync(unitPath(home))).toBe(false);
    expect(calls).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable agent-harness.service",
      "systemctl --user try-restart agent-harness.service",
      "systemctl --user disable agent-harness.service",
      "systemctl --user daemon-reload",
    ]);
  });

  it("install puts back the unit it replaced and the enablement it had, then reloads, when systemd refuses the new one", async () => {
    for (const failing of ["enable", "try-restart"]) {
      for (const previously of ["enabled", "disabled"]) {
        const home = tempHome();
        mkdirSync(dirname(unitPath(home)), { recursive: true });
        writeFileSync(unitPath(home), "the previous unit\n");
        const { service, calls } = platformFor("linux", home, (_, args) => {
          if (args.includes("is-enabled")) return { code: previously === "enabled" ? 0 : 1, stdout: `${previously}\n` };
          if (args.includes("is-active")) return { code: 1, stdout: "inactive\n" };
          return args.includes(failing) ? { code: 1 } : undefined;
        });

        await expect(service.install(specIn(home), RESTART), `${failing} ${previously}`).rejects.toThrow(ServiceCommandError);
        expect(readFileSync(unitPath(home), "utf8")).toBe("the previous unit\n");
        // A unit that was disabled before is disabled again once enable succeeded; an enabled one keeps its enablement.
        const disables = calls.filter((call) => call.includes(" disable "));
        const enableSucceeded = failing !== "enable";
        expect(disables, `${failing} ${previously}`).toEqual(
          enableSucceeded && previously === "disabled" ? ["systemctl --user disable agent-harness.service"] : [],
        );
        expect(calls.at(-1)).toBe("systemctl --user daemon-reload");
      }
    }
  });

  it("install over a running unit asked to leave it running reloads and enables the new unit and restarts nothing", async () => {
    const home = tempHome();
    mkdirSync(dirname(unitPath(home)), { recursive: true });
    writeFileSync(unitPath(home), "the previous unit\n");
    const { service, calls } = platformFor("linux", home, (_, args) => (args.includes("is-active") ? { stdout: "active\n" } : undefined));
    await service.install(specIn(home), { restartRunning: false });
    expect(readFileSync(unitPath(home), "utf8")).toBe(renderSystemdUnit(specIn(home)));
    expect(calls.filter((call) => !call.includes(" is-"))).toEqual(["systemctl --user daemon-reload", "systemctl --user enable agent-harness.service"]);
  });

  it("install starts the replaced unit again when it was running and the restart onto the new one failed", async () => {
    const home = tempHome();
    mkdirSync(dirname(unitPath(home)), { recursive: true });
    writeFileSync(unitPath(home), "the previous unit\n");
    const { service, calls } = platformFor("linux", home, (_, args) => {
      if (args.includes("is-active")) return { code: 0, stdout: "active\n" };
      if (args.includes("is-enabled")) return { code: 0, stdout: "enabled\n" };
      return args.includes("try-restart") ? { code: 1 } : undefined;
    });
    await expect(service.install(specIn(home), RESTART)).rejects.toThrow(ServiceCommandError);
    expect(readFileSync(unitPath(home), "utf8")).toBe("the previous unit\n");
    expect(calls.slice(-2)).toEqual(["systemctl --user daemon-reload", "systemctl --user start agent-harness.service"]);
  });

  it("install treats an enablement probe that cannot run as not enabled, and still puts the replaced unit back on a refusal", async () => {
    const home = tempHome();
    mkdirSync(dirname(unitPath(home)), { recursive: true });
    writeFileSync(unitPath(home), "the previous unit\n");
    const { service, calls } = platformFor("linux", home, (_, args) => {
      if (args.includes("is-enabled")) throw new Error("spawn systemctl ENOENT");
      return args.includes("try-restart") ? { code: 1 } : undefined;
    });

    await expect(service.install(specIn(home), RESTART)).rejects.toThrow(ServiceCommandError);
    expect(readFileSync(unitPath(home), "utf8")).toBe("the previous unit\n");
    expect(calls.filter((call) => call.includes(" disable "))).toEqual(["systemctl --user disable agent-harness.service"]);
  });

  it("reports not running and no notes when systemctl and loginctl cannot be spawned at all", async () => {
    const home = tempHome();
    const { service } = platformFor("linux", home, () => {
      throw new Error("spawn systemctl ENOENT");
    });
    expect(await service.isRunning()).toBe(false);
    expect(await service.notes()).toEqual([]);
  });

  it("install changes nothing and runs nothing when the existing unit cannot be read", async () => {
    const home = tempHome();
    mkdirSync(unitPath(home), { recursive: true });
    const { service, calls } = platformFor("linux", home);

    await expect(service.install(specIn(home), RESTART)).rejects.toThrow(/could not read the existing definition/i);
    expect(statSync(unitPath(home)).isDirectory()).toBe(true);
    expect(calls).toEqual([]);
  });

  it("uninstall stops and disables the unit, removes the file and reloads", async () => {
    const home = tempHome();
    const { service, calls } = platformFor("linux", home);
    await service.install(specIn(home), RESTART);
    calls.length = 0;

    await service.uninstall();

    expect(existsSync(unitPath(home))).toBe(false);
    expect(calls).toEqual(["systemctl --user disable --now agent-harness.service", "systemctl --user daemon-reload"]);
  });

  it("uninstall removes the wants directory enable left behind when it is empty, and keeps one that is not", async () => {
    for (const other of [undefined, "other.service"]) {
      const home = tempHome();
      const wants = join(dirname(unitPath(home)), "default.target.wants");
      mkdirSync(wants, { recursive: true });
      writeFileSync(unitPath(home), "a unit\n");
      if (other) writeFileSync(join(wants, other), "");
      const { service } = platformFor("linux", home);

      await service.uninstall();

      expect(existsSync(unitPath(home))).toBe(false);
      expect(existsSync(wants), other ?? "empty").toBe(other !== undefined);
    }
  });

  it("gives the commands that stop the unit, try-restart and disable --now, the stop's wait and a minute, and every other 30 seconds", async () => {
    const home = tempHome();
    const { service, timeouts } = platformFor("linux", home);
    await service.install(specIn(home), RESTART);
    // Over its own unit, which systemd calls active: the probes of the unit replaced run too.
    await service.install(specIn(home), RESTART);
    await service.start();
    await service.uninstall();

    expect(Object.fromEntries(timeouts)).toEqual({
      "systemctl --user is-active agent-harness.service": COMMAND_TIMEOUT_MS,
      "systemctl --user is-enabled agent-harness.service": COMMAND_TIMEOUT_MS,
      "systemctl --user daemon-reload": COMMAND_TIMEOUT_MS,
      "systemctl --user enable agent-harness.service": COMMAND_TIMEOUT_MS,
      "systemctl --user try-restart agent-harness.service": STOP_COMMAND_TIMEOUT_MS,
      "systemctl --user start agent-harness.service": COMMAND_TIMEOUT_MS,
      "systemctl --user disable --now agent-harness.service": STOP_COMMAND_TIMEOUT_MS,
    });
  });

  it("start starts the unit", async () => {
    const { service, calls } = platformFor("linux", tempHome());
    await service.start();
    expect(calls).toEqual(["systemctl --user start agent-harness.service"]);
  });

  it("is installed when the unit file exists, and running when systemd says it is active", async () => {
    const home = tempHome();
    let active = false;
    const { service } = platformFor("linux", home, (_, args) =>
      args.includes("is-active") ? (active ? { stdout: "active\n" } : { code: 3, stdout: "inactive\n" }) : undefined,
    );
    expect(await service.isInstalled()).toBe(false);
    expect(await service.isRunning()).toBe(false);
    await service.install(specIn(home), RESTART);
    active = true;
    expect(await service.isInstalled()).toBe(true);
    expect(await service.isRunning()).toBe(true);
  });

  it("notes that the unit stops at logout when lingering is off for the user, and says how to change it", async () => {
    let linger = "no";
    const { service, calls } = platformFor("linux", tempHome(), (command) =>
      command === "loginctl" ? { stdout: `${linger}\n` } : undefined,
    );
    const notes = await service.notes();
    expect(calls).toEqual(["loginctl show-user david --property=Linger --value"]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/linger/i);
    expect(notes[0]).toContain("loginctl enable-linger david");
    linger = "yes";
    expect(await service.notes()).toEqual([]);
  });

  it("notes nothing when loginctl cannot say", async () => {
    const { service } = platformFor("linux", tempHome(), () => ({ code: 1 }));
    expect(await service.notes()).toEqual([]);
  });
});

describe("the launchd agent", () => {
  const plistPath = (home: string) => join(home, "Library", "LaunchAgents", "agent-harness.plist");
  const notLoaded: Answer = (_, args) =>
    args[0] === "print" ? { code: 113, stderr: 'Could not find service "agent-harness" in domain for user gui: 501' } : undefined;
  const loaded =
    (state: string): Answer =>
    (_, args) =>
      args[0] === "print" ? { stdout: `gui/501/agent-harness = {\n\tactive count = 1\n\tstate = ${state}\n}\n` } : undefined;

  it("lives in ~/Library/LaunchAgents under the label", () => {
    const home = tempHome();
    expect(platformFor("darwin", home).service.definitionPath()).toBe(plistPath(home));
  });

  it("install writes the agent, loading nothing when no agent was loaded, and reports the folders it created", async () => {
    const home = tempHome();
    const spec = specIn(home);
    const { service, calls } = platformFor("darwin", home, notLoaded);

    const installed = await service.install(spec, RESTART);

    expect(readFileSync(plistPath(home), "utf8")).toBe(renderLaunchdPlist(spec));
    expect(installed.createdDirectories).toEqual([join(home, "Library"), join(home, "Library", "LaunchAgents")]);
    expect(calls).toEqual(["launchctl print gui/501/agent-harness"]);
  });

  it("install puts back the agent it replaced and bootstraps it again when the new one will not load", async () => {
    const home = tempHome();
    mkdirSync(dirname(plistPath(home)), { recursive: true });
    writeFileSync(plistPath(home), "the previous agent\n");
    let bootstraps = 0;
    const { service, calls } = platformFor("darwin", home, (command, args) => {
      if (args[0] === "bootstrap" && bootstraps++ === 0) return { code: 5, stderr: "Bootstrap failed: 5: Input/output error" };
      return loaded("running")(command, args);
    });

    await expect(service.install(specIn(home), RESTART)).rejects.toThrow(/Input\/output error/);
    expect(readFileSync(plistPath(home), "utf8")).toBe("the previous agent\n");
    expect(calls).toEqual([
      "launchctl print gui/501/agent-harness",
      "launchctl bootout gui/501/agent-harness",
      `launchctl bootstrap gui/501 ${plistPath(home)}`,
      `launchctl bootstrap gui/501 ${plistPath(home)}`,
    ]);
  });

  it("install changes nothing and runs nothing when the existing agent cannot be read", async () => {
    const home = tempHome();
    mkdirSync(plistPath(home), { recursive: true });
    const { service, calls } = platformFor("darwin", home, loaded("running"));
    await expect(service.install(specIn(home), RESTART)).rejects.toThrow(/could not read the existing definition/i);
    expect(calls).toEqual([]);
  });

  it("install boots out a loaded agent and bootstraps the new one when the old one was running", async () => {
    const home = tempHome();
    const { service, calls } = platformFor("darwin", home, loaded("running"));
    await service.install(specIn(home), RESTART);
    expect(calls).toEqual([
      "launchctl print gui/501/agent-harness",
      "launchctl bootout gui/501/agent-harness",
      `launchctl bootstrap gui/501 ${plistPath(home)}`,
    ]);
  });

  it("install over a running agent asked to leave it running writes the new agent for its next load and unloads nothing", async () => {
    const home = tempHome();
    const { service, calls } = platformFor("darwin", home, loaded("running"));
    await service.install(specIn(home), { restartRunning: false });
    expect(readFileSync(plistPath(home), "utf8")).toBe(renderLaunchdPlist(specIn(home)));
    expect(calls).toEqual(["launchctl print gui/501/agent-harness"]);
  });

  it("install boots out a loaded agent that was not running and leaves it for start", async () => {
    const home = tempHome();
    const { service, calls } = platformFor("darwin", home, loaded("not running"));
    await service.install(specIn(home), RESTART);
    expect(calls).toEqual(["launchctl print gui/501/agent-harness", "launchctl bootout gui/501/agent-harness"]);
  });

  it("start bootstraps an agent that is not loaded, and kickstarts one that is", async () => {
    const first = platformFor("darwin", tempHome(), notLoaded);
    await first.service.start();
    expect(first.calls).toEqual([
      "launchctl print gui/501/agent-harness",
      `launchctl bootstrap gui/501 ${first.service.definitionPath()}`,
    ]);

    const second = platformFor("darwin", tempHome(), loaded("not running"));
    await second.service.start();
    expect(second.calls).toEqual(["launchctl print gui/501/agent-harness", "launchctl kickstart gui/501/agent-harness"]);
  });

  it("uninstall boots out a loaded agent and removes the file", async () => {
    const home = tempHome();
    const { service, calls } = platformFor("darwin", home, loaded("running"));
    await service.install(specIn(home), RESTART);
    calls.length = 0;

    await service.uninstall();

    expect(existsSync(plistPath(home))).toBe(false);
    expect(calls).toEqual(["launchctl print gui/501/agent-harness", "launchctl bootout gui/501/agent-harness"]);
  });

  it("gives bootout, which stops a running agent, the stop's wait and a minute, and every other command 30 seconds", async () => {
    const home = tempHome();
    const { service, timeouts } = platformFor("darwin", home, loaded("running"));
    await service.install(specIn(home), RESTART);
    await service.start();
    await service.uninstall();

    expect(Object.fromEntries(timeouts)).toEqual({
      "launchctl print gui/501/agent-harness": COMMAND_TIMEOUT_MS,
      "launchctl bootout gui/501/agent-harness": STOP_COMMAND_TIMEOUT_MS,
      [`launchctl bootstrap gui/501 ${plistPath(home)}`]: COMMAND_TIMEOUT_MS,
      "launchctl kickstart gui/501/agent-harness": COMMAND_TIMEOUT_MS,
    });
  });

  it("is running only when launchd prints the job's state as running", async () => {
    expect(await platformFor("darwin", tempHome(), loaded("running")).service.isRunning()).toBe(true);
    expect(await platformFor("darwin", tempHome(), loaded("not running")).service.isRunning()).toBe(false);
    expect(await platformFor("darwin", tempHome(), notLoaded).service.isRunning()).toBe(false);
  });

  it("fails with a sentence when the platform has no user id to name the launchd domain", () => {
    const stub = stubRunner();
    expect(() => createServicePlatform({ ...installContextAt("darwin", tempHome()), uid: undefined }, stub.runner)).toThrow(
      /user id/,
    );
  });
});

describe("the Task Scheduler logon task", () => {
  const running: Answer = (_, args) =>
    args.includes("CSV") ? { stdout: '"\\agent-harness","N/A","Running"\r\n' } : undefined;

  it("install renders the task XML into the data directory as UTF-16, creates the task from it, and removes the file", async () => {
    const home = tempHome();
    const spec = preparedSpecIn(home);
    const xmlFile = join(spec.dataDir, "service-task.xml");
    let written: Buffer | undefined;
    const { service, calls } = platformFor(
      "win32",
      home,
      (_, args) => {
        if (args[0] === "/Create") written = readFileSync(xmlFile);
        return args.includes("CSV") ? { code: 1 } : undefined;
      },
      { USERDOMAIN: "GAMINGPC" },
    );

    await service.install(spec, RESTART);

    expect(calls).toEqual([
      "schtasks /Query /TN agent-harness",
      "schtasks /Query /TN agent-harness /FO CSV /NH",
      "schtasks /Query /TN agent-harness /XML",
      `schtasks /Create /TN agent-harness /XML ${xmlFile} /F`,
    ]);
    expect(written?.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect(written?.subarray(2).toString("utf16le")).toBe(renderTaskXml(spec, "GAMINGPC\\david"));
    expect(existsSync(xmlFile)).toBe(false);
  });

  it("install removes the XML file even when schtasks refuses the task", async () => {
    const home = tempHome();
    const spec = preparedSpecIn(home);
    const { service } = platformFor("win32", home, (_, args) =>
      args[0] === "/Create" ? { code: 1, stderr: "ERROR: Access is denied." } : { code: 1 },
    );
    await expect(service.install(spec, RESTART)).rejects.toThrow(/Access is denied/);
    expect(existsSync(join(spec.dataDir, "service-task.xml"))).toBe(false);
  });

  it("install ends and reruns a task that was running, onto the new definition", async () => {
    const home = tempHome();
    const spec = preparedSpecIn(home);
    const { service, calls } = platformFor("win32", home, running);
    await service.install(spec, RESTART);
    expect(calls).toEqual([
      "schtasks /Query /TN agent-harness",
      "schtasks /Query /TN agent-harness /FO CSV /NH",
      "schtasks /Query /TN agent-harness /XML",
      `schtasks /Create /TN agent-harness /XML ${join(spec.dataDir, "service-task.xml")} /F`,
      "schtasks /End /TN agent-harness",
      "schtasks /Run /TN agent-harness",
    ]);
  });

  it("install over a running task asked to leave it running replaces the task and neither ends nor reruns it", async () => {
    const home = tempHome();
    const spec = preparedSpecIn(home);
    const { service, calls } = platformFor("win32", home, running);
    await service.install(spec, { restartRunning: false });
    expect(calls.filter((call) => !call.startsWith("schtasks /Query"))).toEqual([`schtasks /Create /TN agent-harness /XML ${join(spec.dataDir, "service-task.xml")} /F`]);
  });

  it("install puts the previous task back and runs it again when rerunning the task fails after /Create", async () => {
    const home = tempHome();
    const spec = preparedSpecIn(home);
    const previous = '<?xml version="1.0" encoding="UTF-16"?><Task>previous</Task>';
    const { service, calls } = platformFor("win32", home, (_, args) => {
      if (args.includes("/XML") && args.includes("/Query")) return { code: 0, stdout: previous };
      if (args.includes("/End")) return { code: 1, stderr: "ERROR: The task is not running." };
      return running(_, args);
    });
    await expect(service.install(spec, RESTART)).rejects.toThrow(ServiceCommandError);
    const create = `schtasks /Create /TN agent-harness /XML ${join(spec.dataDir, "service-task.xml")} /F`;
    expect(calls.filter((call) => !call.startsWith("schtasks /Query"))).toEqual([
      create,
      "schtasks /End /TN agent-harness",
      create,
      "schtasks /Run /TN agent-harness",
    ]);
    expect(existsSync(join(spec.dataDir, "service-task.xml"))).toBe(false);
  });

  it("names the task's user without a domain when Windows gives none", async () => {
    const home = tempHome();
    const spec = preparedSpecIn(home);
    let written = "";
    const { service } = platformFor("win32", home, (_, args) => {
      if (args[0] === "/Create") written = readFileSync(join(spec.dataDir, "service-task.xml")).subarray(2).toString("utf16le");
      return args.includes("CSV") ? { code: 1 } : undefined;
    });
    await service.install(spec, RESTART);
    expect(written).toBe(renderTaskXml(spec, "david"));
  });

  it("install keeps the new task, rather than deleting it, when the previous one existed but could not be read back", async () => {
    const home = tempHome();
    const spec = preparedSpecIn(home);
    const { service, calls } = platformFor("win32", home, (_, args) => {
      if (args.includes("/XML") && args.includes("/Query")) return { code: 1, stderr: "ERROR: access denied" };
      if (args.includes("/End")) return { code: 1 };
      return running(_, args);
    });
    await expect(service.install(spec, RESTART)).rejects.toThrow(ServiceCommandError);
    expect(calls.filter((call) => call.includes("/Delete") || call.includes("/Create")).length).toBe(1);
  });

  it("install runs the previous task again after putting it back when /Run refused the new one", async () => {
    const home = tempHome();
    const spec = preparedSpecIn(home);
    const previous = '<?xml version="1.0" encoding="UTF-16"?><Task>previous</Task>';
    let creates = 0;
    const { service, calls } = platformFor("win32", home, (_, args) => {
      if (args.includes("/XML") && args.includes("/Query")) return { code: 0, stdout: previous };
      if (args.includes("/Create")) creates += 1;
      if (args.includes("/Run") && creates === 1) return { code: 1 };
      return running(_, args);
    });
    await expect(service.install(spec, RESTART)).rejects.toThrow(ServiceCommandError);
    expect(calls.slice(-2)).toEqual([
      `schtasks /Create /TN agent-harness /XML ${join(spec.dataDir, "service-task.xml")} /F`,
      "schtasks /Run /TN agent-harness",
    ]);
  });

  it("reads a previous task that schtasks printed as UTF-16 back into text before putting it back", async () => {
    const xml = '<?xml version="1.0" encoding="UTF-16"?><Task>previous</Task>';
    const asUtf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]).toString("utf8");
    expect(decodeTaskXml(asUtf16)).toBe(xml);
    expect(decodeTaskXml(`\ufeff${xml}`)).toBe(xml);
    expect(decodeTaskXml(xml)).toBe(xml);
  });

  it("start runs the task; uninstall stops its process tree before deleting it", async () => {
    const { service, calls } = platformFor("win32", tempHome(), running);
    await service.start();
    expect(calls).toEqual(["schtasks /Run /TN agent-harness"]);
    calls.length = 0;
    await service.uninstall();
    expect(calls).toEqual([
      ["powershell.exe", ...windowsStopArguments()].join(" "),
      "schtasks /Delete /TN agent-harness /F",
    ]);
  });

  it("keeps registration when process-tree shutdown fails", async () => {
    const { service, calls } = platformFor("win32", tempHome(), (command) =>
      command === "powershell.exe" ? { code: 1, stderr: "A scheduled task process survived cleanup" } : undefined,
    );
    await expect(service.uninstall()).rejects.toThrow(/survived cleanup/);
    await expect(service.uninstall()).rejects.toThrow(/^Could not stop the scheduled task's process tree:/);
    expect(calls.some((call) => call.includes("/Delete"))).toBe(false);
  });

  it("gives every command 30 seconds, /End too: it sends no signal, so a stop waits for no drain", async () => {
    const home = tempHome();
    const { service, timeouts } = platformFor("win32", home, running);
    await service.install(preparedSpecIn(home), RESTART);
    await service.uninstall();

    expect(timeouts.get("schtasks /End /TN agent-harness")).toBe(COMMAND_TIMEOUT_MS);
    expect(new Set(timeouts.values())).toEqual(new Set([COMMAND_TIMEOUT_MS]));
  });

  it("is installed when schtasks finds the task, and running when its status is Running", async () => {
    const present = platformFor("win32", tempHome(), running).service;
    expect(await present.isInstalled()).toBe(true);
    expect(await present.isRunning()).toBe(true);
    const ready = platformFor("win32", tempHome(), (_, args) =>
      args.includes("CSV") ? { stdout: '"\\agent-harness","N/A","Ready"\r\n' } : undefined,
    ).service;
    expect(await ready.isRunning()).toBe(false);
    const absent = platformFor("win32", tempHome(), () => ({ code: 1, stderr: "ERROR: The system cannot find the file specified." })).service;
    expect(await absent.isInstalled()).toBe(false);
    expect(await absent.isRunning()).toBe(false);
  });

  it("names the task by its Task Scheduler path as its definition", () => {
    expect(platformFor("win32", tempHome()).service.definitionPath()).toBe("\\agent-harness");
  });
});
