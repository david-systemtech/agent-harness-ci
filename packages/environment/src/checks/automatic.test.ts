import { randomUUID } from "node:crypto";
import { realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHECK_OUTPUT_MAX_BYTES, CHECK_TIMEOUT_MS, FILE_UNDO_MAX_FILE_BYTES } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import type { Script } from "../../test/fake-adapter.js";
import { end, fileTool, gate } from "../../test/fake-adapter.js";
import { fakePty } from "../../test/fake-pty.js";
import { useCleanups } from "../../test/cleanups.js";
import { restartAfter, startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { sessionIn } from "../../test/terminals.js";
import type { WireClient } from "../../test/wire-client.js";

const { onCleanup, tempDir } = useCleanups();
const open = async (options: TestEnvironmentOptions = {}) => {
  const run = fakePty();
  const t = await startTestEnvironment({ ...options, terminals: { ...options.terminals, run } });
  onCleanup(() => t.close());
  return { ...t, run };
};
const start = async (options: TestEnvironmentOptions = {}) => {
  const t = await open(options);
  const { run } = t;
  const client = await t.client();
  const root = tempDir("agent-harness-auto-check-");
  const sessionId = await sessionIn(client, root);
  await client.apply("checks.set", { commandId: randomUUID(), sessionId, command: "make check" });
  return { t, run, client, root, sessionId };
};

const nextEvent = (t: TestEnvironment, sessionId: string, type: string) => new Promise<Record<string, unknown>>((resolve) => {
  const unsubscribe = t.env.log.subscribe((event) => {
    if (event.streamId !== sessionId || event.type !== type) return;
    unsubscribe();
    resolve(event.payload);
  });

});
const turn = async (t: TestEnvironment, client: WireClient, sessionId: string, script: Script): Promise<string> => {
  t.adapter.nextScripts.push(script);
  const ended = nextEvent(t, sessionId, "run.ended");
  await client.apply("runs.start", { commandId: randomUUID(), sessionId, text: "Edit the file" });
  return String((await ended)["runId"]);
};
const write = (path: string): Script => async function* (controls) {
  yield* fileTool(controls, { tool: "Write", input: { file_path: path, content: "changed" }, paths: [path], write: () => writeFileSync(path, "changed") });
  yield end();
};

describe("automatic Workspace checks", () => {
  it("checks a completed edited Run once in the Environment, with its source Run in both events, without another agent turn", async () => {
    const { t, run, client, root, sessionId } = await start();
    const started = nextEvent(t, sessionId, "checks.started");
    const runId = await turn(t, client, sessionId, write(join(root, "a.txt")));
    expect(await started).toMatchObject({ command: "make check", sourceRunId: runId });
    const shell = await run.spawnedAt(0);
    const finished = nextEvent(t, sessionId, "checks.finished");
    shell.print("all passed\n");
    shell.exit(0);
    expect(await finished).toMatchObject({ sourceRunId: runId, output: "all passed\n", exitCode: 0 });
    expect(run.spawned).toHaveLength(1);
    expect(t.adapter.runs).toHaveLength(1);
  });

  it("coalesces busy edits across two Clients into one follow-up in the latest edited Session and canonical directory", async () => {
    const { t, run, client, root, sessionId } = await start();
    const other = await t.client({ token: (await t.bootstrap("desktop", "other Client")).token });
    const sibling = await sessionIn(other, root);
    const started = nextEvent(t, sessionId, "checks.started");
    await turn(t, client, sessionId, write(join(root, "a.txt")));
    await started;
    const first = await run.spawnedAt(0);
    await turn(t, client, sessionId, write(join(root, "b.txt")));
    const latest = await turn(t, other, sibling, write(join(root, "c.txt")));
    expect(run.spawned).toHaveLength(1);
    const followup = nextEvent(t, sibling, "checks.started");
    first.exit(0);
    expect(await followup).toMatchObject({ command: "make check", sourceRunId: latest });
    const second = await run.spawnedAt(1);
    expect(second.options.cwd).toBe(root);
    const finished = nextEvent(t, sibling, "checks.finished");
    second.exit(0);
    await finished;
    expect(run.spawned).toHaveLength(2);
    expect(t.adapter.runs).toHaveLength(3);
  });

  it("offers identical failures once across Sessions until a pass resets the durable failure identity", async () => {
    const { t, run, client, root, sessionId } = await start();
    const sibling = await sessionIn(client, root);
    const check = async (id: string, index: number, code: number) => {
      const started = nextEvent(t, id, "checks.started");
      await turn(t, client, id, write(join(root, "a.txt")));
      await started;
      const shell = await run.spawnedAt(index);
      const finished = nextEvent(t, id, "checks.finished");
      shell.print("same result\n");
      shell.exit(code);
      return finished;
    };
    expect(await check(sessionId, 0, 1)).toMatchObject({ offerFailure: true });
    expect(await check(sibling, 1, 1)).toMatchObject({ offerFailure: false });
    expect(await check(sibling, 2, 0)).toMatchObject({ offerFailure: false });
    expect(await check(sessionId, 3, 1)).toMatchObject({ offerFailure: true });
  });
});


describe("recognised edits and Run completion", () => {
  it.each(["Edit", "MultiEdit", "Write", "NotebookEdit"])("checks successful %s even when oversized undo snapshots are unavailable", async (tool) => {
    const { t, run, client, root, sessionId } = await start();
    const path = join(root, "large.txt");
    writeFileSync(path, "x".repeat(FILE_UNDO_MAX_FILE_BYTES + 1));
    const started = nextEvent(t, sessionId, "checks.started");
    const runId = await turn(t, client, sessionId, async function* (controls) {
      const input = tool === "NotebookEdit" ? { notebook_path: path } : { file_path: path };
      yield* fileTool(controls, { tool, input, paths: [path], write: () => writeFileSync(path, "y".repeat(FILE_UNDO_MAX_FILE_BYTES + 1)) });
      yield end();
    });
    expect(await started).toMatchObject({ sourceRunId: runId });
    expect((await client.request("files.undo", { commandId: randomUUID(), sessionId })).receipt).toMatchObject({ status: "rejected", error: { data: { reason: "snapshot_unavailable" } } });
    expect(run.spawned).toHaveLength(1);
  });

  it("excludes failed file tools, shell-only edits, unedited and non-completed Runs", async () => {
    const { t, run, client, root, sessionId } = await start();
    const path = join(root, "a.txt");
    await turn(t, client, sessionId, async function* (controls) {
      yield* fileTool(controls, { tool: "Edit", input: { file_path: path }, paths: [path], write: () => { throw new Error("write refused"); } });
      yield end();
    });
    await turn(t, client, sessionId, async function* () {
      yield { type: "tool.started", payload: { toolCallId: "shell-edit", name: "Bash", input: { command: "write file" }, title: null, agentId: null, parentToolCallId: null } };
      writeFileSync(path, "shell changed this");
      yield { type: "tool.ended", payload: { toolCallId: "shell-edit", status: "ok", output: "done", durationMs: 1 } };
      yield end();
    });
    await turn(t, client, sessionId, async function* () { yield end(); });
    for (const reason of ["error", "interrupted"] as const) {
      await turn(t, client, sessionId, async function* (controls) {
        yield* fileTool(controls, { tool: "Write", input: { file_path: path }, paths: [path], write: () => writeFileSync(path, reason) });
        yield end(reason);
      });
    }
    // A successful tracer Run also drains preceding scheduling boundaries.
    const started = nextEvent(t, sessionId, "checks.started");
    const runId = await turn(t, client, sessionId, write(path));
    expect(await started).toMatchObject({ sourceRunId: runId });
    await run.spawnedAt(0);
    expect(run.spawned).toHaveLength(1);
  });

  it("shares canonical configuration with an editing Client that has no terminal grant, while a revoked configuring Client refuses automatic work explicitly", async () => {
    const { t, run, client, root, sessionId } = await start();
    const token = await t.pair({ scopes: ["read", "sessions:write", "runs:drive"] });
    const other = await t.client({ token: token.token });
    const link = join(tempDir("agent-harness-check-link-"), "project");
    symlinkSync(root, link);
    const sibling = await sessionIn(other, link);
    const started = nextEvent(t, sibling, "checks.started");
    const runId = await turn(t, other, sibling, write(join(root, "a.txt")));
    expect(await started).toMatchObject({ sourceRunId: runId });
    const shell = await run.spawnedAt(0);
    expect(shell.options.cwd).toBe(realpathSync(root));
    const finished = nextEvent(t, sibling, "checks.finished");
    shell.exit(0);
    await finished;
    t.env.clientSessions.revoke(client.hello.clientSessionId);
    const refused = nextEvent(t, sibling, "checks.finished");
    const latest = await turn(t, other, sibling, write(join(root, "b.txt")));
    expect(await refused).toMatchObject({ sourceRunId: latest, exitCode: null, failure: "launch_failed", output: expect.stringContaining("terminal grant") });
    expect(run.spawned).toHaveLength(1);
    // Manual checks use their caller's grant, independent of the former configurator.
    const manual = await t.client({ token: (await t.bootstrap("tui", "manual caller")).token });
    await manual.apply("checks.run", { commandId: randomUUID(), sessionId });
    expect(await run.spawnedAt(1)).toMatchObject({ args: ["-c", "make check"] });
  });

  it("does not launch twice when two Clients replay the Session and the Environment rebuilds its projections", async () => {
    const { t, run, client, root, sessionId } = await start();
    const started = nextEvent(t, sessionId, "checks.started");
    const sourceRunId = await turn(t, client, sessionId, write(join(root, "a.txt")));
    await started;
    const finished = nextEvent(t, sessionId, "checks.finished");
    (await run.spawnedAt(0)).exit(0);
    await finished;
    t.env.log.rebuildProjections();
    for (const reader of [client, await t.client()]) {
      const { subscription } = await reader.subscribe("sessions.subscribeSession", { sessionId, afterSequence: 0 });
      await reader.next((frame) => frame.type === "synchronized" && frame.subscription === subscription);
    }
    // Replay of the same completed Run is also ignored by the durable scheduler projection.
    const ended = t.env.log.readStream({ kind: "session", id: sessionId }).find((event) => event.type === "run.ended" && event.payload["runId"] === sourceRunId)!;
    t.env.log.append({ kind: "session", id: sessionId }, [{ type: ended.type, payload: ended.payload }], { actor: "system:replay-test" });
    const next = nextEvent(t, sessionId, "checks.started");
    const latest = await turn(t, client, sessionId, write(join(root, "b.txt")));
    expect(await next).toMatchObject({ sourceRunId: latest });
    await run.spawnedAt(1);
    expect(run.spawned).toHaveLength(2);
  });
});

describe("failure offers", () => {
  it("announces a directory-wide reset on manual now and on a pass so every Session can clear an old offer", async () => {
    const { t, run, client, root, sessionId } = await start();
    const sibling = await sessionIn(client, root);
    const head = t.env.log.head();
    await client.apply("checks.run", { commandId: randomUUID(), sessionId: sibling });
    const finished = nextEvent(t, sibling, "checks.finished");
    (await run.spawnedAt(0)).exit(0);
    await finished;
    const resets = t.env.log.readStream({ kind: "environment", id: t.env.id }, head).filter((event) => event.type === "checks.failures-reset");
    expect(resets.map((event) => event.payload)).toEqual([{ workspace: root }, { workspace: root }]);
    expect(t.adapter.runs).toHaveLength(0);
    expect(await client.request("checks.get", { sessionId })).toEqual({ workspace: root, command: "make check" });
  });
});

describe("pending checks and restart", () => {
  it.each([null, "make other"])("%s cancels busy pending work and stale failure offers while the running check and its rows remain", async (command) => {
    const { t, run, client, root, sessionId } = await start();
    const started = nextEvent(t, sessionId, "checks.started");
    const original = await turn(t, client, sessionId, write(join(root, "a.txt")));
    await started;
    const shell = await run.spawnedAt(0);
    await turn(t, client, sessionId, write(join(root, "b.txt")));
    await client.apply("checks.set", { commandId: randomUUID(), sessionId, command });
    expect(shell.signals).toEqual([]);
    const finished = nextEvent(t, sessionId, "checks.finished");
    shell.print("old failure\n");
    shell.exit(1);
    expect(await finished).toMatchObject({ sourceRunId: original, command: "make check", exitCode: 1, output: "old failure\n", offerFailure: false });
    // Saving a command anew does not revive the canceled Run.
    await client.apply("checks.set", { commandId: randomUUID(), sessionId, command: "make fresh" });
    const fresh = nextEvent(t, sessionId, "checks.started");
    const latest = await turn(t, client, sessionId, write(join(root, "c.txt")));
    expect(await fresh).toMatchObject({ sourceRunId: latest, command: "make fresh" });
    await run.spawnedAt(1);
    expect(run.spawned).toHaveLength(2);
  });

  it("finishes interrupted checks without rerunning them, retaining one latest pending Session across restart and replay", async () => {
    const { t, run, client, root, sessionId } = await start({ dataDir: tempDir("agent-harness-auto-restart-") });
    const sibling = await sessionIn(client, root);
    const started = nextEvent(t, sessionId, "checks.started");
    const original = await turn(t, client, sessionId, write(join(root, "a.txt")));
    const first = await started;
    await run.spawnedAt(0);
    await turn(t, client, sessionId, write(join(root, "b.txt")));
    const latest = await turn(t, client, sibling, write(join(root, "c.txt")));
    const back = await restartAfter(t, 0, open);
    const shell = await back.run.spawnedAt(0);
    const events = back.env.log.readStream({ kind: "session", id: sessionId });
    expect(events.filter((event) => event.type === "checks.finished").map((event) => event.payload)).toContainEqual(expect.objectContaining({ terminalId: first["terminalId"], sourceRunId: original, failure: "interrupted" }));
    const followups = back.env.log.readStream({ kind: "session", id: sibling }).filter((event) => event.type === "checks.started");
    expect(followups.map((event) => event.payload)).toEqual([expect.objectContaining({ sourceRunId: latest, command: "make check" })]);
    const finished = nextEvent(back, sibling, "checks.finished");
    shell.exit(0);
    await finished;
    back.env.log.rebuildProjections();
    const again = await restartAfter(back, 0, open);
    await (await again.client()).request("checks.get", { sessionId });
    expect(again.run.spawned).toHaveLength(0);
  });

  it("retains failure deduplication across restart, resetting on manual now, changed command and off", async () => {
    const { t, run, client, root, sessionId } = await start({ dataDir: tempDir("agent-harness-auto-offers-") });
    const check = async (env: TestEnvironment, reader: WireClient, processes: typeof run, index: number, manual = false) => {
      const started = nextEvent(env, sessionId, "checks.started");
      if (manual) await reader.apply("checks.run", { commandId: randomUUID(), sessionId });
      else await turn(env, reader, sessionId, write(join(root, "a.txt")));
      await started;
      const shell = await processes.spawnedAt(index);
      const finished = nextEvent(env, sessionId, "checks.finished");
      shell.print("unchanged failure\n");
      shell.exit(1);
      return finished;
    };
    expect(await check(t, client, run, 0)).toMatchObject({ offerFailure: true });
    const back = await restartAfter(t, 0, open);
    const reader = await back.client();
    expect(await check(back, reader, back.run, 0)).toMatchObject({ offerFailure: false });
    expect(await check(back, reader, back.run, 1, true)).toMatchObject({ offerFailure: true, sourceRunId: null });
    expect(await check(back, reader, back.run, 2)).toMatchObject({ offerFailure: false });
    await reader.apply("checks.set", { commandId: randomUUID(), sessionId, command: "make changed" });
    expect(await check(back, reader, back.run, 3)).toMatchObject({ offerFailure: true });
    await reader.apply("checks.set", { commandId: randomUUID(), sessionId, command: null });
    await reader.apply("checks.set", { commandId: randomUUID(), sessionId, command: "make changed" });
    expect(await check(back, reader, back.run, 4)).toMatchObject({ offerFailure: true });
  });

  it("uses the manual executor's timeout, scrubbed output and byte bounds for automatic checks", async () => {
    const { t, run, client, root, sessionId } = await start();
    const started = nextEvent(t, sessionId, "checks.started");
    const runId = await turn(t, client, sessionId, write(join(root, "a.txt")));
    await started;
    const shell = await run.spawnedAt(0);
    t.scrub.register("secret-for-check-tests", { owner: "test:checks" });
    shell.print("€".repeat(30_000));
    shell.print("secret-for-check-tests\n");
    const finished = nextEvent(t, sessionId, "checks.finished");
    t.clock.advance(CHECK_TIMEOUT_MS);
    expect(shell.signals).toEqual(["SIGHUP"]);
    shell.exit(0, 1);
    expect(await finished).toMatchObject({ sourceRunId: runId, timedOut: true, exitCode: null, truncated: true, offerFailure: true, output: "€".repeat(Math.floor((CHECK_OUTPUT_MAX_BYTES - 11) / 3)) + "[redacted]\n" });
    expect(t.adapter.runs).toHaveLength(1);
  });

  it("records missing Workspace and terminal launch refusals explicitly without an automatic prompt", async () => {
    const { t, run, client, root, sessionId } = await start();
    const started = nextEvent(t, sessionId, "checks.started");
    await turn(t, client, sessionId, write(join(root, "a.txt")));
    await started;
    const shell = await run.spawnedAt(0);
    const latest = await turn(t, client, sessionId, write(join(root, "b.txt")));
    rmSync(root, { recursive: true });
    const refused = nextEvent(t, sessionId, "checks.finished");
    shell.exit(0);
    // First comes the running check's finish; then the pending attempt's explicit refusal.
    await refused;
    const failure = await nextEvent(t, sessionId, "checks.finished");
    expect(failure).toMatchObject({ sourceRunId: latest, failure: "launch_failed", output: expect.stringContaining("Workspace") });
    expect(run.spawned).toHaveLength(1);
  });
});

describe("interrupted launch boundaries", () => {
  it("recovers a committed automatic start cut before its shell opens, records failure and never replays that Run's shell work", async () => {
    const { t, root, sessionId } = await start({ dataDir: tempDir("agent-harness-check-launch-crash-") });
    const runId = randomUUID();
    const terminalId = randomUUID();
    const changed = t.env.log.readStream({ kind: "environment", id: t.env.id }).find((event) => event.type === "checks.changed")!;
    // A crash after the attempt's commit but before the terminal's afterCommit callback.
    // The three durable events are committed together; there is no live process in this fixture.
    const ended = { runId, reason: "completed", cause: null, error: null, usage: null, durationMs: 0, turnCount: null, resultText: null };
    t.env.log.append({ kind: "session", id: sessionId }, [
      { type: "checks.edit-observed", payload: { runId, workspace: root } },
      { type: "run.ended", payload: ended },
      { type: "checks.started", payload: { terminalId, command: "make check", sourceRunId: runId }, metadata: { workspace: root, revision: changed.sequence } },
    ], { actor: "system:crash-fixture" });
    const back = await restartAfter(t, 0, open);
    const failures = back.env.log.readStream({ kind: "session", id: sessionId }).filter((event) => event.type === "checks.finished");
    expect(failures.map((event) => event.payload)).toEqual([expect.objectContaining({ terminalId, sourceRunId: runId, failure: "interrupted", exitCode: null, offerFailure: true })]);
    back.env.log.rebuildProjections();
    back.env.log.append({ kind: "session", id: sessionId }, [{ type: "run.ended", payload: ended }], { actor: "system:replay-test" });
    const reader = await back.client();
    const started = nextEvent(back, sessionId, "checks.started");
    const latest = await turn(back, reader, sessionId, write(join(root, "new.txt")));
    expect(await started).toMatchObject({ sourceRunId: latest });
    await back.run.spawnedAt(0);
    expect(back.run.spawned).toHaveLength(1);
  });

  it("records the terminal executor's launch failure explicitly and leaves the directory available for its next check", async () => {
    const { t, run, client, root, sessionId } = await start();
    run.failNext = "spawn /bin/sh ENOENT";
    const failed = nextEvent(t, sessionId, "checks.finished");
    const runId = await turn(t, client, sessionId, write(join(root, "a.txt")));
    expect(await failed).toMatchObject({ sourceRunId: runId, failure: "launch_failed", output: expect.stringContaining("ENOENT"), exitCode: null, offerFailure: true });
    const next = nextEvent(t, sessionId, "checks.started");
    const latest = await turn(t, client, sessionId, write(join(root, "b.txt")));
    expect(await next).toMatchObject({ sourceRunId: latest });
    await run.spawnedAt(0);
    expect(t.adapter.runs).toHaveLength(2);
  });
});

describe("automatic launch preparation", () => {
  it("keeps the first attempt while its availability look is held, then checks one latest edit from another Session", async () => {
    const entered = gate();
    const released = gate();
    let hold = false;
    const { t, run, client, root, sessionId } = await start({ workspaces: { isDirectory: async (path) => {
      if (hold && path === rootToHold) { entered.open(); await released.opened; }
      return true;
    } } });
    const rootToHold = root;
    const link = join(tempDir("agent-harness-preparing-check-"), "project");
    symlinkSync(root, link);
    const sibling = await sessionIn(client, link);
    const firstStarted = nextEvent(t, sessionId, "checks.started");
    const firstId = await turn(t, client, sessionId, async function* (controls) {
      yield* fileTool(controls, { tool: "Write", input: { file_path: join(root, "a.txt") }, paths: [join(root, "a.txt")], write: () => writeFileSync(join(root, "a.txt"), "changed") });
      hold = true;
      yield end();
    });
    await entered.opened;
    const latest = await turn(t, client, sibling, write(join(root, "b.txt")));
    hold = false;
    released.open();
    expect(await firstStarted).toMatchObject({ sourceRunId: firstId });
    const nextStarted = nextEvent(t, sibling, "checks.started");
    (await run.spawnedAt(0)).exit(0);
    expect(await nextStarted).toMatchObject({ sourceRunId: latest });
    await run.spawnedAt(1);
    expect(run.spawned).toHaveLength(2);
  });

  it("rechecks the persisted configuring Client grant after asynchronous availability preparation", async () => {
    const entered = gate();
    const released = gate();
    let hold = false;
    const { t, run, client, root, sessionId } = await start({ workspaces: { isDirectory: async () => {
      if (hold) { entered.open(); await released.opened; }
      return true;
    } } });
    const failed = nextEvent(t, sessionId, "checks.finished");
    const runId = await turn(t, client, sessionId, async function* (controls) {
      yield* fileTool(controls, { tool: "Write", input: { file_path: join(root, "a.txt") }, paths: [join(root, "a.txt")], write: () => writeFileSync(join(root, "a.txt"), "changed") });
      hold = true;
      yield end();
    });
    await entered.opened;
    t.env.clientSessions.revoke(client.hello.clientSessionId);
    hold = false;
    released.open();
    expect(await failed).toMatchObject({ sourceRunId: runId, failure: "launch_failed", output: expect.stringContaining("terminal grant"), offerFailure: true });
    expect(run.spawned).toHaveLength(0);
  });
});
