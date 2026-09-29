import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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
const spawnNode = promisify(execFile);
/** How many secrets each of two processes sets at once. */
const KEYS = 300;

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

  it("keeps each secret in a file of its own only its owner can read, and never among the documents", async () => {
    const { platform, stateDir } = platformIn();
    await platform.secrets.set("env-1", "token-1");
    await platform.secrets.set("env-2", "token-2");
    expect(await platform.secrets.get("env-1")).toBe("token-1");
    await platform.secrets.delete("env-1");
    expect(await platform.secrets.get("env-1")).toBeUndefined();
    expect(await platform.secrets.get("env-2")).toBe("token-2");
    await platform.secrets.delete("never-set");
    if (process.platform !== "win32") {
      expect(mode(join(stateDir, "secrets"))).toBe(0o700);
      expect(mode(join(stateDir, "secrets", "env-2.secret"))).toBe(0o600);
      expect(mode(stateDir)).toBe(0o700);
    }
    expect(readdirSync(stateDir, { recursive: true }).map(String).sort()).toEqual(["secrets", join("secrets", "env-2.secret")]);
  });

  it("never loses one terminal UI's secret to another's on the same state directory: a set or delete of one key rewrites no other", async () => {
    const { stateDir, dataDir } = platformIn();
    const one = nodePlatform({ stateDir, dataDir, version: "1.2.3", identity });
    const two = nodePlatform({ stateDir, dataDir, version: "1.2.3", identity: { ...identity, tty: "pts/4" } });
    await Promise.all([one.secrets.set("env-1", "token-1"), two.secrets.set("env-2", "token-2")]);
    expect(await one.secrets.get("env-2")).toBe("token-2");
    expect(await two.secrets.get("env-1")).toBe("token-1");
    await two.secrets.delete("env-2");
    expect(await one.secrets.get("env-1")).toBe("token-1");
    expect(await one.secrets.get("env-2")).toBeUndefined();
  });

  it("keeps every secret two terminal UI processes set at once on one state directory", async () => {
    const { stateDir } = platformIn();
    const script = join(temp(), "set-secrets.mts");
    writeFileSync(
      script,
      [
        `import { nodePlatform } from ${JSON.stringify(join(import.meta.dirname, "node-platform.ts"))};`,
        `const KEYS = ${KEYS};`,
        "const [stateDir, prefix, at] = process.argv.slice(2);",
        'const platform = nodePlatform({ stateDir, dataDir: stateDir, version: "0", identity: { user: "u", host: "h", tty: prefix } });',
        // Both processes start setting at the same instant, so their writes overlap.
        "await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(at) - Date.now())));",
        "for (let i = 0; i < KEYS; i++) await platform.secrets.set(`${prefix}-${i}`, `token-${prefix}-${i}`);",
      ].join("\n"),
    );
    const tsx = createRequire(import.meta.url).resolve("tsx");
    const at = String(Date.now() + 3000);
    const run = (prefix: string) => spawnNode(process.execPath, ["--conditions=@agent-harness/source", "--import", tsx, script, stateDir, prefix, at]);
    await Promise.all([run("a"), run("b")]);
    const reader = nodePlatform({ stateDir, dataDir: stateDir, version: "0", identity });
    for (const prefix of ["a", "b"]) {
      for (let i = 0; i < KEYS; i++) expect(await reader.secrets.get(`${prefix}-${i}`), `${prefix}-${i}`).toBe(`token-${prefix}-${i}`);
    }
  });

  it("moves the secrets of an earlier build's one secrets.json into files of their own on first use, keeping every token", async () => {
    const { stateDir, dataDir } = platformIn();
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "secrets.json"), JSON.stringify({ "env-1": "token-1", "env-2": "token-2" }), { mode: 0o600 });
    const platform = nodePlatform({ stateDir, dataDir, version: "1.2.3", identity });
    await platform.secrets.set("env-3", "token-3");
    expect(await platform.secrets.get("env-1")).toBe("token-1");
    expect(await platform.secrets.get("env-2")).toBe("token-2");
    expect(await platform.secrets.get("env-3")).toBe("token-3");
    expect(readdirSync(stateDir).sort()).toEqual(["secrets"]);
    expect(readdirSync(join(stateDir, "secrets")).sort()).toEqual(["env-1.secret", "env-2.secret", "env-3.secret"]);
  });

  it.each([["not JSON", "{ env-1: token-1"], ["not an object", '["token-1"]']])(
    "keeps an earlier build's secrets.json it cannot read (%s) aside, unreadable, and says so once",
    async (_what, text) => {
      const reported: unknown[] = [];
      const { stateDir, dataDir } = platformIn();
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, "secrets.json"), text, { mode: 0o600 });
      const platform = nodePlatform({ stateDir, dataDir, version: "1.2.3", identity, reportError: (error) => reported.push(error) });
      expect(await platform.secrets.get("env-1")).toBeUndefined();
      await platform.secrets.set("env-3", "token-3");
      expect(await platform.secrets.get("env-3")).toBe("token-3");
      expect(readdirSync(stateDir).sort()).toEqual(["secrets", "secrets.json.unreadable"]);
      expect(readFileSync(join(stateDir, "secrets.json.unreadable"), "utf8")).toBe(text);
      expect(reported).toHaveLength(1);
      expect(String(reported[0])).toContain("secrets.json.unreadable");
    },
  );

  it("moves an earlier secrets.json's tokens but keeps the file aside, and says so, when an entry is not a token", async () => {
    const reported: unknown[] = [];
    const { stateDir, dataDir } = platformIn();
    mkdirSync(stateDir, { recursive: true });
    const text = JSON.stringify({ "env-1": "token-1", "env-2": { token: "token-2" } });
    writeFileSync(join(stateDir, "secrets.json"), text, { mode: 0o600 });
    const platform = nodePlatform({ stateDir, dataDir, version: "1.2.3", identity, reportError: (error) => reported.push(error) });
    expect(await platform.secrets.get("env-1")).toBe("token-1");
    expect(await platform.secrets.get("env-2")).toBeUndefined();
    expect(readdirSync(stateDir).sort()).toEqual(["secrets", "secrets.json.unreadable"]);
    expect(readFileSync(join(stateDir, "secrets.json.unreadable"), "utf8")).toBe(text);
    expect(reported).toHaveLength(1);
    expect(String(reported[0])).toContain("env-2");
  });

  it("reads the local environment's grant file from its data directory, and none when there is none", async () => {
    const { platform, dataDir } = platformIn();
    expect(await platform.grant?.read()).toBeUndefined();
    writeFileSync(join(dataDir, BOOTSTRAP_GRANT_FILE), JSON.stringify({ secret: "s", address: { host: "127.0.0.1", port: 7433 } }));
    expect(await platform.grant?.read()).toEqual({ secret: "s", address: { host: "127.0.0.1", port: 7433 } });
    writeFileSync(join(dataDir, BOOTSTRAP_GRANT_FILE), "not json");
    expect(await platform.grant?.read()).toBeUndefined();
  });

  it("reads no grant, and says why once, when the grant file cannot be read", async () => {
    const reported: unknown[] = [];
    const { stateDir, dataDir } = platformIn();
    mkdirSync(join(dataDir, BOOTSTRAP_GRANT_FILE));
    const platform = nodePlatform({ stateDir, dataDir, version: "1.2.3", identity, reportError: (error) => reported.push(error) });
    expect(await platform.grant?.read()).toBeUndefined();
    expect(await platform.grant?.read()).toBeUndefined();
    expect(reported).toHaveLength(1);
    expect(String(reported[0])).toContain(BOOTSTRAP_GRANT_FILE);
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

  it("holds only the runtime's documents and the secrets after pairing: no pins, groups, archive or drafts", async () => {
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
      // The directories hidden from the picker: the runtime's one presentation preference (#332).
      "documents/hiddenDirectories.json",
      // The session list's cache and cursor (#127): the runtime's, never the terminal UI's.
      `documents/streams.${wire.environmentId}.meta.json`,
      "secrets",
      `secrets/${wire.environmentId}.secret`,
    ]);
    for (const file of files) for (const word of FORBIDDEN_WORDS) expect(file.toLowerCase()).not.toContain(word);
  });
});
