import { closeSync, copyFileSync, existsSync, fsyncSync, linkSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { OUTCOME_RECORD_FILE, type OutcomeRecord } from "@agent-harness/contracts/launcher";
import { afterEach, describe, expect, it } from "vitest";
import { databaseFilesIn, readDatabase, writeDatabase } from "../../test/launcher-fixtures.js";
import {
  discardSnapshot,
  finishMarkedRestore,
  hasSnapshot,
  RESTORE_MARKER_FILE,
  restoreSnapshot,
  snapshotDirectory,
  snapshotNeeds,
  SNAPSHOTS_DIRECTORY,
  takeSnapshot,
  type SnapshotFs,
} from "./snapshot.js";

/**
 * The database snapshot and its restore (launcher-update spec, "Trial,
 * commit, rollback and the watch"; #340), called on a temporary data
 * directory holding a real SQLite database in WAL mode, with no launcher
 * running, as the container's `update snapshot` and `update restore` verbs
 * call them (#349).
 */

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const dataDirectory = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agent-harness-snapshot-"));
  dirs.push(dir);
  return dir;
};

const updateId = "7d0f2b1e-2c55-4a8e-9f0b-3a1c5d7e9b20";
const record: OutcomeRecord = { updateId, fromVersion: "0.4.0", toVersion: "0.5.0", stage: "trial", reason: "exit" };

/**
 * The file calls that change something, each recorded with the path it was
 * about relative to the data directory and the update id shortened to `<id>`;
 * `failAt` makes the call it names throw, as a launcher killed there would stop.
 */
const recordingFs = (dataDir: string, failAt?: string): { readonly fs: SnapshotFs; readonly calls: string[] } => {
  const calls: string[] = [];
  const opened = new Map<number, string>();
  const name = (path: string): string =>
    (relative(dataDir, path) || ".").replaceAll(updateId, "<id>").replace(/^(.*)\.[0-9a-f-]{36}\.tmp$/, "$1 (temporary)");
  const call = (text: string) => {
    if (text === failAt) throw new Error(`Stopped at ${text}.`);
    calls.push(text);
  };
  const fs: SnapshotFs = {
    openSync: (path, flags, mode) => {
      const fd = openSync(path, flags, mode);
      opened.set(fd, name(path));
      return fd;
    },
    writeFileSync: (fd, text) => {
      call(`write ${opened.get(fd)}`);
      writeFileSync(fd, text);
    },
    fsyncSync: (fd) => {
      call(`fsync ${opened.get(fd)}`);
      fsyncSync(fd);
    },
    closeSync: (fd) => closeSync(fd),
    renameSync: (from, to) => {
      call(`rename ${name(from)} to ${name(to)}`);
      renameSync(from, to);
    },
    rmSync: (path, options) => {
      call(`remove ${name(path)}`);
      rmSync(path, options);
    },
    linkSync: (existing, path) => {
      call(`link ${name(existing)} as ${name(path)}`);
      linkSync(existing, path);
    },
    copyFileSync: (from, to) => {
      call(`copy ${name(from)} to ${name(to)}`);
      copyFileSync(from, to);
    },
    mkdirSync: (path, options) => {
      call(`make ${name(path)}`);
      mkdirSync(path, options);
    },
  };
  return { fs, calls };
};

