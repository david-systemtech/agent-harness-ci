import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { defaultDataDirectory, prepareDataDirectory } from "./data-directory.js";

const posix = process.platform !== "win32";

const { tempDir } = useCleanups();

describe("the default data directory", () => {
  it("is under XDG state on Linux", () => {
    expect(defaultDataDirectory({ platform: "linux", env: { XDG_STATE_HOME: "/srv/state" }, homedir: "/home/d" })).toBe(
      "/srv/state/agent-harness",
    );
  });

  it("falls back to ~/.local/state on Linux when XDG_STATE_HOME is unset, empty or relative", () => {
    for (const env of [{}, { XDG_STATE_HOME: "" }, { XDG_STATE_HOME: "state" }]) {
      expect(defaultDataDirectory({ platform: "linux", env, homedir: "/home/d" })).toBe(
        "/home/d/.local/state/agent-harness",
      );
    }
  });

  it("follows XDG on the other Unix platforms too", () => {
    expect(defaultDataDirectory({ platform: "freebsd", env: {}, homedir: "/home/d" })).toBe(
      "/home/d/.local/state/agent-harness",
    );
  });

  it("is under Application Support on macOS, whatever XDG says", () => {
    expect(defaultDataDirectory({ platform: "darwin", env: { XDG_STATE_HOME: "/x" }, homedir: "/Users/d" })).toBe(
      "/Users/d/Library/Application Support/agent-harness",
    );
  });

  it("is under LocalAppData on Windows, or its usual place when the variable is missing", () => {
    expect(
      defaultDataDirectory({ platform: "win32", env: { LOCALAPPDATA: "D:\\Local" }, homedir: "C:\\Users\\d" }),
    ).toBe("D:\\Local\\agent-harness");
    expect(defaultDataDirectory({ platform: "win32", env: {}, homedir: "C:\\Users\\d" })).toBe(
      "C:\\Users\\d\\AppData\\Local\\agent-harness",
    );
  });
});

describe.runIf(posix)("preparing the data directory", () => {
  it("creates it, and any missing parent, readable by its owner alone", () => {
    const dir = join(tempDir(), "state", "agent-harness");
    prepareDataDirectory(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("tightens a directory that already exists with looser permissions", () => {
    const dir = join(tempDir(), "second");
    mkdirSync(dir, { mode: 0o755 });
    prepareDataDirectory(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});
