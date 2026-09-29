import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DATABASE_FILE, OUTCOME_RECORD_FILE, type OutcomeRecord } from "@agent-harness/contracts/launcher";
import { HARNESS_VERSION } from "@agent-harness/environment";
import { afterEach, describe, expect, it } from "vitest";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../environment/test/helper.js";
import { startFakeReleaseSource } from "../../environment/test/release-source.js";
import { databaseFilesIn, readDatabase, writeDatabase } from "../test/launcher-fixtures.js";
import { runCli, type CliContext } from "./cli.js";
import { RESTORE_MARKER_FILE, snapshotDirectory, takeSnapshot } from "./launch/snapshot.js";

/**
 * The `update` verbs the host-side updater runs on a stopped container's
 * volume (launcher-update spec, "Containers: the host-side updater"; #349):
 * `update snapshot`, `update restore` and `update discard`, against a
 * temporary data directory holding a real SQLite database in WAL mode, with
 * no environment running unless a test starts one to hold the database.
 */

let cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

/** A data directory of its own, in a folder of its own that the test may look at around it. */
const dataDirectory = (): string => {
  const parent = mkdtempSync(join(tmpdir(), "agent-harness-update-snapshot-"));
  cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
  const dataDir = join(parent, "data");
  mkdirSync(dataDir);
  return dataDir;
};

/** A network the verbs must not use: no environment is asked anything. */
const NO_NET = {
  fetch: () => Promise.reject(new Error("The verb reached for the network.")),
  WebSocket: class {
    constructor() {
      throw new Error("The verb opened a WebSocket.");
    }
  } as unknown as typeof WebSocket,
};

const run = async (args: readonly string[]) => {
  let out = "";
  let err = "";
  const context: Partial<CliContext> = { stdout: (text) => void (out += text), stderr: (text) => void (err += text), net: NO_NET };
  const code = await runCli(["update", ...args], context);
  return { code, out, err };
};

const updateId = "7d0f2b1e-2c55-4a8e-9f0b-3a1c5d7e9b20";

/**
 * What each test here may take: most write or read the database from Node
 * processes of their own, as a crashed or a stopped version leaves it, and
 * one process took up to 20 s on a loaded runner (#634), past the 30 s a test
 * gets by default once there are three of them. A test that answers wrongly
 * fails at once; only one that hangs uses this up.
 */
const SPAWNS = { timeout: 120_000 };

/** An environment running on `dataDir`, in this process, closed after the test unless the test closes it first. */
const startOn = async (dataDir: string, options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ dataDir, ...options });
  cleanups.push(() => t.close());
  return t;
};

/**
 * Another process holding the database in `dataDir` open, as an environment
 * in another container on the same volume does: it opens it, reads it, says
 * so and waits to be ended, which the test's cleanup does.
 */
