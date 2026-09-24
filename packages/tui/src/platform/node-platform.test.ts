import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOOTSTRAP_GRANT_FILE } from "@agent-harness/contracts";
import { SHELL_MEMBERS, createRuntime } from "@agent-harness/client-runtime";
import { fakeWire, flush } from "@agent-harness/client-runtime/testing/fake-wire";
import { afterEach, describe, expect, it } from "vitest";
import { FORBIDDEN_WORDS } from "../../../../eslint-rules/no-client-organisation-state.js";
import { clientLabel, nodePlatform, stateDirectory, STATE_DIR_VARIABLE } from "./node-platform.js";

/**
 * The terminal UI's platform for the client runtime (docs/specs/tui.md, "The
 * entry point and the platform"): documents as JSON files under the state
 * directory, secrets in a 0600 file there, Node's WebSocket, the system
 * clock, a network signal that never parks a retry, kind `tui` with the
 * label `<user>@<hostname>:<tty>`, a reader of the local environment's grant
 * file, and no shell.
 */

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-harness-tui-"));
  dirs.push(dir);
  return dir;
};

const identity = { user: "seth", host: "desk", tty: "pts/3" };
const platformIn = (overrides: Partial<Parameters<typeof nodePlatform>[0]> = {}) => {
  const stateDir = join(temp(), "state");
  const dataDir = temp();
  return { stateDir, dataDir, platform: nodePlatform({ stateDir, dataDir, version: "1.2.3", identity, ...overrides }) };
};

const mode = (path: string) => statSync(path).mode & 0o777;

describe("the state directory", () => {
  it.each([
    ["linux", { XDG_STATE_HOME: "/x/state" }, "/x/state/agent-harness/tui"],
    ["linux", {}, "/home/seth/.local/state/agent-harness/tui"],
    ["linux", { XDG_STATE_HOME: "relative/state" }, "/home/seth/.local/state/agent-harness/tui"],
    ["darwin", {}, "/home/seth/Library/Application Support/agent-harness/tui"],
    ["win32", { LOCALAPPDATA: "C:\\Users\\seth\\AppData\\Local" }, "C:\\Users\\seth\\AppData\\Local\\agent-harness\\tui"],
    ["linux", { [STATE_DIR_VARIABLE]: "/elsewhere/tui", XDG_STATE_HOME: "/x/state" }, "/elsewhere/tui"],
  ] as const)("on %s with %j is %s", (platform, env, expected) => {
    expect(stateDirectory({ platform, env, homedir: "/home/seth" })).toBe(expected);
  });

  it("is overridden by AGENT_HARNESS_TUI_STATE_DIR", () => {
    expect(STATE_DIR_VARIABLE).toBe("AGENT_HARNESS_TUI_STATE_DIR");
  });
});

describe("the terminal UI's platform", () => {
  it("is a tui client labelled <user>@<hostname>:<tty>, with the harness version", () => {
    const { platform } = platformIn();
    expect(platform.client).toEqual({ kind: "tui", label: "seth@desk:pts/3", version: "1.2.3" });
    expect(clientLabel({ user: "a", host: "b", tty: "ttys004" })).toBe("a@b:ttys004");
  });

  it("names the process's own user, host and terminal when not told", () => {
    const { platform } = platformIn({ identity: undefined });
    expect(platform.client.label).toMatch(/^[^@\s]+@[^:\s]+:\S+$/);
  });

  it("keeps documents as JSON files under the state directory, and reads back what it wrote", async () => {
    const { platform, stateDir } = platformIn();
    expect(await platform.documents.get("connections.paired")).toBeUndefined();
    await platform.documents.set("connections.paired", { a: [1, "two", null] });
    expect(await platform.documents.get("connections.paired")).toEqual({ a: [1, "two", null] });
    expect(readdirSync(join(stateDir, "documents"))).toEqual(["connections.paired.json"]);
    await platform.documents.delete("connections.paired");
    expect(await platform.documents.get("connections.paired")).toBeUndefined();
    await platform.documents.delete("never.written");
  });

  it("keeps secrets in one file only its owner can read, and never among the documents", async () => {
    const { platform, stateDir } = platformIn();
    await platform.secrets.set("env-1", "token-1");
    await platform.secrets.set("env-2", "token-2");
    expect(await platform.secrets.get("env-1")).toBe("token-1");
    await platform.secrets.delete("env-1");
    expect(await platform.secrets.get("env-1")).toBeUndefined();
    expect(await platform.secrets.get("env-2")).toBe("token-2");
    if (process.platform !== "win32") {
      expect(mode(join(stateDir, "secrets.json"))).toBe(0o600);
      expect(mode(stateDir)).toBe(0o700);
    }
    expect(readdirSync(stateDir).sort()).toEqual(["secrets.json"]);
  });

  it("reads the local environment's grant file from its data directory, and none when there is none", async () => {
    const { platform, dataDir } = platformIn();
    expect(await platform.grant?.read()).toBeUndefined();
    writeFileSync(join(dataDir, BOOTSTRAP_GRANT_FILE), JSON.stringify({ secret: "s", address: { host: "127.0.0.1", port: 7433 } }));
    expect(await platform.grant?.read()).toEqual({ secret: "s", address: { host: "127.0.0.1", port: 7433 } });
    writeFileSync(join(dataDir, BOOTSTRAP_GRANT_FILE), "not json");
    expect(await platform.grant?.read()).toBeUndefined();
  });

  it("tells the time by the system clock, and its timers fire and cancel", async () => {
    const { platform } = platformIn();
    expect(Math.abs(platform.clock.now().getTime() - Date.now())).toBeLessThan(1000);
    const fired: string[] = [];
    platform.clock.setTimeout(() => fired.push("a"), 1);
    platform.clock.setTimeout(() => fired.push("b"), 1).cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fired).toEqual(["a"]);
  });

  it("has a network signal that is online and in the foreground, and never parks a retry", () => {
    const { platform } = platformIn();
    expect(platform.network.read()).toEqual({ online: true, foreground: true });
  });

  it("has no shell: every shell member answers absent with reason no-shell", () => {
    const { platform } = platformIn();
    expect(platform.shell).toBeUndefined();
    const runtime = createRuntime(platform);
    for (const member of SHELL_MEMBERS) {
      expect(runtime.capability("any", member)).toMatchObject({ status: "absent", reason: "no-shell" });
    }
  });

  it("holds only the runtime's documents and the secrets file after pairing: no pins, groups, archive or drafts", async () => {
    const { platform: real, stateDir } = platformIn();
    const clock = real.clock;
    const wire = fakeWire({ clock, name: "laptop" });
    const platform = { ...real, fetch: wire.fetch, webSocket: wire.webSocket };
    const runtime = createRuntime(platform);
    await runtime.start();
    const adding = runtime.connections.add({ link: wire.link });
    await wire.server.accept();
    expect(await adding).toMatchObject({ status: "paired" });
    await runtime.connections.setLastUsed(wire.environmentId);
    await flush();
    await runtime.close();
    const files = (readdirSync(stateDir, { recursive: true }) as string[]).map((f) => f.replaceAll("\\", "/")).sort();
    expect(files).toEqual([
      "documents",
      "documents/connections.paired.json",
      "documents/environments.enabled.json",
      "documents/environments.lastUsed.json",
      "documents/environments.sequence.json",
      "secrets.json",
    ]);
    for (const file of files) for (const word of FORBIDDEN_WORDS) expect(file.toLowerCase()).not.toContain(word);
  });
});
