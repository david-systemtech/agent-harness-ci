import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderLaunchdPlist } from "./launchd.js";
import { SERVICE_LABEL, type ServiceSpec } from "./spec.js";
import { renderSystemdUnit } from "./systemd.js";
import { renderTaskXml } from "./task-scheduler.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`../../test/fixtures/service/${name}`, import.meta.url), "utf8");

const macSpec: ServiceSpec = {
  program: ["/opt/homebrew/bin/node", "/Users/david/.local/share/agent-harness/0.1.0/dist/main.js"],
  dataDir: "/Users/david/Library/Application Support/agent-harness",
  port: 7433,
};

const linuxSpec: ServiceSpec = {
  program: ["/usr/bin/node", "/home/david/.local/share/agent-harness/0.1.0/dist/main.js"],
  dataDir: "/home/david/.local/state/agent-harness",
  port: 7433,
};

const windowsSpec: ServiceSpec = {
  program: [
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Users\\david\\AppData\\Local\\Programs\\agent-harness\\0.1.0\\dist\\main.js",
  ],
  dataDir: "C:\\Users\\david\\AppData\\Local\\agent-harness",
  port: 7433,
};

describe("the service label", () => {
  it("is the product's placeholder name, the one constant ADR 0017 renames", () => {
    expect(SERVICE_LABEL).toBe("agent-harness");
  });
});

describe("the launchd agent", () => {
  it("renders as the fixture: serve with the data directory and port, at load, kept alive, logging into the data directory", () => {
    expect(renderLaunchdPlist(macSpec)).toBe(fixture("agent-harness.plist"));
  });

  it("escapes XML in every string it writes", () => {
    const plist = renderLaunchdPlist({ ...macSpec, dataDir: "/Users/d&c/<state>" });
    expect(plist).toContain("<string>/Users/d&amp;c/&lt;state&gt;</string>");
    expect(plist).toContain("<string>/Users/d&amp;c/&lt;state&gt;/logs/service.log</string>");
    expect(plist).not.toContain("d&c");
  });
});

describe("the systemd user unit", () => {
  it("renders as the fixture: serve with the data directory and port, restarted on failure, logging into the data directory", () => {
    expect(renderSystemdUnit(linuxSpec)).toBe(fixture("agent-harness.service"));
  });

  it("quotes an argument holding a backslash or a lone semicolon, which systemd would otherwise unescape or split on", () => {
    const unit = renderSystemdUnit({ ...linuxSpec, program: ["/usr/bin/node", "/srv/a\\b/main.js", ";"] });
    expect(unit).toContain('ExecStart=/usr/bin/node "/srv/a\\\\b/main.js" ";" serve');
  });

  it("quotes arguments with spaces or quotes and escapes the specifier and variable characters", () => {
    const unit = renderSystemdUnit({
      ...linuxSpec,
      program: ["/opt/my node/bin/node", '/srv/"q"/main.js'],
      dataDir: "/home/david/100% $HOME\\state",
    });
    const execStart = unit.split("\n").find((line) => line.startsWith("ExecStart="));
    expect(execStart).toBe(
      'ExecStart="/opt/my node/bin/node" "/srv/\\"q\\"/main.js" serve --data-dir "/home/david/100%% $$HOME\\\\state" --port 7433',
    );
    // Only specifiers are expanded in a log path, not variables.
    expect(unit).toContain("StandardOutput=append:/home/david/100%% $HOME\\state/logs/service.log\n");
  });
});

describe("the Task Scheduler logon task", () => {
  it("renders as the fixture: a logon trigger and principal for the user, serve through a headless console, restarted on failure", () => {
    expect(renderTaskXml(windowsSpec, "GAMINGPC\\david")).toBe(fixture("agent-harness-task.xml"));
  });

  it("quotes arguments as the Windows command line parses them and escapes XML", () => {
    const xml = renderTaskXml(
      { ...windowsSpec, program: ["C:\\node.exe", 'C:\\a "b"\\main.js'], dataDir: "C:\\Data & State\\" },
      "D&C\\david",
    );
    expect(xml).toContain(
      '<Arguments>--headless C:\\node.exe "C:\\a \\"b\\"\\main.js" serve --data-dir "C:\\Data &amp; State\\\\" --port 7433</Arguments>',
    );
    expect(xml).toContain("<UserId>D&amp;C\\david</UserId>");
  });
});
