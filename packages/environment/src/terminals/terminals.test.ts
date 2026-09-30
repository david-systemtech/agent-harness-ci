import { randomUUID } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Ceiling, registry, type EventFrame, type Scope } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { fakePty } from "../../test/fake-pty.js";
import { deleteSession } from "../../test/sessions.js";
import {
  follow,
  openTerminal,
  pollScrollback,
  refusedWith,
  sessionIn,
  terminalCommand,
  typeInto,
  waitForOutput,
} from "../../test/terminals.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * Terminals through the primary seam (tui spec, "Terminal vocabulary
 * tests"; #124): an in-process environment and a real client over a real
 * WebSocket, with real pseudo-terminals running `/bin/sh` (the login shell's
 * own resolution has unit tests; CI's may be anything). Output is waited on
 * by a marker the shell computes (`echo done-$((1+1))` prints `done-2`), so
 * the terminal's echo of the typed line never satisfies the wait.
 */

const { onCleanup, tempDir } = useCleanups();

/** A plain interactive `/bin/sh`: no profile, so the prompt and the environment are the test's. */
const SH = { file: "/bin/sh", args: [] } as const;

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ terminals: { shell: () => SH }, ...options });
  onCleanup(() => t.close());
  return t;
};

/** An environment, its default client, and a session in a directory of the test's own. */
const setUp = async (options: TestEnvironmentOptions = {}) => {
  const t = await start(options);
  const client = await t.client();
  const dir = tempDir("agent-harness-terminal-");
  const sessionId = await sessionIn(client, dir);
  return { t, client, dir, sessionId };
};

/** A client session issued straight from the environment, holding only `scopes`. */
const narrowClient = (t: TestEnvironment, scopes: Scope[]): Promise<WireClient> =>
  t.client({ token: t.env.clientSessions.issue({ kind: "program", label: "a narrow program", scopes, ceiling: Ceiling.parse("acceptEdits") }).token });

