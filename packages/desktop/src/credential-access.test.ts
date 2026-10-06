import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CREDENTIAL_ACCESS_FILE } from "@agent-harness/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { cleanUp, platformOn, start } from "../test/harness.js";

afterEach(cleanUp);

/**
 * The shell's `credentialAccess` (#1689): the record this machine's
 * environment writes in its data directory while its start waits on the
 * person to let it read its stored key, read for the window, which says what
 * an update waits on while the environment cannot. Whether the start that
 * wrote it still runs tells a wait under way from one that ended unanswered.
 */

const WAITING = { version: "0.1.3", pid: process.pid, since: "2026-10-06T10:34:01.000Z", state: "waiting" } as const;

/** A process id no process holds: one that just exited. */
const goneProcess = (): number => {
  const ran = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(ran.stdout);
};

describe("credentialAccess", () => {
  it("reads the record in this machine's environment's data directory, live while its process runs", async () => {
    const platform = platformOn("darwin");
    writeFileSync(join(platform.paths.environment, CREDENTIAL_ACCESS_FILE), JSON.stringify(WAITING));
    const { shell } = await start({ platform });
    expect(await shell().credentialAccess.read()).toEqual({ ...WAITING, live: true });
  });

  it("reads a record whose process has gone as not live: the launcher ended the start that waited", async () => {
    const platform = platformOn("darwin");
    const pid = goneProcess();
    writeFileSync(join(platform.paths.environment, CREDENTIAL_ACCESS_FILE), JSON.stringify({ ...WAITING, pid, state: "refused" }));
    const { shell } = await start({ platform });
    expect(await shell().credentialAccess.read()).toEqual({ ...WAITING, pid, state: "refused", live: false });
  });

  it("answers none while there is no record, and for a file no environment wrote", async () => {
    const platform = platformOn("darwin");
    const { shell } = await start({ platform });
    expect(await shell().credentialAccess.read()).toBeUndefined();
    for (const text of ["{", "null", JSON.stringify({ ...WAITING, state: "asked" }), JSON.stringify({ ...WAITING, pid: -1 })]) {
      writeFileSync(join(platform.paths.environment, CREDENTIAL_ACCESS_FILE), text);
      expect(await shell().credentialAccess.read()).toBeUndefined();
    }
  });
});
