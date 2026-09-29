import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderLaunchdPlist } from "./launchd.js";
import { SERVICE_LABEL, STOP_TIMEOUT_S, type ServiceSpec } from "./spec.js";
import { renderSystemdUnit } from "./systemd.js";
import { renderTaskXml } from "./task-scheduler.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`../../test/fixtures/service/${name}`, import.meta.url), "utf8");

const macSpec: ServiceSpec = {
  dataDir: "/Users/david/Library/Application Support/agent-harness",
  entry: "/Users/david/Library/Application Support/agent-harness/launcher-entry.sh",
};

const linuxSpec: ServiceSpec = {
  dataDir: "/home/david/.local/state/agent-harness",
  entry: "/home/david/.local/state/agent-harness/launcher-entry.sh",
};

const windowsSpec: ServiceSpec = {
  dataDir: "C:\\Users\\david\\AppData\\Local\\agent-harness",
  entry: "C:\\Users\\david\\AppData\\Local\\agent-harness\\launcher-entry.cmd",
};

describe("the service label", () => {
  it("is the product's placeholder name, the one constant ADR 0017 renames", () => {
    expect(SERVICE_LABEL).toBe("agent-harness");
  });
});

describe("the stop timeout", () => {
  it("is 31 minutes, so the drain's 30 fit inside a stop", () => {
    expect(STOP_TIMEOUT_S).toBe(31 * 60);
  });
});

describe("the launchd agent", () => {
  it("renders as the fixture: the launcher entry through sh, at load, restarted after a non-zero exit, 31 minutes to stop, logging into the data directory", () => {
    expect(renderLaunchdPlist(macSpec)).toBe(fixture("agent-harness.plist"));
  });

  it("escapes XML in every string it writes", () => {
    const plist = renderLaunchdPlist({ dataDir: "/Users/d&c/<state>", entry: "/Users/d&c/<state>/launcher-entry.sh" });
    expect(plist).toContain("<string>/Users/d&amp;c/&lt;state&gt;/launcher-entry.sh</string>");
    expect(plist).toContain("<string>/Users/d&amp;c/&lt;state&gt;/logs/service.log</string>");
    expect(plist).not.toContain("d&c");
  });
});

describe("the systemd user unit", () => {
  it("renders as the fixture: the launcher entry through sh, restarted on failure, the launcher alone asked to stop and given 31 minutes, logging into the data directory", () => {
    expect(renderSystemdUnit(linuxSpec)).toBe(fixture("agent-harness.service"));
  });

  it("quotes an entry holding a backslash or a semicolon, which systemd would otherwise unescape or split on", () => {
    const unit = renderSystemdUnit({ dataDir: "/srv/a\\b;c", entry: "/srv/a\\b;c/launcher-entry.sh" });
    expect(unit).toContain('ExecStart=/bin/sh "/srv/a\\\\b;c/launcher-entry.sh"\n');
  });

  it("quotes an entry with spaces or quotes and escapes the specifier and variable characters", () => {
    const unit = renderSystemdUnit({ dataDir: "/home/david/100% $HOME \"q\"", entry: "/home/david/100% $HOME \"q\"/launcher-entry.sh" });
    const execStart = unit.split("\n").find((line) => line.startsWith("ExecStart="));
    expect(execStart).toBe('ExecStart=/bin/sh "/home/david/100%% $$HOME \\"q\\"/launcher-entry.sh"');
    // Only specifiers are expanded in a log path, not variables.
    expect(unit).toContain('StandardOutput=append:/home/david/100%% $HOME "q"/logs/service.log\n');
  });
});

describe("the Task Scheduler logon task", () => {
  it("renders as the fixture: a logon trigger and principal for the user, the launcher entry through cmd in a headless console, restarted on failure", () => {
    expect(renderTaskXml(windowsSpec, "GAMINGPC\\david")).toBe(fixture("agent-harness-task.xml"));
  });

  it("runs the entry by its name from its own folder, so no command line carries the path cmd would read an & or ^ in", () => {
    for (const dataDir of ["C:\\Users\\AT&T\\AppData\\Local\\agent-harness", "C:\\Data & (State)^"]) {
      const xml = renderTaskXml({ dataDir, entry: `${dataDir}\\launcher-entry.cmd` }, "D&C\\david");
      expect(xml, dataDir).toContain("<Arguments>--headless cmd.exe /d /c .\\launcher-entry.cmd</Arguments>");
      expect(xml, dataDir).toContain(`<WorkingDirectory>${dataDir.replaceAll("&", "&amp;")}</WorkingDirectory>`);
      expect(xml, dataDir).toContain("<UserId>D&amp;C\\david</UserId>");
    }
  });
});