describe("terminals.open", () => {
  it("starts a shell in the workspace directory at 80 by 24 and answers the terminal, with a receipt that changed nothing in the log", async () => {
    const { t, client, dir, sessionId } = await setUp();
    const id = randomUUID();
    const head = t.env.log.head();

    const answer = await terminalCommand(client, "terminals.open", { id, sessionId });

    expect(answer).toEqual({
      receipt: { status: "accepted", sequence: head, changed: false },
      result: { terminal: { id, owner: "session", sessionId, openedAt: MANUAL_CLOCK_START, cols: 80, rows: 24, exitCode: null, signal: null } },
    });
    await typeInto(client, id, "pwd; echo done-$((1+1))\r");
    const view = await waitForOutput(client, id, "done-2");
    expect(view.text).toContain(realpathSync(dir));
    expect(t.env.log.head()).toBe(head);
  });

  it("opens at the size asked for, with the variables asked for on a clean base and never the environment's own", async () => {
    const secret = "AGENT_HARNESS_TEST_SECRET";
    process.env[secret] = "the environment's own";
    onCleanup(() => void delete process.env[secret]);
    const { client, sessionId } = await setUp();

    const terminal = await openTerminal(client, sessionId, { cols: 100, rows: 30, env: { HARNESS_CLIENT_VAR: "from the client" } });

    expect([terminal.cols, terminal.rows]).toEqual([100, 30]);
    await typeInto(client, terminal.id, `stty size; echo "[$${secret}][$HARNESS_CLIENT_VAR][$TERM][$HOME]"; echo done-$((1+1))\r`);
    const view = await waitForOutput(client, terminal.id, "done-2");
    expect(view.text).toContain("30 100");
    expect(view.text).toContain(`[][from the client][xterm-256color][${homedir()}]`);
  });

  it("applies a retried command once: the same command id answers the stored receipt and opens nothing more", async () => {
    const { client, sessionId } = await setUp();
    const commandId = randomUUID();
    const id = randomUUID();
    const first = await terminalCommand(client, "terminals.open", { commandId, id, sessionId });
    const again = await terminalCommand(client, "terminals.open", { commandId, id, sessionId });
    expect(again).toEqual({ receipt: first.receipt });
    expect((await client.request("terminals.list", { sessionId })).terminals.map((terminal) => terminal.id)).toEqual([id]);
  });

  it("refuses an id used before conflict, reason exists, even once that terminal is closed", async () => {
    const { client, sessionId } = await setUp();
    const { id } = await openTerminal(client, sessionId);
    const answer = await terminalCommand(client, "terminals.open", { id, sessionId });
    expect(answer.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "exists", id } } });
    await terminalCommand(client, "terminals.close", { id });
    const reopened = await terminalCommand(client, "terminals.open", { id, sessionId });
    expect(reopened.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "exists" } } });
  });

  it("refuses an id used before a restart of the environment conflict, reason exists, while its receipts are kept", async () => {
    const dataDir = join(tempDir("agent-harness-terminal-data-"), "data");
    const first = await startTestEnvironment({ dataDir, terminals: { shell: () => SH } });
    let client = await first.client();
    const sessionId = await sessionIn(client, tempDir("agent-harness-terminal-"));
    const { id } = await openTerminal(client, sessionId);
    await first.close();

    const second = await start({ dataDir });
    client = await second.client();
    const answer = await terminalCommand(client, "terminals.open", { id, sessionId });
    expect(answer.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "exists", id } } });
    // An id whose only receipt is a rejection was never opened, and may be.
    const unknownSession = randomUUID();
    const refused = randomUUID();
    await terminalCommand(client, "terminals.open", { id: refused, sessionId: unknownSession });
    expect((await terminalCommand(client, "terminals.open", { id: refused, sessionId })).receipt).toMatchObject({ status: "accepted" });
  });

  it("refuses a seventeenth terminal on one session conflict, reason too_many_terminals, exited ones counted until closed", async () => {
    const { client, sessionId } = await setUp({ terminals: { shell: () => SH, pty: fakePty() } });
    const opened = [];
    for (let i = 0; i < 16; i += 1) opened.push(await openTerminal(client, sessionId));
    const refused = await terminalCommand(client, "terminals.open", { id: randomUUID(), sessionId });
    expect(refused.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "too_many_terminals", limit: 16 } } });
    // Another session has its own sixteen; closing one frees a place.
    await openTerminal(client, await sessionIn(client, tempDir("agent-harness-terminal-")));
    await terminalCommand(client, "terminals.close", { id: (opened[0] as { id: string }).id });
    await openTerminal(client, sessionId);
  });

  it("refuses a session that is not on this environment not_found, kind session", async () => {
    const { t, client } = await setUp();
    const sessionId = randomUUID();
    const head = t.env.log.head();
    const answer = await terminalCommand(client, "terminals.open", { id: randomUUID(), sessionId });
    expect(answer.receipt).toEqual({
      status: "rejected",
      sequence: head,
      changed: false,
      reason: "not_found",
      error: { code: "not_found", message: expect.any(String), data: { kind: "session", sessionId } },
    });
  });

  it("refuses conflict, reason pty_unavailable, on an environment that cannot start a pseudo-terminal, and opens nothing", async () => {
    const pty = fakePty();
    pty.unavailable = true;
    const { client, sessionId } = await setUp({ terminals: { pty } });
    const answer = await terminalCommand(client, "terminals.open", { id: randomUUID(), sessionId });
    expect(answer.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "pty_unavailable" } } });
    expect(pty.spawned).toEqual([]);
    expect((await client.request("terminals.list", { sessionId })).terminals).toEqual([]);
  });

  it("accepts the open and then shows a spawn that fails after the commit as an exit with cause failed, with no unhandled rejection", async () => {
    const pty = fakePty();
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => void rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    onCleanup(() => void process.off("unhandledRejection", onRejection));
    const { client, sessionId } = await setUp({ terminals: { shell: () => SH, pty } });
    pty.failNext = "posix_spawnp failed";

    const answer = await terminalCommand(client, "terminals.open", { id: randomUUID(), sessionId });

    expect(answer.receipt.status).toBe("accepted");
    const id = answer.result?.terminal.id as string;
    const view = await follow(client, id, 0);
    await view.until((v) => v.ended !== undefined);
    expect(view.snapshot?.scrollback).toContain("posix_spawnp failed");
    expect(view.exited).toEqual({ exitCode: -1, signal: null, cause: "failed" });
    expect((await client.request("terminals.list", { sessionId })).terminals).toMatchObject([{ id, exitCode: -1 }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rejections).toEqual([]);
  });

  it("keeps the terminal's commands and subscription sent right after it behind it while it looks at the workspace: they find the terminal (#669)", async () => {
    const pty = fakePty();
    let answerLook: (there: boolean) => void = () => undefined;
    let lookAsked: () => void = () => undefined;
    const lookedAt = new Promise<void>((resolve) => (lookAsked = resolve));
    const t = await start({
      terminals: { pty },
      workspaces: {
        isDirectory: () => {
          lookAsked();
          return new Promise<boolean>((resolve) => (answerLook = resolve));
        },
      },
    });
    await t.env.workspaces.availabilityPass;
    const client = await t.client();
    const sessionId = await sessionIn(client, tempDir("agent-harness-terminal-"));
    const id = randomUUID();

    const opening = terminalCommand(client, "terminals.open", { id, sessionId });
    await lookedAt;
    const writing = terminalCommand(client, "terminals.write", { id, data: "echo one\r" });
    const resizing = terminalCommand(client, "terminals.resize", { id, cols: 100, rows: 30 });
    const subscribing = client.subscribe("terminals.subscribe", { id, afterSequence: 0 });
    // Answered behind them on the socket while they wait: nothing is open yet.
    expect((await client.request("terminals.list", { sessionId })).terminals).toEqual([]);
    answerLook(true);

    expect((await opening).receipt).toMatchObject({ status: "accepted" });
    expect((await writing).receipt).toMatchObject({ status: "accepted" });
    expect((await resizing).result?.terminal).toMatchObject({ id, cols: 100, rows: 30 });
    expect(await subscribing).toMatchObject({ type: "subscribed" });
    expect(pty.spawned).toHaveLength(1);
    expect(pty.spawned[0]?.written).toEqual(["echo one\r"]);
    expect((await client.request("terminals.list", { sessionId })).terminals).toMatchObject([{ id, cols: 100, rows: 30 }]);
  });

  it("refuses a workspace directory that is gone conflict, reason workspace_missing", async () => {
    const { client } = await setUp();
    // The environment refuses a session in a directory that is not there, so this one goes after the session is made.
    const gone = tempDir("agent-harness-terminal-");
    const sessionId = await sessionIn(client, gone);
    rmSync(gone, { recursive: true });
    const answer = await terminalCommand(client, "terminals.open", { id: randomUUID(), sessionId });
    expect(answer.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "workspace_missing" } } });
  });
});

