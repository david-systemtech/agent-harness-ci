import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The hosted smoke of #1724, `scripts/macos-tarball-update-smoke.mjs`: its
 * checks over a data folder and fake discovery answers. The update itself,
 * a launch agent and the keychain run on the hosted macOS runner only.
 */

const script = pathToFileURL(join(import.meta.dirname, "..", "scripts", "macos-tarball-update-smoke.mjs")).href;
const { awaitUnpromptedUpdate, designatedRequirement, keychainEntries } = await import(script) as {
  awaitUnpromptedUpdate: (options: { dataDir: string; version: string; discover: () => Promise<unknown>; pause?: () => Promise<void>; attempts?: number }) => Promise<unknown>;
  designatedRequirement: (file: string, run?: (command: string, args: string[]) => string) => string;
  keychainEntries: (dataDir: string) => number;
};

let dataDir: string;
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));
const freshDataDir = () => (dataDir = mkdtempSync(join(tmpdir(), "tarball-update-smoke-")));

/** Discovery answers in turn, the last repeated; `onLook` runs before each, as the environment moves on between looks. */
const answers = (documents: readonly unknown[], onLook: (look: number) => void = () => {}) => {
  let look = 0;
  return async () => {
    onLook(look);
    return documents[Math.min(look++, documents.length - 1)];
  };
};

describe("the macOS tarball update smoke", () => {
  it("passes once the environment answers as the tarball's version and ready, with no keychain prompt on the way", async () => {
    freshDataDir();
    const ready = { harnessVersion: "0.2.0", readiness: "ready" };
    const discover = answers([undefined, { harnessVersion: "0.0.0-0", readiness: "ready" }, { harnessVersion: "0.2.0", readiness: "starting" }, ready]);
    await expect(awaitUnpromptedUpdate({ dataDir, version: "0.2.0", discover, pause: async () => {} })).resolves.toEqual(ready);
  });

  it("fails at once when a start waits on the keychain, even though the environment would later answer as the version", async () => {
    freshDataDir();
    const discover = answers([undefined, undefined, { harnessVersion: "0.2.0", readiness: "ready" }], (look) => {
      if (look === 1) writeFileSync(join(dataDir, "credential-access.json"), JSON.stringify({ version: "0.2.0", pid: 4242, since: "2026-10-06T16:22:00.000Z", state: "waiting" }));
    });
    await expect(awaitUnpromptedUpdate({ dataDir, version: "0.2.0", discover, pause: async () => {} })).rejects.toThrow(/keychain prompt: .*"state":"waiting".*#1724/);
  });

  it("fails when the environment never answers as the version, as after a rollback", async () => {
    freshDataDir();
    const discover = answers([{ harnessVersion: "0.0.0-0", readiness: "ready" }]);
    await expect(awaitUnpromptedUpdate({ dataDir, version: "0.2.0", discover, pause: async () => {}, attempts: 5 })).rejects.toThrow("did not answer as 0.2.0 and ready after 5 looks");
  });

  it("requires the installed environment to keep its stored key in the keychain, so the update proves something", () => {
    freshDataDir();
    expect(() => keychainEntries(dataDir)).toThrow("keeps no entry in the OS keychain");
    writeFileSync(join(dataDir, "keychain.json"), JSON.stringify({ service: "agent-harness env-test", keys: [] }));
    expect(() => keychainEntries(dataDir)).toThrow("keeps no entry in the OS keychain");
    writeFileSync(join(dataDir, "keychain.json"), JSON.stringify({ service: "agent-harness env-test", keys: ["signing-key"] }));
    expect(keychainEntries(dataDir)).toBe(1);
  });

  it("reads the designated requirement codesign prints, and refuses output that names none", () => {
    freshDataDir();
    const calls: string[][] = [];
    const signed = 'designated => identifier node and anchor apple generic and certificate leaf[subject.OU] = "TEAMTEST01"';
    expect(designatedRequirement("/fixture/node", (command, args) => { calls.push([command, ...args]); return `Executable=/fixture/node\n${signed}\n`; }))
      .toBe('identifier node and anchor apple generic and certificate leaf[subject.OU] = "TEAMTEST01"');
    expect(calls).toEqual([["codesign", "-d", "-r-", "/fixture/node"]]);
    expect(() => designatedRequirement("/fixture/node", () => "Executable=/fixture/node\n")).toThrow("codesign names no designated requirement for /fixture/node");
  });
});
