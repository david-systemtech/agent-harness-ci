import { closeSync, fsyncSync, linkSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DurableFs } from "./durable.js";
import { readServiceState, SERVICE_STATE_FILE, writeServiceState, type ServiceState } from "./state.js";

/**
 * The service state (launcher-update spec, "Versions and the launcher"): the
 * active, previous and launcher versions, the pending-update record and the
 * watch deadline, in one file in the data directory that the launcher reads
 * before it starts anything and writes durably.
 */

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const dataDirectory = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agent-harness-state-"));
  dirs.push(dir);
  return dir;
};

const state: ServiceState = {
  activeVersion: "0.5.0",
  previousVersion: "0.4.2",
  launcherVersion: "0.4.2",
  pendingUpdate: null,
  watchDeadline: "2026-09-28T12:10:00.000Z",
};

/** The node file calls a write makes, each recorded with the file it was about, named `temp`, `state` or `directory`. */
const recordingFs = (dataDir: string): { readonly fs: DurableFs; readonly calls: string[] } => {
  const calls: string[] = [];
  const opened = new Map<number, string>();
  const name = (path: string): string => {
    if (path === dataDir) return "directory";
    if (path === join(dataDir, SERVICE_STATE_FILE)) return "state";
    return path.startsWith(dataDir) ? "temp" : path;
  };
  const fs: DurableFs = {
    openSync: (path, flags, mode) => {
      const fd = openSync(path, flags, mode);
      opened.set(fd, name(path));
      calls.push(`open ${name(path)} ${flags}`);
      return fd;
    },
    writeFileSync: (fd, text) => {
      calls.push(`write ${opened.get(fd)}`);
      writeFileSync(fd, text);
    },
    fsyncSync: (fd) => {
      calls.push(`fsync ${opened.get(fd)}`);
      fsyncSync(fd);
    },
    closeSync: (fd) => {
      calls.push(`close ${opened.get(fd)}`);
      closeSync(fd);
    },
    renameSync: (from, to) => {
      calls.push(`rename ${name(from)} to ${name(to)}`);
      renameSync(from, to);
    },
    linkSync: (existing, path) => {
      calls.push(`link ${name(existing)} as ${name(path)}`);
      linkSync(existing, path);
    },
    rmSync: (path, options) => {
      calls.push(`remove ${name(path)}`);
      rmSync(path, options);
    },
  };
  return { fs, calls };
};

