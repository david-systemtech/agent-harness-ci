import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCESS_STREAM_KIND, DATA_DIRECTORY_PRESET_ID, Denylist, denylistPresets } from "@agent-harness/contracts";
import { denylistCall, providerDenylist, readDenylistCall, type DenylistContext } from "./denylist-gate.js";

import { openEventLog } from "../event-log/event-log.js";
import { permissionsProjector } from "./permissions-store.js";
import { readDenylist, seedDenylist } from "./denylist-store.js";

const HOME = String.raw`C:\Users\tester`;
const DATA = win32.join(HOME, "AppData", "Local", "agent-harness");
const context: DenylistContext = {
  denylist: () => Denylist.parse(denylistPresets(DATA)), home: HOME,
  exempt: [win32.join(DATA, "containment")], platform: "win32", resolve: (path) => win32.normalize(path),
};

describe("the denylist on a Windows environment", () => {
  it("commits and reloads Windows presets through the startup permissions projector", () => {
    const log = openEventLog({ path: ":memory:", projectors: [permissionsProjector] });
    try {
      seedDenylist({ log, stream: { kind: ACCESS_STREAM_KIND, id: "environment" }, dataDir: DATA });
      const list = readDenylist({ all: (sql, ...params) => log.read(sql, ...params) });
      expect(list.paths.find((entry) => entry.id === DATA_DIRECTORY_PRESET_ID)?.pattern).toBe(DATA);
      expect(readDenylistCall({ ...context, denylist: () => list }, { paths: [win32.join(DATA, "events.db")] }, HOME).matches.map((match) => match.entry.id)).toEqual([DATA_DIRECTORY_PRESET_ID]);
    } finally {
      log.close();
    }
  });

  it("seeds a native data-directory preset and reads it through the environment matcher with its exemption", () => {
    expect(readDenylistCall(context, { paths: [win32.join(DATA.toUpperCase(), "events.db")] }, HOME).matches.map((match) => match.entry.id)).toEqual([DATA_DIRECTORY_PRESET_ID]);
    expect(readDenylistCall(context, { paths: [win32.join(DATA, "containment", "session", "tmp")] }, HOME).matches).toEqual([]);
  });

  it("reads native paths in other tool inputs", () => {
    const call = denylistCall({ tool: "custom", toolCallId: "call-1", summary: "Read keys", access: { kind: "other" }, input: { file: String.raw`c:\USERS\TESTER\.ssh\id_rsa` } });
    expect(readDenylistCall(context, call, HOME).matches.map((match) => match.entry.id)).toContain("preset:~/.ssh");
  });

  it("projects home-relative patterns with either separator into native provider paths", () => {
    const list = denylistPresets(DATA);
    list.paths.push({ id: "home-backslash", pattern: String.raw`~\.keys`, note: "", preset: false, enabled: true });
    expect(providerDenylist(list, context).paths).toContain(win32.join(HOME, ".ssh"));
    expect(providerDenylist(list, context).paths).toContain(win32.join(HOME, ".keys"));
  });
});
