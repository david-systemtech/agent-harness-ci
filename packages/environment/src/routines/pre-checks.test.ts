import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENVIRONMENT_STREAM_KIND, type RoutineDefinitionInput } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { created, history, listed, routineUpdates, runNow, untilRoutineEvent, untilSettled, untilStarted, written } from "../../test/routines.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * Pre-checks (routines spec, "Pre-checks"; #526), through the primary seam:
 * an in-process environment and a real client, the scripted fake provider
 * and the manual clock; real small scripts in the environment's scripts
 * directory, and a loopback HTTP server on port 0 as the URL source, so no
 * test reaches the network. What is asserted is what a client sees: the
 * answers, the history, the list, and the firing's first message.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ timeZone: "Asia/Manila", name: "laptop", ...options });
  onCleanup(() => t.close());
  return t;
};

/** A routine as a client writes it: run now only, firing in a scratch directory of its own. */
const routine = (overrides: Partial<RoutineDefinitionInput> = {}): RoutineDefinitionInput => written({ schedule: { kind: "manual" }, ...overrides });

/** The SHA-256 of `text`'s UTF-8 bytes, in hex. */
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Runs the routine now with its pre-check first; answers the entry id. */
const checkedRun = async (client: WireClient, routineId: string): Promise<string> => {
  const answer = await runNow(client, routineId, { withPreCheck: true });
  if (answer.result === undefined) throw new Error(`routines.runNow was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result.entryId;
};

/** How many sessions the environment has made. */
const sessionsMade = (t: TestEnvironment): number => t.env.log.readStream({ kinds: ["session"] }).filter((event) => event.type === "session.created").length;

/** The environment stream's event types after `afterSequence`. */
const environmentEventsAfter = (t: TestEnvironment, afterSequence: number): string[] =>
  t.env.log.readStream({ kind: ENVIRONMENT_STREAM_KIND, id: t.env.id }, afterSequence).map((event) => event.type);

/** Resolves once the entry's delivery to its targets has been attempted. */
const untilDelivered = (t: TestEnvironment, routineId: string, entryId: string) =>
  untilRoutineEvent(t, routineId, (event) => event.type === "routine.delivery-attempted" && event.payload["entryId"] === entryId);

/** The environment's scripts directory, where the OS user places pre-check scripts. */
const scriptsOf = (t: TestEnvironment): string => join(t.dataDir, "scripts");

/** Writes a shell script into the scripts directory at `path`, executable unless told otherwise; answers its path. */
const placeScript = (t: TestEnvironment, path: string, body: string, mode = 0o755): string => {
  const file = join(scriptsOf(t), path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, mode);
  return file;
};

describe("the scripts directory", () => {
  it("is made under the data directory with mode 0700, and routines.scripts.list answers its regular files, each executable or not", async () => {
    const t = await start();
    const client = await t.client();
    expect(statSync(scriptsOf(t)).mode & 0o777).toBe(0o700);
    expect(await client.request("routines.scripts.list", {})).toEqual({ directory: scriptsOf(t), scripts: [] });

    placeScript(t, "watch.sh", "echo hello");
    placeScript(t, "notes.txt", "not a script", 0o644);
    placeScript(t, "feeds/changelog.sh", "echo changelog");
    mkdirSync(join(scriptsOf(t), "empty"));
    const outside = join(tempDir(), "outside.sh");
    writeFileSync(outside, "#!/bin/sh\necho outside\n", { mode: 0o755 });
    symlinkSync(outside, join(scriptsOf(t), "escape.sh"));
    symlinkSync(join(scriptsOf(t), "watch.sh"), join(scriptsOf(t), "alias.sh"));

    expect(await client.request("routines.scripts.list", {})).toEqual({
      directory: scriptsOf(t),
      scripts: [
        { path: "alias.sh", executable: true },
        { path: "feeds/changelog.sh", executable: true },
        { path: "notes.txt", executable: false },
        { path: "watch.sh", executable: true },
      ],
    });
  });
});

describe("a script pre-check before run now", () => {
  it("fires on its first observation, whose success makes its output the baseline; the same output again is a skip no-change, with no session, model call, delivery or routine.updated", async () => {
    const t = await start();
    const client = await t.client();
    placeScript(t, "watch.sh", "printf 'v1.2.0\\n'");
    const { state } = await created(client, routine({ preCheck: { kind: "script", path: "watch.sh" } }));
    const hash = sha256("v1.2.0\n");

    const firingId = await checkedRun(client, state.id);
    const started = await untilStarted(t, state.id, firingId);
    expect(started.payload["preCheck"]).toEqual({
      kind: "script",
      startedAt: MANUAL_CLOCK_START,
      durationMs: 0,
      exitStatus: 0,
      httpStatus: null,
      bytes: 7,
      hash,
      differs: null,
      output: "v1.2.0\n",
      stderr: null,
      failure: null,
    });
    expect((await untilSettled(t, state.id, firingId)).payload).toMatchObject({ outcome: "succeeded", baselineAdvanced: true });
    await untilDelivered(t, state.id, firingId);
    expect((await listed(client, state.id))?.state.baseline).toEqual({ hash, at: MANUAL_CLOCK_START });

    const runs = t.adapter.runs.length;
    const sessions = sessionsMade(t);
    const head = t.env.log.head();
    const skipId = await checkedRun(client, state.id);
    expect((await untilSettled(t, state.id, skipId)).payload).toEqual({
      skipId,
      trigger: "run-now",
      dueAt: MANUAL_CLOCK_START,
      reason: "no-change",
      cannotStart: null,
      count: 1,
      detail: null,
      preCheck: expect.objectContaining({ exitStatus: 0, bytes: 7, hash, differs: false, output: null, failure: null }),
    });
    expect(t.adapter.runs.length).toBe(runs);
    expect(sessionsMade(t)).toBe(sessions);
    expect(await routineUpdates(await t.client(), head)).toEqual([]);
    expect(environmentEventsAfter(t, head)).not.toContain("routine.delivered");
    expect((await listed(client, state.id))?.state).toMatchObject({
      baseline: { hash, at: MANUAL_CLOCK_START },
      lastOutcome: { kind: "skip", entryId: skipId, reason: "no-change" },
      failureStreak: 0,
    });
    expect((await history(client, state.id))[0]).toMatchObject({ kind: "skip", id: skipId, reason: "no-change", deliveries: [] });
  });
});
