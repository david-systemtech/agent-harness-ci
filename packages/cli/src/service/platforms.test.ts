import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostAt, makeTempDir, stubRunner, type Answer } from "../../test/service-helpers.js";
import { renderLaunchdPlist } from "./launchd.js";
import { createServicePlatform, ServiceCommandError, UnsupportedPlatformError } from "./platform.js";
import { SERVICE_LABEL, type ServiceSpec } from "./spec.js";
import { renderSystemdUnit } from "./systemd.js";
import { renderTaskXml } from "./task-scheduler.js";

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
  label: SERVICE_LABEL,
  program: ["/usr/bin/node", "/opt/agent-harness/dist/main.js"],
  dataDir: join(home, "state", "agent-harness"),
  port: 7433,
});

const platformFor = (platform: NodeJS.Platform, home: string, answer?: Answer, env: Record<string, string> = {}) => {
  const stub = stubRunner(answer);
  return { ...stub, service: createServicePlatform(hostAt(platform, home, env), stub.runner) };
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

  it("install writes the unit, creates the log directory, reloads, enables, and restarts only a running unit", async () => {
    const home = tempHome();
    const spec = specIn(home);
    const { service, calls } = platformFor("linux", home);

    await service.install(spec);

    expect(readFileSync(unitPath(home), "utf8")).toBe(renderSystemdUnit(spec));
    expect(statSync(join(spec.dataDir, "logs")).isDirectory()).toBe(true);
    expect(calls).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable agent-harness.service",
      "systemctl --user try-restart agent-harness.service",
    ]);
  });

  it("install removes the unit it wrote when systemd refuses it, and says what systemd said", async () => {
    const home = tempHome();
    const { service } = platformFor("linux", home, (_, args) =>
      args.includes("daemon-reload") ? { code: 1, stderr: "Failed to connect to bus: No medium found" } : undefined,
    );

    const failure = service.install(specIn(home));
    await expect(failure).rejects.toThrow(ServiceCommandError);
    await expect(failure).rejects.toThrow(/systemctl --user daemon-reload.*Failed to connect to bus/s);
    expect(existsSync(unitPath(home))).toBe(false);
  });

  it("install puts back the unit it replaced when systemd refuses the new one", async () => {
    const home = tempHome();
    mkdirSync(dirname(unitPath(home)), { recursive: true });
    writeFileSync(unitPath(home), "the previous unit\n");
    const { service } = platformFor("linux", home, (_, args) => (args.includes("enable") ? { code: 1 } : undefined));

    await expect(service.install(specIn(home))).rejects.toThrow(ServiceCommandError);
    expect(readFileSync(unitPath(home), "utf8")).toBe("the previous unit\n");
  });

  it("uninstall stops and disables the unit, removes the file and reloads", async () => {
    const home = tempHome();
    const { service, calls } = platformFor("linux", home);
    await service.install(specIn(home));
    calls.length = 0;

    await service.uninstall();

    expect(existsSync(unitPath(home))).toBe(false);
    expect(calls).toEqual(["systemctl --user disable --now agent-harness.service", "systemctl --user daemon-reload"]);
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
    await service.install(specIn(home));
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

  it("install writes the agent and creates the log directory, loading nothing when no agent was loaded", async () => {
    const home = tempHome();
    const spec = specIn(home);
    const { service, calls } = platformFor("darwin", home, notLoaded);

    await service.install(spec);

    expect(readFileSync(plistPath(home), "utf8")).toBe(renderLaunchdPlist(spec));
    expect(statSync(join(spec.dataDir, "logs")).isDirectory()).toBe(true);
    expect(calls).toEqual(["launchctl print gui/501/agent-harness"]);
  });

  it("install boots out a loaded agent and bootstraps the new one when the old one was running", async () => {
    const home = tempHome();
    const { service, calls } = platformFor("darwin", home, loaded("running"));
    await service.install(specIn(home));
    expect(calls).toEqual([
      "launchctl print gui/501/agent-harness",
      "launchctl bootout gui/501/agent-harness",
      `launchctl bootstrap gui/501 ${plistPath(home)}`,
    ]);
  });

  it("install boots out a loaded agent that was not running and leaves it for start", async () => {
    const home = tempHome();
    const { service, calls } = platformFor("darwin", home, loaded("not running"));
    await service.install(specIn(home));
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
    await service.install(specIn(home));
    calls.length = 0;

    await service.uninstall();

    expect(existsSync(plistPath(home))).toBe(false);
    expect(calls).toEqual(["launchctl print gui/501/agent-harness", "launchctl bootout gui/501/agent-harness"]);
  });

  it("is running only when launchd prints the job's state as running", async () => {
    expect(await platformFor("darwin", tempHome(), loaded("running")).service.isRunning()).toBe(true);
    expect(await platformFor("darwin", tempHome(), loaded("not running")).service.isRunning()).toBe(false);
    expect(await platformFor("darwin", tempHome(), notLoaded).service.isRunning()).toBe(false);
  });

  it("fails with a sentence when the platform has no user id to name the launchd domain", () => {
    const stub = stubRunner();
    expect(() => createServicePlatform({ ...hostAt("darwin", tempHome()), uid: undefined }, stub.runner)).toThrow(
      /user id/,
    );
  });
});