const holdInAnotherProcess = async (dataDir: string): Promise<void> => {
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    db.prepare("SELECT count(*) FROM sqlite_master").get();
    process.stdout.write("open\\n");
    setInterval(() => undefined, 60_000);
  `;
  const holder = spawn(process.execPath, ["--no-warnings", "-e", script, join(dataDir, DATABASE_FILE)], { stdio: ["ignore", "pipe", "inherit"] });
  const ended = new Promise<void>((resolve) => holder.once("exit", () => resolve()));
  cleanups.push(async () => {
    holder.kill("SIGKILL");
    await ended;
  });
  await new Promise<void>((resolve, reject) => {
    holder.stdout.once("data", () => resolve());
    holder.once("exit", (code) => reject(new Error(`The holding process exited with ${code} before it held the database.`)));
  });
};

describe("agent-harness update snapshot", SPAWNS, () => {
  it("snapshots the database's main, WAL and shm files as the old version left them, once per update id", async () => {
    const dataDir = dataDirectory();
    // The old version stopped with its WAL not yet checkpointed, as a container's stop can leave it.
    writeDatabase(dataDir, ["before the update"], "open");
    const left = databaseFilesIn(dataDir);
    expect(Object.keys(left)).toEqual(["environment.db", "environment.db-wal", "environment.db-shm"]);

    const first = await run(["snapshot", "--update-id", updateId, "--data-dir", dataDir]);

    expect(first.err).toBe("");
    expect(first.code).toBe(0);
    expect(first.out).toBe(`Took the snapshot of update ${updateId}'s database, in ${snapshotDirectory(dataDir, updateId)}.\n`);
    expect(databaseFilesIn(snapshotDirectory(dataDir, updateId))).toEqual(left);

    writeDatabase(dataDir, ["written since"], "closed");
    const second = await run(["snapshot", "--update-id", updateId, "--data-dir", dataDir]);

    expect(second.code).toBe(0);
    expect(second.out).toBe(`Kept the snapshot of update ${updateId} taken before, in ${snapshotDirectory(dataDir, updateId)}: an update's database is snapshotted once.\n`);
    expect(databaseFilesIn(snapshotDirectory(dataDir, updateId))).toEqual(left);
  });

  it("is refused while an environment holds the database, and takes nothing", async () => {
    const dataDir = dataDirectory();
    await startOn(dataDir);

    const { code, out, err } = await run(["snapshot", "--update-id", updateId, "--data-dir", dataDir]);

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe(`An environment holds the database in ${dataDir}: stop it before the snapshot is taken.\n`);
    expect(existsSync(join(dataDir, "snapshots"))).toBe(false);
  });

  it("is refused while another process holds the database, as an environment in another container on the same volume does", async () => {
    const dataDir = dataDirectory();
    writeDatabase(dataDir, ["before the update"], "closed");
    await holdInAnotherProcess(dataDir);

    const { code, err } = await run(["snapshot", "--update-id", updateId, "--data-dir", dataDir]);

    expect(code).toBe(1);
    expect(err).toBe(`An environment holds the database in ${dataDir}: stop it before the snapshot is taken.\n`);
    expect(existsSync(join(dataDir, "snapshots"))).toBe(false);
  });

  it("is refused while a restore is marked and not finished, since the database is then part copied back", async () => {
    const dataDir = dataDirectory();
    writeDatabase(dataDir, ["half restored"], "closed");
    const marked: OutcomeRecord = { updateId: "0b5c4f8e-9a51-4d2c-8e3f-6a7b8c9d0e1f", fromVersion: "0.4.1", toVersion: "0.5.0", stage: "trial", reason: "health" };
    writeFileSync(join(dataDir, RESTORE_MARKER_FILE), JSON.stringify(marked));

    const { code, err } = await run(["snapshot", "--update-id", updateId, "--data-dir", dataDir]);

    expect(code).toBe(1);
    expect(err).toBe(`A restore of update ${marked.updateId} is marked and not finished: finish it with update restore before a snapshot is taken.\n`);
    expect(existsSync(join(dataDir, "snapshots"))).toBe(false);
  });

  it("is refused with no database in the data directory, since restoring an empty snapshot would remove the database", async () => {
    const dataDir = dataDirectory();

    const { code, err } = await run(["snapshot", "--update-id", updateId, "--data-dir", dataDir]);

    expect(code).toBe(1);
    expect(err).toBe(`There is no database in ${dataDir} to snapshot.\n`);
    expect(existsSync(join(dataDir, "snapshots"))).toBe(false);
  });
});

/** The outcome record in `dataDir`, or undefined when there is none. */
const outcomeRecordIn = (dataDir: string): unknown =>
  existsSync(join(dataDir, OUTCOME_RECORD_FILE)) ? JSON.parse(readFileSync(join(dataDir, OUTCOME_RECORD_FILE), "utf8")) : undefined;

/** A data directory whose database held `before` when update `updateId` was snapshotted, and `after` once its target had run. */
const snapshottedThenWritten = async (before: readonly string[], after: readonly string[]): Promise<string> => {
  const dataDir = dataDirectory();
  writeDatabase(dataDir, before, "closed");
  expect((await run(["snapshot", "--update-id", updateId, "--data-dir", dataDir])).code).toBe(0);
  // The target ran, wrote, and was stopped mid-write, as a crash loop leaves it.
  writeDatabase(dataDir, after, "open");
  return dataDir;
};