describe("terminals.subscribe", () => {
  it("sends the snapshot of the retained scrollback, synchronized, then the output live as terminal.output events, and the log's head never moves", async () => {
    const { t, client, sessionId } = await setUp();
    const { id } = await openTerminal(client, sessionId);
    await typeInto(client, id, "echo first-$((1+1))\r");
    await waitForOutput(client, id, "first-2");
    const head = t.env.log.head();

    const view = await follow(client, id, 0);
    await view.until((v) => v.synchronized);
    expect(view.frames.map((frame) => frame.type)).toEqual(["snapshot", "synchronized"]);
    expect(view.snapshot?.terminal).toMatchObject({ id, sessionId, exitCode: null });
    expect(view.snapshot?.scrollback).toContain("first-2");
    expect(view.snapshot?.truncated).toBe(false);
    expect(view.snapshot?.firstSequence).toBe(1);
    expect(view.frames[0]).toMatchObject({ type: "snapshot", sequence: view.snapshot?.lastSequence });

    await typeInto(client, id, "echo live-$((40+2))\r");
    await view.until((v) => v.text.includes("live-42"));
    const events = view.frames.filter((frame): frame is EventFrame => frame.type === "event");
    expect(events.length).toBeGreaterThan(0);
    const firstLive = events[0] as EventFrame;
    expect(firstLive.sequence).toBe((view.snapshot?.lastSequence ?? 0) + 1);
    expect(firstLive.event).toMatchObject({
      streamKind: "terminal",
      streamId: id,
      type: "terminal.output",
      sequence: firstLive.sequence,
      streamVersion: firstLive.sequence,
      actor: { kind: "system", id: "terminals" },
      commandId: null,
    });
    // Consecutive, each once.
    expect(events.map((frame) => frame.sequence)).toEqual(events.map((_, i) => firstLive.sequence + i));
    // Output is never an event of the log.
    expect(t.env.log.head()).toBe(head);
    expect(t.env.log.readStream({ kind: "terminal", id })).toEqual([]);
  });

  it("replays from a cursor what a client missed while it was gone, and the terminal outlives the client", async () => {
    const { t, sessionId } = await setUp();
    const first = await t.client();
    const { id } = await openTerminal(first, sessionId);
    await typeInto(first, id, "echo before-$((1+1))\r");
    const seen = await waitForOutput(first, id, "before-2");
    const cursor = seen.cursor;
    await first.close();

    const second = await t.client();
    expect((await second.request("terminals.list", { sessionId })).terminals).toMatchObject([{ id, exitCode: null }]);
    await typeInto(second, id, "echo missed-$((1+2))\r");
    await waitForOutput(second, id, "missed-3");

    const resumed = await follow(second, id, cursor);
    await resumed.until((v) => v.synchronized);
    expect(resumed.snapshot).toBeUndefined();
    expect(resumed.frames[0]).toMatchObject({ type: "event", sequence: cursor + 1 });
    expect(resumed.text).toContain("missed-3");
    expect(resumed.text).not.toContain("before-2");
  });

  it("sends what the terminal printed while a catch-up was held in that catch-up, before synchronized, and no chunk twice or ahead of it", async () => {
    // Holds every catch-up after its live feed is attached, until released.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reach: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => (reach = resolve));
    const pty = fakePty();
    const { client, sessionId } = await setUp({
      terminals: { shell: () => SH, pty, gatherMs: 0 },
      subscriptionHooks: {
        beforeCatchUp: async () => {
          reach();
          await gate;
        },
      },
    });
    const { id } = await openTerminal(client, sessionId);
    const shell = pty.spawned[0];
    if (shell === undefined) throw new Error("No shell was spawned.");
    shell.print("one\r\n");
    const following = follow(client, id, 1);
    await reached;
    // Heard by the live feed while the catch-up waits, and held in the scrollback the catch-up reads.
    shell.print("two\r\n");
    release();
    const view = await following;
    await view.until((v) => v.synchronized);
    shell.print("three\r\n");
    await view.until((v) => v.text.includes("three"));
    expect(view.frames.map((frame) => (frame.type === "event" ? frame.sequence : frame.type))).toEqual([2, "synchronized", 3]);
    expect(view.text).toBe("two\r\nthree\r\n");
  });

  it("refuses an unknown terminal not_found, kind terminal", async () => {
    const { client } = await setUp();
    const id = randomUUID();
    const error = await refusedWith(client.subscribe("terminals.subscribe", { id, afterSequence: 0 }));
    expect([error.code, error.data]).toEqual(["not_found", { kind: "terminal", id }]);
  });
});