describe("the database snapshot, without a launcher", () => {
  it("copies the database's main, WAL and shm files into the update's folder byte for byte, leaving no staging folder", () => {
    const dataDir = dataDirectory();
    writeDatabase(dataDir, ["before the update"], "open");
    expect(Object.keys(databaseFilesIn(dataDir))).toEqual(["environment.db", "environment.db-wal", "environment.db-shm"]);
    expect(hasSnapshot(dataDir, updateId)).toBe(false);

    expect(takeSnapshot(dataDir, updateId)).toBe("taken");

    expect(hasSnapshot(dataDir, updateId)).toBe(true);
    expect(snapshotDirectory(dataDir, updateId)).toBe(join(dataDir, "snapshots", updateId));
    expect(databaseFilesIn(snapshotDirectory(dataDir, updateId))).toEqual(databaseFilesIn(dataDir));
    expect(readdirSync(join(dataDir, SNAPSHOTS_DIRECTORY))).toEqual([updateId]);
  });

  it("takes only the files there are: a database closed cleanly has no WAL or shm", () => {
    const dataDir = dataDirectory();
    writeDatabase(dataDir, ["before the update"], "closed");
    takeSnapshot(dataDir, updateId);
    expect(Object.keys(databaseFilesIn(snapshotDirectory(dataDir, updateId)))).toEqual(["environment.db"]);
  });

  it("is taken once per update id: a completed snapshot is kept, never overwritten", () => {
    const dataDir = dataDirectory();
    writeDatabase(dataDir, ["before the update"], "open");
    takeSnapshot(dataDir, updateId);
    const first = databaseFilesIn(snapshotDirectory(dataDir, updateId));
    writeDatabase(dataDir, ["written since"], "open");
    expect(databaseFilesIn(dataDir)).not.toEqual(first);

    expect(takeSnapshot(dataDir, updateId)).toBe("kept");

    expect(databaseFilesIn(snapshotDirectory(dataDir, updateId))).toEqual(first);
  });

  it("goes through a staging folder and a rename: a staging folder a snapshot cut short left is no snapshot, and the next takes it afresh", () => {
    const dataDir = dataDirectory();
    writeDatabase(dataDir, ["before the update"], "open");
    const { fs } = recordingFs(dataDir, "rename snapshots/<id>.staging to snapshots/<id>");
    expect(() => takeSnapshot(dataDir, updateId, { fs })).toThrow(/Stopped at rename/);
    expect(hasSnapshot(dataDir, updateId)).toBe(false);
    writeFileSync(join(dataDir, SNAPSHOTS_DIRECTORY, `${updateId}.staging`, "environment.db"), "half a copy");

    expect(takeSnapshot(dataDir, updateId)).toBe("taken");

    expect(databaseFilesIn(snapshotDirectory(dataDir, updateId))).toEqual(databaseFilesIn(dataDir));
    expect(readdirSync(join(dataDir, SNAPSHOTS_DIRECTORY))).toEqual([updateId]);
  });

  it("puts every copy and the staging folder on disk before the rename that completes the snapshot, and the rename after", () => {
    const dataDir = dataDirectory();
    writeDatabase(dataDir, ["before the update"], "open");
    const { fs, calls } = recordingFs(dataDir);
    takeSnapshot(dataDir, updateId, { fs, platform: "linux" });
    expect(calls).toEqual([
      "remove snapshots/<id>.staging",
      "make snapshots/<id>.staging",
      "copy environment.db to snapshots/<id>.staging/environment.db",
      "fsync snapshots/<id>.staging/environment.db",
      "copy environment.db-wal to snapshots/<id>.staging/environment.db-wal",
      "fsync snapshots/<id>.staging/environment.db-wal",
      "copy environment.db-shm to snapshots/<id>.staging/environment.db-shm",
      "fsync snapshots/<id>.staging/environment.db-shm",
      "fsync snapshots/<id>.staging",
      "rename snapshots/<id>.staging to snapshots/<id>",
      "fsync snapshots",
    ]);
  });

  it("needs the database's files' sizes plus 256 MiB free", () => {
    const dataDir = dataDirectory();
    expect(snapshotNeeds(dataDir)).toBe(268_435_456);
    writeFileSync(join(dataDir, "environment.db"), Buffer.alloc(4096));
    writeFileSync(join(dataDir, "environment.db-wal"), Buffer.alloc(1000));
    writeFileSync(join(dataDir, "environment.db-shm"), Buffer.alloc(32));
    writeFileSync(join(dataDir, "environment.db-journal"), Buffer.alloc(5000));
    expect(snapshotNeeds(dataDir)).toBe(268_435_456 + 4096 + 1000 + 32);
  });

  it("names its folder by an update id and nothing else", () => {
    const dataDir = dataDirectory();
    writeDatabase(dataDir, ["before the update"], "closed");
    for (const id of ["../versions", "update-1", ""]) {
      expect(() => takeSnapshot(dataDir, id), id).toThrow(/is not an update id/);
      expect(() => snapshotDirectory(dataDir, id), id).toThrow(/is not an update id/);
    }
    expect(existsSync(join(dataDir, SNAPSHOTS_DIRECTORY))).toBe(false);
  });

  it("is discarded with a staging folder it left, and nothing else", () => {
    const dataDir = dataDirectory();
    writeDatabase(dataDir, ["before the update"], "closed");
    const other = "0b8e3c9a-6f1d-4e2b-8a7c-5d9e0f1a2b3c";
    takeSnapshot(dataDir, updateId);
    takeSnapshot(dataDir, other);
    mkdirSync(join(dataDir, SNAPSHOTS_DIRECTORY, `${updateId}.staging`));
    const database = databaseFilesIn(dataDir);

    discardSnapshot(dataDir, updateId);

    expect(readdirSync(join(dataDir, SNAPSHOTS_DIRECTORY))).toEqual([other]);
    expect(databaseFilesIn(dataDir)).toEqual(database);
    expect(() => discardSnapshot(dataDir, updateId)).not.toThrow();
  });
});