describe("agent-harness update restore", SPAWNS, () => {
  it("restores the update's snapshot, writes the outcome record with the stage and reason given, and leaves no restore marker", async () => {
    const dataDir = await snapshottedThenWritten(["before the update"], ["written by the target"]);

    const { code, out, err } = await run(["restore", "--update-id", updateId, "--stage", "crash-loop", "--reason", "restarts", "--to-version", "0.5.0", "--data-dir", dataDir]);

    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toBe(
      `Restored the snapshot of update ${updateId} over the database in ${dataDir} and wrote its outcome record (crash-loop: restarts): the version it went from reports the failure at its next start.\n`,
    );
    expect(readDatabase(dataDir)).toEqual(["before the update"]);
    const written: OutcomeRecord = { updateId, fromVersion: HARNESS_VERSION, toVersion: "0.5.0", stage: "crash-loop", reason: "restarts" };
    expect(outcomeRecordIn(dataDir)).toEqual(written);
    expect(existsSync(join(dataDir, RESTORE_MARKER_FILE))).toBe(false);
    // The snapshot stays, for the updater's discard.
    expect(existsSync(snapshotDirectory(dataDir, updateId))).toBe(true);
  });

  it("finishes a restore that was cut short when run again, with the stage and reason it began with", async () => {
    const dataDir = await snapshottedThenWritten(["before the update"], ["written by the target"]);
    // A restore killed after its marker was written and while it copied the main file back.
    const marked: OutcomeRecord = { updateId, fromVersion: HARNESS_VERSION, toVersion: "0.5.0", stage: "trial", reason: "health" };
    writeFileSync(join(dataDir, RESTORE_MARKER_FILE), JSON.stringify(marked));
    truncateSync(join(dataDir, DATABASE_FILE), 1000);

    const { code, out, err } = await run(["restore", "--update-id", updateId, "--stage", "trial", "--reason", "health", "--to-version", "0.5.0", "--data-dir", dataDir]);

    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toBe(
      `Finished the restore of update ${updateId} that was cut short, over the database in ${dataDir}, and wrote its outcome record (trial: health): the version it went from reports the failure at its next start.\n`,
    );
    expect(readDatabase(dataDir)).toEqual(["before the update"]);
    expect(outcomeRecordIn(dataDir)).toEqual(marked);
    expect(existsSync(join(dataDir, RESTORE_MARKER_FILE))).toBe(false);
  });

  it("is refused while an environment holds the database, and copies nothing over it", async () => {
    const dataDir = await snapshottedThenWritten(["before the update"], []);
    await startOn(dataDir);

    const { code, out, err } = await run(["restore", "--update-id", updateId, "--stage", "trial", "--reason", "health", "--to-version", "0.5.0", "--data-dir", dataDir]);

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe(`An environment holds the database in ${dataDir}: stop it before the snapshot is restored.\n`);
    expect(existsSync(join(dataDir, RESTORE_MARKER_FILE))).toBe(false);
    expect(outcomeRecordIn(dataDir)).toBeUndefined();
  });

  it("with no snapshot of the update, says so, exits 1 and leaves the database as it is", async () => {
    const dataDir = dataDirectory();
    writeDatabase(dataDir, ["the target's"], "closed");

    const { code, err } = await run(["restore", "--update-id", updateId, "--stage", "trial", "--reason", "health", "--to-version", "0.5.0", "--data-dir", dataDir]);

    expect(code).toBe(1);
    expect(err).toBe(`There is no snapshot of update ${updateId} in ${join(dataDir, "snapshots")} to restore.\n`);
    expect(readDatabase(dataDir)).toEqual(["the target's"]);
    expect(outcomeRecordIn(dataDir)).toBeUndefined();
  });

  it("prints its usage and exits 2 without the update id, the stage, a reason code or the version it went to", async () => {
    const whole = ["--update-id", updateId, "--stage", "trial", "--reason", "health", "--to-version", "0.5.0"];
    const without = (flag: string) => whole.filter((_, index) => index !== whole.indexOf(flag) && index !== whole.indexOf(flag) + 1);
    for (const args of [
      without("--update-id"),
      without("--stage"),
      without("--reason"),
      without("--to-version"),
      [...without("--stage"), "--stage", "switch"],
      [...without("--reason"), "--reason", "Health check failed"],
      [...without("--to-version"), "--to-version", "v0.5.0"],
    ]) {
      const { code, err } = await run(["restore", ...args, "--data-dir", "/nonexistent/agent-harness"]);
      expect(code, args.join(" ")).toBe(2);
      expect(err, args.join(" ")).toContain("agent-harness update restore");
    }
    // A code of digits is one: past the arguments, the verb finds no snapshot to restore.
    const digits = await run(["restore", ...without("--reason"), "--reason", "503", "--data-dir", "/nonexistent/agent-harness"]);
    expect(digits.code).toBe(1);
    expect(digits.err).toMatch(/^There is no snapshot of update /);
  });
});