describe("a terminal's scrollback", () => {
  it("holds at most 5,000 lines: the snapshot at the cap is only the retained tail, and a cursor it no longer reaches gets it too", async () => {
    const { client, sessionId } = await setUp();
    const { id } = await openTerminal(client, sessionId);
    // The prompt, before anything is typed: a cursor the flood will leave behind.
    const prompt = await follow(client, id, 0);
    await prompt.until((v) => v.text.length > 0, "the prompt");
    const cursor = prompt.cursor;
    await typeInto(client, id, "i=0; while [ $i -lt 6000 ]; do echo line-$i; i=$((i+1)); done; echo done-$((1+1))\r");

    const snapshot = await pollScrollback(client, id, "done-2");

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.scrollback.split("\n").length).toBeLessThanOrEqual(5000);
    expect(snapshot.scrollback).toContain("line-5999\r\n");
    expect(snapshot.scrollback).not.toContain("line-999\r\n");
    expect(snapshot.firstSequence).toBeGreaterThan(cursor);
    // A client whose cursor is older than the retained tail is sent the snapshot, which says output was dropped.
    const stale = await follow(client, id, cursor);
    await stale.until((v) => v.synchronized);
    expect(stale.frames[0]?.type).toBe("snapshot");
    expect(stale.snapshot?.truncated).toBe(true);
  });

  it("holds at most 8 MiB, however few the lines", async () => {
    const { client, sessionId } = await setUp();
    const { id } = await openTerminal(client, sessionId);
    await typeInto(client, id, "head -c 9437184 /dev/zero | tr '\\0' x; echo; echo done-$((2+2))\r");

    const snapshot = await pollScrollback(client, id, "done-4");

    expect(snapshot.truncated).toBe(true);
    expect(Buffer.byteLength(snapshot.scrollback, "utf8")).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(Buffer.byteLength(snapshot.scrollback, "utf8")).toBeGreaterThan(7 * 1024 * 1024);
    expect(snapshot.scrollback.slice(-40)).toContain("done-4\r\n");
  }, 90_000);
});

