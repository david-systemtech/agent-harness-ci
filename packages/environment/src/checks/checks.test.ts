import { CHECK_OUTPUT_MAX_BYTES, CHECK_TIMEOUT_MS, type EventEnvelope, type EventFrame } from "@agent-harness/contracts";
import { randomUUID } from "node:crypto";
import { realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { fakePty, type FakePty } from "../../test/fake-pty.js";
import { restartAfter, startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { noticesOf } from "../../test/notices.js";
import { follow, openTerminal, sessionIn } from "../../test/terminals.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * Workspace checks (switch-over spec, "Phase-D commands and parity",
 * Checks; #1187) over the typed wire: the directory's command shared by
 * every session and client in it and kept across a restart, and manual
 * checks run in the environment's own terminals, with a fake one-off
 * process port standing in for the shell, so no project command runs.
 */

const { onCleanup, tempDir } = useCleanups();

/** An environment whose one-off commands run through `run`, a fake: what the check's shell is asked to run is recorded, and the test makes it print and exit. */
const start = async (options: TestEnvironmentOptions & { readonly run?: FakePty } = {}): Promise<TestEnvironment & { readonly run: FakePty }> => {
  const run = options.run ?? fakePty();
  const t = await startTestEnvironment({ ...options, terminals: { ...options.terminals, run } });
  onCleanup(() => t.close());
  return { ...t, run };
};

/** Follows the session's stream from now: each next event of a type, as a client subscribed to the session hears it. */
const sessionEvents = async (t: TestEnvironment, client: WireClient, sessionId: string) => {
  const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId, afterSequence: t.env.log.head() });
  return {
    next: async (type: string): Promise<EventEnvelope> =>
      (await client.next((frame): frame is EventFrame => frame.type === "event" && frame.subscription === subscription && frame.event.type === type)).event,
  };
};

/** A session in a directory of the test's own whose check command is `command`: the session, its directory's real path and the client. */
const checkedSession = async (t: TestEnvironment, command: string) => {
  const client = await t.client();
  const dir = tempDir("agent-harness-checks-run-");
  const sessionId = await sessionIn(client, dir);
  await client.apply("checks.set", { commandId: randomUUID(), sessionId, command });
  return { client, sessionId, dir, workspace: realpathSync(dir) };
};

/** The refusal a command's receipt carries: its code and data. */
const refusalOf = (answer: unknown) => {
  const { receipt } = answer as { receipt: { status: string; error?: { code: string; data: Record<string, unknown> } } };
  if (receipt.status !== "rejected" || receipt.error === undefined) throw new Error(`The command was not refused: ${JSON.stringify(receipt)}`);
  return { code: receipt.error.code, data: receipt.error.data };
};

/** A second client session of the environment, as another Client would hold. */
const otherClient = async (t: TestEnvironment): Promise<WireClient> => t.client({ token: (await t.bootstrap("desktop", "the other client")).token });

describe("a Workspace directory's check command", () => {
  it("is one per canonical directory, shared by its sessions and clients, announced by checks.changed naming the caller, and kept across a restart", async () => {
    const t = await start({ dataDir: tempDir("agent-harness-checks-data-") });
    const first = await t.client();
    const second = await otherClient(t);
    const dir = tempDir("agent-harness-checks-");
    const link = join(tempDir("agent-harness-checks-links-"), "project");
    symlinkSync(dir, link);
    const workspace = realpathSync(dir);
    const here = await sessionIn(first, dir);
    const throughLink = await sessionIn(second, link);
    expect(await second.request("checks.get", { sessionId: throughLink })).toEqual({ workspace, command: null });

    const head = t.env.log.head();
    const command = "  pnpm typecheck && pnpm exec vitest run 'a b.test.ts' \\\n  --maxWorkers=2\n";
    expect(await first.apply("checks.set", { commandId: randomUUID(), sessionId: here, command })).toEqual({ workspace, command });
    expect(await second.request("checks.get", { sessionId: throughLink })).toEqual({ workspace, command });
    const notices = await noticesOf(second, "checks.changed", head);
    expect(notices.map(({ payload, actor }) => ({ payload, actor }))).toEqual([{ payload: { workspace, command }, actor: { kind: "client_session", id: first.hello.clientSessionId } }]);

    const back = await restartAfter(t, 0, (options) => start(options));
    expect(await (await back.client()).request("checks.get", { sessionId: here })).toEqual({ workspace, command });
  });
});

