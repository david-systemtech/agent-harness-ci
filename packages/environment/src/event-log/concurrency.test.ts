import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { openEventLog } from "./event-log.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/**
 * An appender on its own thread and its own connection. It loads the store's
 * TypeScript source through tsx, opens the database, reports ready, waits on
 * the shared gate, then sends `rounds` commands to one stream, alternating
 * one-event and three-event appends, each with a receipt. The receipt lookup
 * reads before the insert writes, which is the path on which a transaction
 * that did not take the write lock up front would lose to the other appender.
 *
 * It pauses a millisecond between commands: SQLite's busy handler backs off
 * while the lock holder takes the lock again at once, so without the pause one
 * appender can starve the other and the two run one after the other instead
 * of interleaving.
 */
const APPENDER = `
const { workerData, parentPort } = require("node:worker_threads");
(async () => {
  const { tsImport } = await import(workerData.tsxApi);
  const { openEventLog } = await tsImport(workerData.store, workerData.store);
  const log = openEventLog({ path: workerData.path });
  const gate = new Int32Array(workerData.gate);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  parentPort.postMessage({ ready: true });
  Atomics.wait(gate, 0, 0);
  let appended = 0;
  for (let round = 0; round < workerData.rounds; round++) {
    const size = round % 2 === 0 ? 1 : 3;
    const events = Array.from({ length: size }, (_, i) => ({
      type: "race.step",
      payload: { appender: workerData.name, round, i },
    }));
    const result = log.append("session", "raced", events, {
      actor: workerData.name,
      commandId: workerData.name + "-" + round,
      receipt: { status: "accepted" },
    });
    if (result.duplicate || result.receipt.resultingSequence !== result.events.at(-1).sequence) {
      throw new Error("round " + round + " got a wrong receipt: " + JSON.stringify(result.receipt));
    }
    appended += result.events.length;
    Atomics.wait(pause, 0, 0, 1);
  }
  log.close();
  parentPort.postMessage({ done: appended });
})().catch((error) => parentPort.postMessage({ error: String(error && error.stack || error) }));
`;

const require = createRequire(import.meta.url);

const startAppender = (name: string, path: string, gate: SharedArrayBuffer, rounds: number) => {
  const worker = new Worker(APPENDER, {
    eval: true,
    workerData: {
      name,
      path,
      gate,
      rounds,
      tsxApi: pathToFileURL(require.resolve("tsx/esm/api")).href,
      store: new URL("./event-log.ts", import.meta.url).href,
    },
  });
  let onReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => (onReady = resolve));
  const done = new Promise<number>((resolve, reject) => {
    worker.on("message", (message: { ready?: true; done?: number; error?: string }) => {
      if (message.ready) onReady();
      if (message.done !== undefined) resolve(message.done);
      if (message.error) reject(new Error(message.error));
    });
    worker.on("error", reject);
  });
  done.finally(() => void worker.terminate()).catch(() => {});
  return { ready, done };
};

describe("concurrent appends to one stream", () => {
  it("never produce a duplicate stream version and lose no event", async () => {
    dir = mkdtempSync(join(tmpdir(), "agent-harness-race-"));
    const path = join(dir, "environment.db");
    openEventLog({ path }).close();

    const rounds = 150;
    const gate = new SharedArrayBuffer(4);
    const appenders = [startAppender("left", path, gate, rounds), startAppender("right", path, gate, rounds)];
    await Promise.all(appenders.map((a) => a.ready));
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
    const appended = await Promise.all(appenders.map((a) => a.done));

    const perAppender = rounds / 2 + (rounds / 2) * 3;
    expect(appended).toEqual([perAppender, perAppender]);

    const log = openEventLog({ path });
    const events = log.readStream("session", "raced");
    log.close();
    expect(events).toHaveLength(2 * perAppender);
    expect(events.map((e) => e.streamVersion)).toEqual(events.map((_, i) => i + 1));
    expect(new Set(events.map((e) => e.eventId)).size).toBe(events.length);

    // Each appender's events keep its order, and one append's events hold consecutive versions.
    const appends = new Map<string, number[]>();
    for (const name of ["left", "right"]) {
      const mine = events.filter((e) => e.actor === name);
      expect(mine.map((e) => e.payload)).toEqual(
        Array.from({ length: rounds }, (_, round) =>
          Array.from({ length: round % 2 === 0 ? 1 : 3 }, (_, i) => ({ appender: name, round, i })),
        ).flat(),
      );
      for (const e of mine) {
        const key = `${name}/${(e.payload as { round: number }).round}`;
        appends.set(key, [...(appends.get(key) ?? []), e.streamVersion]);
      }
    }
    for (const versions of appends.values()) {
      expect(versions).toEqual(versions.map((_, i) => (versions[0] ?? 0) + i));
    }
    const runs = events.reduce<{ actor: string; length: number }[]>((acc, e) => {
      const last = acc.at(-1);
      if (last && last.actor === e.actor) last.length++;
      else acc.push({ actor: e.actor, length: 1 });
      return acc;
    }, []);
    // The appenders interleaved, so the race was real rather than one finishing first.
    expect(runs.length).toBeGreaterThan(2);
  }, 60_000);
});