describe("terminals.write and terminals.resize", () => {
  it("resizes the terminal: the shell sees the new size, and list shows it", async () => {
    const { client, sessionId } = await setUp();
    const { id } = await openTerminal(client, sessionId);
    const answer = await terminalCommand(client, "terminals.resize", { id, cols: 132, rows: 43 });
    expect(answer.result?.terminal).toMatchObject({ id, cols: 132, rows: 43 });
    await typeInto(client, id, "stty size; echo done-$((1+1))\r");
    expect((await waitForOutput(client, id, "done-2")).text).toContain("43 132");
    expect((await client.request("terminals.list", { sessionId })).terminals).toMatchObject([{ id, cols: 132, rows: 43 }]);
  });

  it("refuses a terminal that is not open not_found, kind terminal, in a receipt", async () => {
    const { client } = await setUp();
    const id = randomUUID();
    for (const answer of [
      await terminalCommand(client, "terminals.write", { id, data: "ls\r" }),
      await terminalCommand(client, "terminals.resize", { id, cols: 10, rows: 10 }),
      await terminalCommand(client, "terminals.close", { id }),
    ]) {
      expect(answer.receipt).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "terminal", id } } });
    }
  });
});

describe("a terminal's end", () => {
  it("is terminal.exited with the exit code when the shell exits, then end closed; it stays listed with its code and refuses writes conflict, reason exited", async () => {
    const { client, sessionId } = await setUp();
    const { id } = await openTerminal(client, sessionId);
    const view = await follow(client, id, 0);
    await view.until((v) => v.synchronized);

    await typeInto(client, id, "exit 7\r");
    await view.until((v) => v.ended !== undefined);

    expect(view.exited).toEqual({ exitCode: 7, signal: null, cause: "exited" });
    expect(view.ended).toBe("closed");
    // The exit takes the sequence after the last output's.
    const events = view.frames.filter((frame): frame is EventFrame => frame.type === "event");
    const exitedFrame = events.at(-1);
    expect(exitedFrame?.event.type).toBe("terminal.exited");
    expect(exitedFrame?.sequence).toBe((events.at(-2)?.sequence ?? view.snapshot?.lastSequence ?? 0) + 1);
    expect((await client.request("terminals.list", { sessionId })).terminals).toMatchObject([{ id, exitCode: 7 }]);
    const write = await terminalCommand(client, "terminals.write", { id, data: "ls\r" });
    expect(write.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "exited", id } } });

    // A subscription after the end is its scrollback, the exit, and the end.
    const late = await follow(client, id, 0);
    await late.until((v) => v.ended !== undefined);
    expect(late.frames.map((frame) => (frame.type === "event" ? frame.event.type : frame.type))).toEqual(["snapshot", "terminal.exited", "end"]);
    expect(late.snapshot?.terminal.exitCode).toBe(7);
    expect(late.ended).toBe("closed");
  });

  it("drops an exited terminal's scrollback ten minutes after the exit, keeping it listed with its exit code until it is closed", async () => {
    const { t, client, sessionId } = await setUp();
    const { id } = await openTerminal(client, sessionId);
    await typeInto(client, id, "echo kept-$((1+1)); exit 4\r");
    const view = await follow(client, id, 0);
    await view.until((v) => v.ended !== undefined);
    expect(view.text).toContain("kept-2");

    t.clock.advance(10 * 60 * 1000 - 1);
    const before = await follow(client, id, 0);
    await before.until((v) => v.ended !== undefined);
    expect(before.snapshot?.scrollback).toContain("kept-2");
    t.clock.advance(1);

    const after = await follow(client, id, 0);
    await after.until((v) => v.ended !== undefined);
    expect(after.snapshot).toMatchObject({ scrollback: "", firstSequence: 0, truncated: true, terminal: { exitCode: 4 } });
    expect(after.exited).toMatchObject({ exitCode: 4, cause: "exited" });
    expect((await client.request("terminals.list", { sessionId })).terminals).toMatchObject([{ id, exitCode: 4 }]);
  });

  it("is terminals.close: the shell is hung up, a subscriber hears terminal.exited with cause closed and end closed, and the terminal leaves the list", async () => {
    const { client, sessionId } = await setUp();
    const { id } = await openTerminal(client, sessionId);
    const view = await follow(client, id, 0);
    await view.until((v) => v.synchronized);

    const answer = await terminalCommand(client, "terminals.close", { id });

    expect(answer.result).toEqual({ id });
    await view.until((v) => v.ended !== undefined);
    expect(view.exited).toMatchObject({ cause: "closed" });
    expect(view.ended).toBe("closed");
    expect((await client.request("terminals.list", { sessionId })).terminals).toEqual([]);
    const write = await terminalCommand(client, "terminals.write", { id, data: "ls\r" });
    expect(write.receipt).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "terminal" } } });
  });

  it("comes with the session's deletion: every terminal of it closes, its subscribers end deleted, and another session's terminal runs on", async () => {
    const { t, client, sessionId } = await setUp();
    const kept = await sessionIn(client, tempDir("agent-harness-terminal-"));
    const one = await openTerminal(client, sessionId);
    const two = await openTerminal(client, sessionId);
    const other = await openTerminal(client, kept);
    const view = await follow(client, one.id, 0);
    await view.until((v) => v.synchronized);

    await deleteSession(client, sessionId);

    await view.until((v) => v.ended !== undefined);
    expect(view.exited).toMatchObject({ cause: "deleted" });
    expect(view.ended).toBe("deleted");
    for (const id of [one.id, two.id]) {
      const error = await refusedWith(client.subscribe("terminals.subscribe", { id, afterSequence: 0 }));
      expect(error.code).toBe("not_found");
    }
    const listed = await refusedWith(client.request("terminals.list", { sessionId }));
    expect([listed.code, listed.data]).toEqual(["not_found", { kind: "session", sessionId }]);
    expect((await client.request("terminals.list", { sessionId: kept })).terminals).toMatchObject([{ id: other.id, exitCode: null }]);
    // Terminal commands on the deleted session are not_found.
    const head = t.env.log.head();
    const open = await terminalCommand(client, "terminals.open", { id: randomUUID(), sessionId });
    expect(open.receipt).toMatchObject({ status: "rejected", sequence: head, reason: "not_found", error: { data: { kind: "session", sessionId } } });
    const write = await terminalCommand(client, "terminals.write", { id: two.id, data: "ls\r" });
    expect(write.receipt).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "terminal" } } });
  });
});

