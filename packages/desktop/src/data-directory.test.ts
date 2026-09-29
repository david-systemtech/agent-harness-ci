import { describe, expect, it } from "vitest";
import { desktopDataDirectory, environmentDataDirectory } from "./data-directory.js";

describe("the desktop's data directory", () => {
  it("is agent-harness/desktop under LocalAppData on Windows, beside the environment's own", () => {
    expect(desktopDataDirectory({ os: "win32", env: { LOCALAPPDATA: "C:\\Users\\seth\\AppData\\Local" }, homedir: "C:\\Users\\seth" })).toBe(
      "C:\\Users\\seth\\AppData\\Local\\agent-harness\\desktop",
    );
    expect(desktopDataDirectory({ os: "win32", env: {}, homedir: "C:\\Users\\seth" })).toBe("C:\\Users\\seth\\AppData\\Local\\agent-harness\\desktop");
  });

  it("is agent-harness/desktop under Application Support on macOS, never the environment's directory itself", () => {
    expect(desktopDataDirectory({ os: "darwin", env: {}, homedir: "/Users/seth" })).toBe("/Users/seth/Library/Application Support/agent-harness/desktop");
  });

  it("is agent-harness/desktop under XDG state on Linux, an absolute XDG_STATE_HOME taken and a relative one ignored", () => {
    expect(desktopDataDirectory({ os: "linux", env: {}, homedir: "/home/seth" })).toBe("/home/seth/.local/state/agent-harness/desktop");
    expect(desktopDataDirectory({ os: "linux", env: { XDG_STATE_HOME: "/var/state/seth" }, homedir: "/home/seth" })).toBe("/var/state/seth/agent-harness/desktop");
    expect(desktopDataDirectory({ os: "linux", env: { XDG_STATE_HOME: "state" }, homedir: "/home/seth" })).toBe("/home/seth/.local/state/agent-harness/desktop");
  });

  it("is the folder the environment's own data directory holds, where its grant file is", () => {
    for (const context of [
      { os: "win32", env: { LOCALAPPDATA: "C:\\Users\\seth\\AppData\\Local" }, homedir: "C:\\Users\\seth" },
      { os: "darwin", env: {}, homedir: "/Users/seth" },
      { os: "linux", env: { XDG_STATE_HOME: "/var/state/seth" }, homedir: "/home/seth" },
    ] as const) {
      expect(desktopDataDirectory(context).slice(0, -"desktop".length - 1)).toBe(environmentDataDirectory(context));
    }
    expect(environmentDataDirectory({ os: "linux", env: {}, homedir: "/home/seth" })).toBe("/home/seth/.local/state/agent-harness");
  });
});