describe("after update restore", SPAWNS, () => {
  /** The update notices `t`'s log holds, oldest first, as type and payload. */
  const updateNotices = (t: TestEnvironment) =>
    t.env.log
      .readStream({ kinds: ["environment"] })
      .filter((event) => event.type.startsWith("environment.update"))
      .map((event) => ({ type: event.type, payload: event.payload }));

  it("the version the update went from reports the failure at its next start with the stage and reason given, and what the target wrote is gone", async () => {
    const fake = await startFakeReleaseSource();
    cleanups.push(() => fake.forge.close());
    fake.publish({ version: "0.5.0" });
    const dataDir = dataDirectory();
    const container: TestEnvironmentOptions = { containerDetector: { inContainer: () => true }, releaseSource: fake.source, forgeFetch: fake.forge.fetch };

    // 0.4.1 runs in a container; the host-side updater begins the ready update to 0.5.0 and stops the container.
    const old = await startOn(dataDir, { ...container, harnessVersion: "0.4.1" });
    const client = await old.client();
    await fake.grantAccess(client);
    const { pending } = await client.request("updates.check", {});
    if (pending.state !== "ready") throw new Error(`The update is not ready: ${JSON.stringify(pending)}`);
    const began = await client.request("updates.begin", { commandId: randomUUID(), updateId: pending.updateId });
    expect(began.receipt.status).toBe("accepted");
    old.clock.advance(0);
    void old.env.drain("signal");
    await old.env.drained;
    await old.close();

    // A one-off container of the old image snapshots the volume; the target runs, settles its update as taken, and crash-loops.
    expect((await run(["snapshot", "--update-id", pending.updateId, "--data-dir", dataDir])).code).toBe(0);
    const target = await startOn(dataDir, { ...container, harnessVersion: "0.5.0", clock: old.clock });
    expect(updateNotices(target).at(-1)?.type).toBe("environment.updated");
    await target.close();

    // A one-off container of the old image rolls it back, and the old version starts again.
    const restored = await run(["restore", "--update-id", pending.updateId, "--stage", "crash-loop", "--reason", "restarts", "--to-version", "0.5.0", "--data-dir", dataDir]);
    expect(restored.code).toBe(0);
    const back = await startOn(dataDir, { ...container, harnessVersion: "0.4.1", clock: old.clock });

    const { updateId } = pending;
    expect(updateNotices(back).slice(1)).toEqual([
      { type: "environment.update-started", payload: { updateId, fromVersion: "0.4.1", toVersion: "0.5.0", cause: "idle" } },
      { type: "environment.update-failed", payload: { updateId, fromVersion: "0.4.1", toVersion: "0.5.0", stage: "crash-loop", reason: "restarts", rolledBack: true } },
    ]);
    const status = await (await back.client()).request("updates.status", {});
    expect(status.lastOutcome).toMatchObject({ outcome: "failed", updateId, stage: "crash-loop", reason: "restarts", rolledBack: true });
    expect(status.failedVersions).toEqual(["0.5.0"]);
    // The settle deleted the record it reported.
    expect(outcomeRecordIn(dataDir)).toBeUndefined();
  });
});