describe("a terminal and the idle rule", () => {
  /** The environment's activity once `condition` holds of it, polled in real time: a shell takes its time to start a command, and to stop it. */
  const activityOnce = async (client: WireClient, condition: (activity: unknown) => boolean) => {
    let activity: unknown;
    await vi.waitFor(
      async () => {
        activity = (await client.request("environment.status", {})).activity;
        expect(condition(activity)).toBe(true);
      },
      { timeout: 10_000, interval: 50 },
    );
    return activity;
  };

  it("holds the environment busy while its shell runs a command in its foreground, and nothing once the shell is back at its prompt", async () => {
    const { client, sessionId } = await setUp();
    const { id } = await openTerminal(client, sessionId);
    await typeInto(client, id, "echo ready-$((1+1))\r");
    await waitForOutput(client, id, "ready-2");
    expect((await client.request("environment.status", {})).activity).toEqual({ state: "idle" });

    await typeInto(client, id, "sleep 30\r");
    expect(await activityOnce(client, (activity) => JSON.stringify(activity) !== JSON.stringify({ state: "idle" }))).toEqual({ state: "busy", reason: "terminal-running" });

    // Interrupted, the command ends and the shell holds its prompt again.
    await typeInto(client, id, "\u0003");
    expect(await activityOnce(client, (activity) => JSON.stringify(activity) === JSON.stringify({ state: "idle" }))).toEqual({ state: "idle" });
  });
});