describe("a manual check", () => {
  it("runs the directory's command verbatim through terminals.run's one-off shell in the directory, streamed by terminals.subscribe, recording its start and end and starting no run", async () => {
    const t = await start();
    const command = "pnpm typecheck &&\n  pnpm exec vitest run 'a b.test.ts'";
    const { client, sessionId, workspace } = await checkedSession(t, command);
    const events = await sessionEvents(t, client, sessionId);
    const { terminalId } = await client.apply("checks.run", { commandId: randomUUID(), sessionId });
    const view = await follow(client, terminalId);
    expect((await events.next("checks.started")).payload).toEqual({ terminalId, command, sourceRunId: null });

    const shell = await t.run.spawnedAt(0);
    expect([shell.file, shell.args, shell.options.cwd]).toEqual(["/bin/sh", ["-c", command], workspace]);
    shell.print("src/a.ts(1,1): error TS2322\n");
    shell.exit(2);
    await view.until((v) => v.ended !== undefined);
    expect(view.text).toBe("src/a.ts(1,1): error TS2322\n");
    expect((await events.next("checks.finished")).payload).toEqual({
      terminalId,
      command,
      sourceRunId: null,
      output: "src/a.ts(1,1): error TS2322\n",
      truncated: false,
      exitCode: 2,
      signal: null,
      timedOut: false,
      failure: null,
    });
    // Its result kept, the exited terminal is closed: it no longer counts against the session.
    expect(await client.request("terminals.list", { sessionId })).toEqual({ terminals: [] });
    expect(t.adapter.runs).toEqual([]);
  });
});

describe("checks.run's refusals", () => {
  it("refuses check_unset while the directory has no command, cleared included, and check_running while its check runs, from any session or client there", async () => {
    const t = await start();
    const client = await t.client();
    const dir = tempDir("agent-harness-checks-refused-");
    const workspace = realpathSync(dir);
    const sessionId = await sessionIn(client, dir);
    const run = (on: WireClient, session: string) => on.request("checks.run", { commandId: randomUUID(), sessionId: session });
    expect(refusalOf(await run(client, sessionId))).toEqual({ code: "conflict", data: { reason: "check_unset", workspace } });

    await client.apply("checks.set", { commandId: randomUUID(), sessionId, command: "make check" });
    const other = await otherClient(t);
    const sibling = await sessionIn(other, dir);
    const events = await sessionEvents(t, client, sessionId);
    const { terminalId } = await client.apply("checks.run", { commandId: randomUUID(), sessionId });
    expect(refusalOf(await run(other, sibling))).toEqual({ code: "conflict", data: { reason: "check_running", workspace, terminalId } });
    expect(refusalOf(await run(client, sessionId))).toMatchObject({ data: { reason: "check_running" } });

    (await t.run.spawnedAt(0)).exit(0);
    expect((await events.next("checks.finished")).payload).toMatchObject({ terminalId, exitCode: 0, failure: null });
    const again = await other.apply("checks.run", { commandId: randomUUID(), sessionId: sibling });
    (await t.run.spawnedAt(1)).exit(0);

    expect(await other.apply("checks.set", { commandId: randomUUID(), sessionId: sibling, command: null })).toEqual({ workspace, command: null });
    expect(refusalOf(await run(client, sessionId))).toEqual({ code: "conflict", data: { reason: "check_unset", workspace } });
    expect(t.run.spawned.map((shell) => shell.args)).toEqual([["-c", "make check"], ["-c", "make check"]]);
    expect(again.terminalId).not.toBe(terminalId);
  });

  it("refuses a gone workspace and a session holding sixteen terminals, as terminals.run would, running nothing", async () => {
    const t = await start({ terminals: { pty: fakePty() } });
    const { client, sessionId, dir } = await checkedSession(t, "make check");
    for (let i = 0; i < 16; i++) await openTerminal(client, sessionId);
    expect(refusalOf(await client.request("checks.run", { commandId: randomUUID(), sessionId }))).toMatchObject({ code: "conflict", data: { reason: "too_many_terminals", limit: 16 } });

    rmSync(dir, { recursive: true });
    const missing = { code: "conflict", data: { reason: "workspace_missing", path: dir } };
    expect(refusalOf(await client.request("checks.run", { commandId: randomUUID(), sessionId }))).toEqual(missing);
    expect(refusalOf(await client.request("checks.set", { commandId: randomUUID(), sessionId, command: "make other" }))).toEqual(missing);
    // The directory gone, get answers the path the session recorded and that path's command.
    expect(await client.request("checks.get", { sessionId })).toEqual({ workspace: dir, command: "make check" });
    expect(t.run.spawned).toEqual([]);

    const unknown = randomUUID();
    expect(refusalOf(await client.request("checks.run", { commandId: randomUUID(), sessionId: unknown }))).toEqual({ code: "not_found", data: { kind: "session", sessionId: unknown } });
  });
});