describe("agent-harness update discard", SPAWNS, () => {
  const otherUpdate = "0b5c4f8e-9a51-4d2c-8e3f-6a7b8c9d0e1f";

  it("removes the update's snapshot and nothing else: the database, the outcome record and another update's snapshot stay", async () => {
    const dataDir = dataDirectory();
    writeDatabase(dataDir, ["the database"], "closed");
    takeSnapshot(dataDir, updateId);
    takeSnapshot(dataDir, otherUpdate);
    const record: OutcomeRecord = { updateId: otherUpdate, fromVersion: "0.4.1", toVersion: "0.5.0", stage: "trial", reason: "health" };
    writeFileSync(join(dataDir, OUTCOME_RECORD_FILE), JSON.stringify(record));
    const database = databaseFilesIn(dataDir);
    const other = databaseFilesIn(snapshotDirectory(dataDir, otherUpdate));

    const { code, out, err } = await run(["discard", "--update-id", updateId, "--data-dir", dataDir]);

    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toBe(`Discarded the snapshot of update ${updateId}.\n`);
    expect(existsSync(snapshotDirectory(dataDir, updateId))).toBe(false);
    expect(databaseFilesIn(snapshotDirectory(dataDir, otherUpdate))).toEqual(other);
    expect(databaseFilesIn(dataDir)).toEqual(database);
    expect(outcomeRecordIn(dataDir)).toEqual(record);
  });

  it("runs while an environment holds the database, as after a good watch the target does", async () => {
    const dataDir = dataDirectory();
    writeDatabase(dataDir, ["before the update"], "closed");
    takeSnapshot(dataDir, updateId);
    await startOn(dataDir);

    const { code } = await run(["discard", "--update-id", updateId, "--data-dir", dataDir]);

    expect(code).toBe(0);
    expect(existsSync(snapshotDirectory(dataDir, updateId))).toBe(false);
  });

  it("says there was nothing to discard when the update has no snapshot, and exits 0", async () => {
    const dataDir = dataDirectory();

    const { code, out } = await run(["discard", "--update-id", updateId, "--data-dir", dataDir]);

    expect(code).toBe(0);
    expect(out).toBe(`There was no snapshot of update ${updateId} to discard.\n`);
  });

  it("is refused while a restore of the update is marked, since finishing it needs the snapshot", async () => {
    const dataDir = await snapshottedThenWritten(["before the update"], []);
    const marked: OutcomeRecord = { updateId, fromVersion: "0.4.1", toVersion: "0.5.0", stage: "trial", reason: "health" };
    writeFileSync(join(dataDir, RESTORE_MARKER_FILE), JSON.stringify(marked));

    const { code, err } = await run(["discard", "--update-id", updateId, "--data-dir", dataDir]);

    expect(code).toBe(1);
    expect(err).toBe(`A restore of update ${updateId} is marked and not finished, and needs its snapshot: finish it with update restore first.\n`);
    expect(existsSync(snapshotDirectory(dataDir, updateId))).toBe(true);
  });

  it("prints its usage and exits 2 without an update id", async () => {
    for (const args of [[], ["--update-id", "u-1"]]) {
      const { code, err } = await run(["discard", ...args, "--data-dir", "/nonexistent/agent-harness"]);
      expect(code, args.join(" ")).toBe(2);
      expect(err, args.join(" ")).toContain("agent-harness update discard");
    }
  });
});

describe("the three verbs", SPAWNS, () => {
  it("need no running environment, and write only under the data directory", async () => {
    const dataDir = dataDirectory();
    const parent = dirname(dataDir);
    writeFileSync(join(parent, "beside.txt"), "untouched");
    writeDatabase(dataDir, ["before the update"], "open");

    // Each is run with a network that fails any use: no environment is asked anything.
    for (const args of [
      ["snapshot", "--update-id", updateId],
      ["restore", "--update-id", updateId, "--stage", "trial", "--reason", "health", "--to-version", "0.5.0"],
      ["discard", "--update-id", updateId],
    ]) {
      const { code, err } = await run([...args, "--data-dir", dataDir]);
      expect(err, args[0]).toBe("");
      expect(code, args[0]).toBe(0);
    }

    expect(readdirSync(parent).sort()).toEqual(["beside.txt", "data"]);
    expect(readFileSync(join(parent, "beside.txt"), "utf8")).toBe("untouched");
    expect(readDatabase(dataDir)).toEqual(["before the update"]);
  });
});
