import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import type { AppenderInput, AppenderMessage, WrittenEvent } from "./appender.worker.js";
import { openEventLog } from "./event-log.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Loads the TypeScript fixture on the worker thread through tsx's `tsImport`. */
const BOOTSTRAP = `
const { workerData } = require("node:worker_threads");
import(workerData.tsxApi).then(({ tsImport }) => tsImport(workerData.fixture, workerData.fixture));
`;

const require = createRequire(import.meta.url);

const startAppender = (input: AppenderInput) => {
  const worker = new Worker(BOOTSTRAP, {
    eval: true,
    workerData: {
      ...input,
      tsxApi: pathToFileURL(require.resolve("tsx/esm/api")).href,
      fixture: new URL("./appender.worker.ts", import.meta.url).href,
    },
  });
  // A failure before `ready` rejects both promises, so an early throw surfaces instead of a timeout.
  let onReady: () => void = () => {};
  let onNotReady: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    onReady = resolve;
    onNotReady = reject;
  });
  const done = new Promise<readonly (readonly WrittenEvent[])[]>((resolve, reject) => {
    const fail = (error: Error) => {
      onNotReady(error);
      reject(error);
    };
    worker.on("message", (message: AppenderMessage) => {
      if (message.kind === "ready") onReady();
      if (message.kind === "done") resolve(message.appends);
      if (message.kind === "failed") fail(new Error(message.error));
    });
    worker.on("error", fail);
  });
  ready.catch(() => {});
  done.finally(() => void worker.terminate()).catch(() => {});
  return { ready, done };
};

describe("concurrent appends to one stream", () => {
  it("never produce a duplicate stream version and lose no event", async () => {
    dir = mkdtempSync(join(tmpdir(), "agent-harness-race-"));
    const path = join(dir, "environment.db");
    const stream = { kind: "session", id: "raced" };
    openEventLog({ path }).close();

    const gate = new SharedArrayBuffer(4);
    const appenders = ["left", "right"].map((name) => startAppender({ name, path, stream, rounds: 150, gate }));
    await Promise.all(appenders.map((a) => a.ready));
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
    const [left = [], right = []] = await Promise.all(appenders.map((a) => a.done));

    const log = openEventLog({ path });
    const events = log.readStream(stream);
    log.close();

    // Every event either appender wrote is in the log, as it was reported, and nothing else is.
    const written = [...left, ...right].flat();
    expect(events).toHaveLength(written.length);
    expect(new Set(events.map((e) => e.eventId)).size).toBe(events.length);
    const stored = new Map(events.map((e) => [e.eventId, e]));
    for (const w of written) {
      expect(stored.get(w.eventId)).toMatchObject({
        sequence: w.sequence,
        streamVersion: w.streamVersion,
        payload: w.payload,
      });
    }

    // Versions run 1..n with no gap or duplicate, and one append's events hold consecutive versions.
    expect(events.map((e) => e.streamVersion)).toEqual(events.map((_, i) => i + 1));
    for (const append of [...left, ...right]) {
      const versions = append.map((e) => e.streamVersion);
      expect(versions).toEqual(versions.map((_, i) => (versions[0] ?? 0) + i));
    }

    // Each appender's events keep its own order in the log.
    for (const [name, appends] of [["left", left], ["right", right]] as const) {
      const inLog = events.filter((e) => e.actor === `system:${name}`).map((e) => e.eventId);
      expect(inLog).toEqual(appends.flat().map((e) => e.eventId));
    }

    // Both appenders wrote; whether they interleaved depends on scheduling and is not asserted, since a starved
    // waiter still proves the version rule once it runs (a busy runner made this flap when it was asserted).
    expect(new Set(events.map((e) => e.actor)).size).toBe(2);
  }, 60_000);
});