describe("how a check ends", () => {
  it("closes its terminal after 120 seconds on the environment's clock, recording the timeout with no exit", async () => {
    const t = await start();
    const command = "pnpm exec vitest --watch";
    const { client, sessionId } = await checkedSession(t, command);
    const events = await sessionEvents(t, client, sessionId);
    const { terminalId } = await client.apply("checks.run", { commandId: randomUUID(), sessionId });
    const shell = await t.run.spawnedAt(0);
    shell.print("watching for changes\n");
    t.clock.advance(CHECK_TIMEOUT_MS - 1);
    expect(shell.signals).toEqual([]);
    t.clock.advance(1);
    // Closed as terminals.close closes one: hung up.
    expect(shell.signals).toEqual(["SIGHUP"]);
    shell.exit(0, 1);
    expect((await events.next("checks.finished")).payload).toEqual({
      terminalId,
      command,
      sourceRunId: null,
      output: "watching for changes\n",
      truncated: false,
      exitCode: null,
      signal: null,
      timedOut: true,
      failure: null,
    });
  });

  it("keeps the last 64 KiB of its output, whole characters, scrubbed of values registered before and while it ran, and marks the cut", async () => {
    const t = await start();
    t.scrub.register("value-for-check-tests-early", { owner: "test:checks" });
    const { client, sessionId } = await checkedSession(t, "make check");
    const events = await sessionEvents(t, client, sessionId);
    await client.apply("checks.run", { commandId: randomUUID(), sessionId });
    const shell = await t.run.spawnedAt(0);
    shell.print("token value-for-check-tests-early\n");
    shell.print("€".repeat(30_000));
    shell.print("later value-for-check-tests-late\n");
    t.scrub.register("value-for-check-tests-late", { owner: "test:checks" });
    shell.exit(1);
    const finished = (await events.next("checks.finished")).payload;
    // "later [redacted]\n" is 17 bytes; the rest of the 64 KiB would start inside a three-byte character, so it starts at the next.
    const tail = "later [redacted]\n";
    expect(finished).toMatchObject({ truncated: true, exitCode: 1, output: "€".repeat(Math.floor((CHECK_OUTPUT_MAX_BYTES - 17) / 3)) + tail });
  });

  it("records a command that could not start as a launch failure with no exit, and a terminal closed under it as closed", async () => {
    const t = await start();
    const { client, sessionId } = await checkedSession(t, "make check");
    const events = await sessionEvents(t, client, sessionId);
    t.run.failNext = "spawn /bin/sh ENOENT";
    await client.apply("checks.run", { commandId: randomUUID(), sessionId });
    expect((await events.next("checks.finished")).payload).toMatchObject({
      output: expect.stringContaining("could not start"),
      exitCode: null,
      signal: null,
      timedOut: false,
      failure: "launch_failed",
    });

    const { terminalId } = await client.apply("checks.run", { commandId: randomUUID(), sessionId });
    const shell = await t.run.spawnedAt(0);
    await client.apply("terminals.close", { commandId: randomUUID(), id: terminalId });
    shell.exit(0, 1);
    expect((await events.next("checks.finished")).payload).toMatchObject({ terminalId, exitCode: null, signal: null, timedOut: false, failure: "closed" });
    // The directory is free again.
    await client.apply("checks.run", { commandId: randomUUID(), sessionId });
  });

  it("answers a retried command from its receipt, opening nothing again", async () => {
    const t = await start();
    const { client, sessionId } = await checkedSession(t, "make check");
    const params = { commandId: randomUUID(), sessionId };
    const first = await client.request("checks.run", params);
    const shell = await t.run.spawnedAt(0);
    shell.exit(0);
    expect(await client.request("checks.run", params)).toEqual({ receipt: (first as { receipt: unknown }).receipt });
    expect(t.run.spawned).toHaveLength(1);
  });
});