describe("terminals.list", () => {
  it("lists the session's terminals oldest first with id, opened-at, size and exit code, and none of another session's", async () => {
    const { t, client, sessionId } = await setUp();
    const other = await sessionIn(client, tempDir("agent-harness-terminal-"));
    const first = await openTerminal(client, sessionId);
    t.clock.advance(1000);
    const second = await openTerminal(client, sessionId, { cols: 120, rows: 40 });
    await openTerminal(client, other);

    expect(await client.request("terminals.list", { sessionId })).toEqual({ terminals: [first, second] });
    expect(second.openedAt).toBe(new Date(Date.parse(MANUAL_CLOCK_START) + 1000).toISOString());
  });
});

describe("the terminal scope", () => {
  it("is required by every terminal, file and diff method: a client session without it is refused forbidden, on requests and on the stream", async () => {
    const { t, client, sessionId } = await setUp();
    const { id } = await openTerminal(client, sessionId);
    const narrow = await narrowClient(t, ["read", "sessions:write", "runs:drive", "admin"]);
    const params: Record<string, Record<string, unknown>> = {
      "terminals.open": { commandId: randomUUID(), id: randomUUID(), sessionId },
      "terminals.write": { commandId: randomUUID(), id, data: "ls\r" },
      "terminals.resize": { commandId: randomUUID(), id, cols: 90, rows: 30 },
      "terminals.close": { commandId: randomUUID(), id },
      "terminals.list": { sessionId },
      "files.list": { sessionId },
      "files.read": { sessionId, path: "a.txt" },
      "diffs.workingTree": { sessionId },
      "diffs.session": { sessionId },
    };
    const head = t.env.log.head();
    for (const [method, param] of Object.entries(params)) {
      expect(registry[method as keyof typeof registry].scope, method).toBe("terminal");
      const error = await refusedWith(narrow.request(method, param));
      expect([error.code, error.data], method).toEqual(["forbidden", { scope: "terminal" }]);
    }
    const stream = await refusedWith(narrow.subscribe("terminals.subscribe", { id, afterSequence: 0 }));
    expect([stream.code, stream.data]).toEqual(["forbidden", { scope: "terminal" }]);
    expect(t.env.log.head()).toBe(head);
    // The terminal is untouched: still listed, still 80 by 24.
    expect((await client.request("terminals.list", { sessionId })).terminals).toMatchObject([{ id, cols: 80, rows: 24, exitCode: null }]);
    // With the scope alone, a client may use a terminal.
    const terminalOnly = await narrowClient(t, ["terminal"]);
    expect((await terminalOnly.request("terminals.list", { sessionId })).terminals).toHaveLength(1);
  });
});