describe("the restore, without a launcher", () => {
  /** A data directory whose snapshot was taken of a database closed cleanly, which the trial then wrote to and left open. */
  const afterAFailedTrial = (): { readonly dataDir: string; readonly snapshot: Record<string, Buffer> } => {
    const dataDir = dataDirectory();
    writeDatabase(dataDir, ["before the update"], "closed");
    takeSnapshot(dataDir, updateId);
    writeDatabase(dataDir, ["written by the trial"], "open");
    expect(Object.keys(databaseFilesIn(dataDir))).toEqual(["environment.db", "environment.db-wal", "environment.db-shm"]);
    return { dataDir, snapshot: databaseFilesIn(snapshotDirectory(dataDir, updateId)) };
  };

  const outcomeRecordIn = (dataDir: string): unknown => JSON.parse(readFileSync(join(dataDir, OUTCOME_RECORD_FILE), "utf8"));

  it("copies the snapshot back byte for byte, removes the WAL and shm it lacked, writes the outcome record and clears its marker", () => {
    const { dataDir, snapshot } = afterAFailedTrial();

    restoreSnapshot(dataDir, record);

    expect(databaseFilesIn(dataDir)).toEqual(snapshot);
    expect(outcomeRecordIn(dataDir)).toEqual(record);
    expect(existsSync(join(dataDir, RESTORE_MARKER_FILE))).toBe(false);
    expect(readDatabase(dataDir)).toEqual(["before the update"]);
  });

  it("marks the restore exclusively and on disk before it copies anything, puts the copy on disk before the outcome record, and clears the marker last", () => {
    const { dataDir } = afterAFailedTrial();
    const { fs, calls } = recordingFs(dataDir);

    restoreSnapshot(dataDir, record, { fs, platform: "linux", whileMarked: () => calls.push("while marked") });

    expect(calls).toEqual([
      `write .${RESTORE_MARKER_FILE} (temporary)`,
      `fsync .${RESTORE_MARKER_FILE} (temporary)`,
      `link .${RESTORE_MARKER_FILE} (temporary) as ${RESTORE_MARKER_FILE}`,
      `remove .${RESTORE_MARKER_FILE} (temporary)`,
      "fsync .",
      "copy snapshots/<id>/environment.db to environment.db",
      "fsync environment.db",
      "remove environment.db-wal",
      "remove environment.db-shm",
      "fsync .",
      `write .${OUTCOME_RECORD_FILE} (temporary)`,
      `fsync .${OUTCOME_RECORD_FILE} (temporary)`,
      `rename .${OUTCOME_RECORD_FILE} (temporary) to ${OUTCOME_RECORD_FILE}`,
      "fsync .",
      "while marked",
      `remove ${RESTORE_MARKER_FILE}`,
      "fsync .",
    ]);
  });

  it("is finished from its marker after it was cut short, with the record the marker holds", () => {
    const { dataDir, snapshot } = afterAFailedTrial();
    const { fs } = recordingFs(dataDir, "remove environment.db-wal");
    expect(() => restoreSnapshot(dataDir, record, { fs })).toThrow(/Stopped at remove/);
    expect(existsSync(join(dataDir, RESTORE_MARKER_FILE))).toBe(true);
    expect(existsSync(join(dataDir, OUTCOME_RECORD_FILE))).toBe(false);
    const cleared: OutcomeRecord[] = [];

    expect(finishMarkedRestore(dataDir, { whileMarked: (marked) => cleared.push(marked) })).toEqual(record);

    expect(cleared).toEqual([record]);
    expect(databaseFilesIn(dataDir)).toEqual(snapshot);
    expect(outcomeRecordIn(dataDir)).toEqual(record);
    expect(existsSync(join(dataDir, RESTORE_MARKER_FILE))).toBe(false);
  });

  it("finishes nothing when no restore is marked", () => {
    const { dataDir } = afterAFailedTrial();
    const before = databaseFilesIn(dataDir);
    expect(finishMarkedRestore(dataDir)).toBeUndefined();
    expect(databaseFilesIn(dataDir)).toEqual(before);
    expect(existsSync(join(dataDir, OUTCOME_RECORD_FILE))).toBe(false);
  });

  it("does not begin while another restore is marked, and names it", () => {
    const { dataDir } = afterAFailedTrial();
    const { fs } = recordingFs(dataDir, "copy snapshots/<id>/environment.db to environment.db");
    expect(() => restoreSnapshot(dataDir, record, { fs })).toThrow(/Stopped at copy/);
    const before = databaseFilesIn(dataDir);

    expect(() => restoreSnapshot(dataDir, { ...record, reason: "deadline" })).toThrow(`A restore of update ${updateId} is marked and not finished`);

    expect(databaseFilesIn(dataDir)).toEqual(before);
    expect(JSON.parse(readFileSync(join(dataDir, RESTORE_MARKER_FILE), "utf8"))).toEqual(record);
  });

  it("does not begin without a snapshot of the update, and marks nothing", () => {
    const dataDir = dataDirectory();
    writeDatabase(dataDir, ["before the update"], "open");
    const before = databaseFilesIn(dataDir);
    expect(() => restoreSnapshot(dataDir, record)).toThrow(`There is no snapshot of update ${updateId}`);
    expect(databaseFilesIn(dataDir)).toEqual(before);
    expect(readdirSync(dataDir).sort()).toEqual(["environment.db", "environment.db-shm", "environment.db-wal"]);
  });

  it("does not finish a marked restore whose snapshot is gone, and leaves the database and the marker as they are", () => {
    const { dataDir } = afterAFailedTrial();
    const { fs } = recordingFs(dataDir, "copy snapshots/<id>/environment.db to environment.db");
    expect(() => restoreSnapshot(dataDir, record, { fs })).toThrow(/Stopped at copy/);
    rmSync(snapshotDirectory(dataDir, updateId), { recursive: true });
    const before = databaseFilesIn(dataDir);

    expect(() => finishMarkedRestore(dataDir)).toThrow(`There is no snapshot of update ${updateId}`);

    expect(databaseFilesIn(dataDir)).toEqual(before);
    expect(existsSync(join(dataDir, RESTORE_MARKER_FILE))).toBe(true);
  });

  it("refuses a marker it cannot read as an outcome record, naming the file", () => {
    const dataDir = dataDirectory();
    writeFileSync(join(dataDir, RESTORE_MARKER_FILE), JSON.stringify({ ...record, updateId: "../versions" }));
    expect(() => finishMarkedRestore(dataDir)).toThrow(`The restore marker at ${join(dataDir, RESTORE_MARKER_FILE)} is not an outcome record`);
  });
});