describe("the service state", () => {
  it("holds the active, previous and launcher versions, the pending-update record and the watch deadline, and reads back as written", () => {
    const dataDir = dataDirectory();
    const pending: ServiceState = {
      ...state,
      pendingUpdate: { updateId: "7d0f2b1e-2c55-4a8e-9f0b-3a1c5d7e9b20", fromVersion: "0.5.0", toVersion: "0.6.0" },
      watchDeadline: null,
    };
    writeServiceState(dataDir, pending);
    expect(JSON.parse(readFileSync(join(dataDir, SERVICE_STATE_FILE), "utf8"))).toEqual({
      activeVersion: "0.5.0",
      previousVersion: "0.4.2",
      launcherVersion: "0.4.2",
      pendingUpdate: { updateId: "7d0f2b1e-2c55-4a8e-9f0b-3a1c5d7e9b20", fromVersion: "0.5.0", toVersion: "0.6.0" },
      watchDeadline: null,
    });
    expect(readServiceState(dataDir)).toEqual({ state: pending });
  });

  it("is written to a temporary file, fsynced, renamed over the state, and the directory fsynced, in that order", () => {
    const dataDir = dataDirectory();
    writeServiceState(dataDir, { ...state, activeVersion: "0.4.2" });
    const { fs, calls } = recordingFs(dataDir);
    writeServiceState(dataDir, state, fs);
    expect(calls).toEqual([
      "open temp wx",
      "write temp",
      "fsync temp",
      "close temp",
      "rename temp to state",
      "open directory r",
      "fsync directory",
      "close directory",
    ]);
    expect(readServiceState(dataDir)).toEqual({ state });
    expect(readdirSync(dataDir)).toEqual([SERVICE_STATE_FILE]);
  });

  it("keeps the state it had, and leaves no temporary file, when the write fails before the rename", () => {
    const dataDir = dataDirectory();
    writeServiceState(dataDir, state);
    const { fs, calls } = recordingFs(dataDir);
    const failing: DurableFs = {
      ...fs,
      renameSync: () => {
        throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      },
    };
    expect(() => writeServiceState(dataDir, { ...state, activeVersion: "0.6.0" }, failing)).toThrow("no space left on device");
    expect(calls.at(-1)).toBe("remove temp");
    expect(readServiceState(dataDir)).toEqual({ state });
    expect(readdirSync(dataDir)).toEqual([SERVICE_STATE_FILE]);
  });

  it("is missing when no file is there, and says where it looked", () => {
    const dataDir = dataDirectory();
    expect(readServiceState(dataDir)).toEqual({ problem: `there is no service state at ${join(dataDir, SERVICE_STATE_FILE)}` });
  });

  it("is unreadable when the file cannot be read, and says why", () => {
    const dataDir = dataDirectory();
    mkdirSync(join(dataDir, SERVICE_STATE_FILE));
    expect(readServiceState(dataDir)).toEqual({
      problem: expect.stringMatching(new RegExp(`^the service state at .*${SERVICE_STATE_FILE} could not be read: .*EISDIR`)),
    });
  });

  it("is invalid when it is not JSON, and says so", () => {
    const dataDir = dataDirectory();
    writeFileSync(join(dataDir, SERVICE_STATE_FILE), '{"activeVersion": "0.5.0",');
    expect(readServiceState(dataDir)).toEqual({
      problem: `the service state at ${join(dataDir, SERVICE_STATE_FILE)} is not valid: it is not JSON`,
    });
  });

  it("is invalid when a part is missing or wrong, and names the part", () => {
    const dataDir = dataDirectory();
    const invalid: [Record<string, unknown>, string][] = [
      [{ ...state, activeVersion: undefined }, "activeVersion is not a version"],
      [{ ...state, activeVersion: "../0.5.0" }, "activeVersion is not a version"],
      [{ ...state, activeVersion: "v0.5.0" }, "activeVersion is not a version"],
      [{ ...state, previousVersion: undefined }, "previousVersion is neither a version nor null"],
      [{ ...state, previousVersion: "" }, "previousVersion is neither a version nor null"],
      [{ ...state, launcherVersion: 4 }, "launcherVersion is not a version"],
      [{ ...state, pendingUpdate: undefined }, "pendingUpdate is neither a pending-update record nor null"],
      [{ ...state, pendingUpdate: { updateId: "", fromVersion: "0.5.0", toVersion: "0.6.0" } }, "pendingUpdate is neither a pending-update record nor null"],
      // The launcher names the update's snapshot folder by its id, so nothing but an update id is one.
      [{ ...state, pendingUpdate: { updateId: "../versions", fromVersion: "0.5.0", toVersion: "0.6.0" } }, "pendingUpdate is neither a pending-update record nor null"],
      [{ ...state, pendingUpdate: { updateId: "u", fromVersion: "0.5.0" } }, "pendingUpdate is neither a pending-update record nor null"],
      [{ ...state, watchDeadline: "soon" }, "watchDeadline is neither a time nor null"],
      [{ ...state, watchDeadline: undefined }, "watchDeadline is neither a time nor null"],
    ];
    for (const [contents, why] of invalid) {
      writeFileSync(join(dataDir, SERVICE_STATE_FILE), JSON.stringify(contents));
      expect(readServiceState(dataDir), why).toEqual({ problem: `the service state at ${join(dataDir, SERVICE_STATE_FILE)} is not valid: ${why}` });
    }
    for (const contents of [[], "0.5.0", null]) {
      writeFileSync(join(dataDir, SERVICE_STATE_FILE), JSON.stringify(contents));
      expect(readServiceState(dataDir)).toEqual({
        problem: `the service state at ${join(dataDir, SERVICE_STATE_FILE)} is not valid: it is not an object`,
      });
    }
  });

  it("reads past a part it does not know, which a later launcher may add", () => {
    const dataDir = dataDirectory();
    writeFileSync(join(dataDir, SERVICE_STATE_FILE), JSON.stringify({ ...state, handover: { failed: true } }));
    expect(readServiceState(dataDir)).toEqual({ state });
  });
});