describe("the Task Scheduler logon task", () => {
  const running: Answer = (_, args) =>
    args.includes("CSV") ? { stdout: '"\\agent-harness","N/A","Running"\r\n' } : undefined;

  it("install renders the task XML into the data directory as UTF-16, creates the task from it, and removes the file", async () => {
    const home = tempHome();
    const spec = specIn(home);
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

    await service.install(spec);

    expect(calls).toEqual([
      "schtasks /Query /TN agent-harness /FO CSV /NH",
      `schtasks /Create /TN agent-harness /XML ${xmlFile} /F`,
    ]);
    expect(written?.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect(written?.subarray(2).toString("utf16le")).toBe(renderTaskXml(spec, "GAMINGPC\\david"));
    expect(existsSync(xmlFile)).toBe(false);
    expect(statSync(join(spec.dataDir, "logs")).isDirectory()).toBe(true);
  });

  it("install removes the XML file even when schtasks refuses the task", async () => {
    const home = tempHome();
    const spec = specIn(home);
    const { service } = platformFor("win32", home, (_, args) =>
      args[0] === "/Create" ? { code: 1, stderr: "ERROR: Access is denied." } : { code: 1 },
    );
    await expect(service.install(spec)).rejects.toThrow(/Access is denied/);
    expect(existsSync(join(spec.dataDir, "service-task.xml"))).toBe(false);
  });

  it("install ends and reruns a task that was running, onto the new definition", async () => {
    const home = tempHome();
    const spec = specIn(home);
    const { service, calls } = platformFor("win32", home, running);
    await service.install(spec);
    expect(calls).toEqual([
      "schtasks /Query /TN agent-harness /FO CSV /NH",
      `schtasks /Create /TN agent-harness /XML ${join(spec.dataDir, "service-task.xml")} /F`,
      "schtasks /End /TN agent-harness",
      "schtasks /Run /TN agent-harness",
    ]);
  });

  it("names the task's user with its domain when Windows gives one", async () => {
    const home = tempHome();
    const spec = specIn(home);
    let written = "";
    const { service } = platformFor("win32", home, (_, args) => {
      if (args[0] === "/Create") written = readFileSync(join(spec.dataDir, "service-task.xml")).subarray(2).toString("utf16le");
      return args.includes("CSV") ? { code: 1 } : undefined;
    });
    await service.install(spec);
    expect(written).toBe(renderTaskXml(spec, "david"));
  });

  it("start runs the task; uninstall ends a running task and deletes it", async () => {
    const { service, calls } = platformFor("win32", tempHome(), running);
    await service.start();
    expect(calls).toEqual(["schtasks /Run /TN agent-harness"]);
    calls.length = 0;
    await service.uninstall();
    expect(calls).toEqual([
      "schtasks /Query /TN agent-harness /FO CSV /NH",
      "schtasks /End /TN agent-harness",
      "schtasks /Delete /TN agent-harness /F",
    ]);
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
