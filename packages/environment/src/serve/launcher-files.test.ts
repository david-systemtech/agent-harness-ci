import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { OutcomeRecord } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment } from "../../test/helper.js";
import { deleteOutcomeRecord, readOutcomeRecord, stagingArea } from "./launcher-files.js";

/**
 * The files the environment shares with its launcher in the data directory:
 * it writes only the staging area, and reads and deletes only the outcome
 * record the launcher writes.
 */

const { tempDir } = useCleanups();

const record: OutcomeRecord = {
  updateId: "7d0f2b1e-2c55-4a8e-9f0b-3a1c5d7e9b20",
  fromVersion: "0.4.0",
  toVersion: "0.5.0",
  stage: "trial",
  reason: "deadline",
};

/** Every file under `dir` with its contents, by path relative to it. */
const contents = (dir: string): Record<string, string> => {
  const found: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else found[relative(dir, path)] = readFileSync(path, "utf8");
    }
  };
  walk(dir);
  return found;
};

/** A data directory as a launcher leaves it after rolling an update back: its own files, a staged version and the outcome record. */
const launcherLeft = (): string => {
  const dataDir = join(tempDir(), "data");
  mkdirSync(join(dataDir, "versions", "0.4.0"), { recursive: true });
  writeFileSync(join(dataDir, "versions", "0.4.0", "complete"), "0.4.0\n");
  writeFileSync(join(dataDir, "launcher-state.json"), JSON.stringify({ active: "0.4.0", previous: "0.3.0" }));
  mkdirSync(join(stagingArea(dataDir), "0.5.0"), { recursive: true });
  writeFileSync(join(stagingArea(dataDir), "0.5.0", "agent-harness"), "#!/bin/sh\n");
  writeFileSync(join(dataDir, "update-outcome.json"), JSON.stringify(record));
  return dataDir;
};

describe("the files the environment shares with the launcher", () => {
  it("put the staging area in the data directory", () => {
    expect(stagingArea("/home/david/.local/state/agent-harness")).toBe(join("/home/david/.local/state/agent-harness", "staging"));
  });

  it("read the outcome record the launcher wrote, and delete that file alone", () => {
    const dataDir = launcherLeft();
    const before = contents(dataDir);
    expect(readOutcomeRecord(dataDir)).toEqual(record);

    deleteOutcomeRecord(dataDir);
    const rest = { ...before };
    delete rest["update-outcome.json"];
    expect(contents(dataDir)).toEqual(rest);
    expect(readOutcomeRecord(dataDir)).toBeUndefined();
    expect(() => deleteOutcomeRecord(dataDir)).not.toThrow();
  });

  it("refuse an outcome record that is not one, naming it, and leave it in place", () => {
    const dataDir = launcherLeft();
    for (const written of ["{", JSON.stringify({ ...record, stage: "switch" }), JSON.stringify([record])]) {
      writeFileSync(join(dataDir, "update-outcome.json"), written);
      expect(() => readOutcomeRecord(dataDir), written).toThrow(/outcome record/);
      expect(readFileSync(join(dataDir, "update-outcome.json"), "utf8")).toBe(written);
    }
  });

  it("are left as they were by an environment that starts and closes on the data directory", async () => {
    const dataDir = launcherLeft();
    const before = contents(dataDir);
    const t = await startTestEnvironment({ dataDir });
    await t.close();
    const after = contents(dataDir);
    for (const [path, content] of Object.entries(before)) expect(after[path], path).toBe(content);
  });
});
