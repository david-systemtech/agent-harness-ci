import type { TerminalSnapshot } from "@agent-harness/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventEnvelope } from "../event-log/event-log.js";
import type { FeedCatchUp } from "../wire/subscriptions.js";
import { fakePty, type FakeProcess, type FakePty } from "../../test/fake-pty.js";
import { KILL_GRACE_MS, createTerminals, type OpenTerminal, type Terminals } from "./terminals.js";

/**
 * The terminals module against a fake pty (the lower seam): what a
 * subscription's feed answers at every cursor, the gathering of output into
 * chunks, the hang-up and the kill, and a shell that cannot start.
 */

const NOW = new Date("2026-09-24T00:00:00.000Z");
const ID = "0b9c7b8e-4a51-4f0c-9d55-6f1d3c2b7a10";
const SESSION = "5f0e8b2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b";

const request = (overrides: Partial<OpenTerminal> = {}): OpenTerminal => ({
  id: ID,
  sessionId: SESSION,
  cwd: "/work/project",
  cols: 80,
  rows: 24,
  env: {},
  openedAt: NOW.toISOString(),
  ...overrides,
});

const setUp = (gatherMs = 0): { pty: FakePty; terminals: Terminals } => {
  const pty = fakePty();
  const terminals = createTerminals({
    clock: { now: () => NOW, setTimeout: () => ({ cancel: () => undefined }), setInterval: () => ({ cancel: () => undefined }) },
    pty,
    shell: () => ({ file: "/bin/zsh", args: ["-l"] }),
    baseEnvironment: () => ({ TERM: "xterm-256color", PATH: "/usr/bin", HOME: "/home/david", LANG: "C.UTF-8" }),
    gatherMs,
  });
  return { pty, terminals };
};

/** The terminal's feed, for the open terminal `id`. */
const feedOf = (terminals: Terminals, id = ID) => {
  const source = terminals.source(id);
  if (source === undefined) throw new Error(`No terminal ${id}.`);
  return source;
};

const types = (answer: FeedCatchUp<TerminalSnapshot>) => answer.events.map((event) => [event.type, event.sequence]);

afterEach(() => {
  vi.useRealTimers();
});

describe("a terminal's shell", () => {
  it("is the shell asked for, in the workspace, at the size asked for, with SHELL and the client's variables over the base", () => {
    const { pty, terminals } = setUp();
    terminals.open(request({ cols: 120, rows: 40, env: { EDITOR: "vi", PATH: "/opt/bin" } }));
    const [child] = pty.spawned as [FakeProcess];
    expect([child.file, child.args, child.options.cwd, child.options.cols, child.options.rows]).toEqual(["/bin/zsh", ["-l"], "/work/project", 120, 40]);
    expect(child.options.env).toEqual({ TERM: "xterm-256color", PATH: "/opt/bin", HOME: "/home/david", LANG: "C.UTF-8", SHELL: "/bin/zsh", EDITOR: "vi" });
  });

  it("that cannot start leaves a terminal that exited at once, code -1, saying why in its scrollback", () => {
    const { pty, terminals } = setUp();
    pty.failNext = "posix_spawnp failed";
    const info = terminals.open(request());
    expect(info).toMatchObject({ exitCode: -1 });
    const answer = feedOf(terminals).feed.catchUp(0);
    expect(answer.snapshot?.payload.scrollback).toContain("The terminal could not start: posix_spawnp failed");
    expect(types(answer)).toEqual([["terminal.exited", 2]]);
  });
});

describe("a terminal's output", () => {
  it("is gathered for a few milliseconds into one chunk, then published and kept", () => {
    vi.useFakeTimers();
    const { pty, terminals } = setUp(5);
    terminals.open(request());
    const heard: EventEnvelope[] = [];
    feedOf(terminals).feed.subscribe((event) => heard.push(event));
    const [child] = pty.spawned as [FakeProcess];
    child.print("a");
    child.print("b");
    expect(heard).toEqual([]);
    vi.advanceTimersByTime(5);
    expect(heard.map((event) => [event.sequence, event.payload])).toEqual([[1, { data: "ab" }]]);
    expect(heard[0]).toMatchObject({ streamKind: "terminal", streamId: ID, streamVersion: 1, type: "terminal.output", actor: "system:terminals" });
    child.print("c");
    // The exit flushes what was gathered first.
    child.exit(0);
    expect(heard.map((event) => [event.type, event.sequence])).toEqual([
      ["terminal.output", 1],
      ["terminal.output", 2],
      ["terminal.exited", 3],
    ]);
  });
});

describe("a terminal's gathered output", () => {
  it("is cut into a chunk at 64 KiB counted in UTF-8 bytes, not UTF-16 units", () => {
    vi.useFakeTimers();
    const { pty, terminals } = setUp(1000);
    terminals.open(request());
    const heard: EventEnvelope[] = [];
    feedOf(terminals).feed.subscribe((event) => heard.push(event));
    const [child] = pty.spawned as [FakeProcess];
    // 32 Ki two-byte characters: 64 KiB of UTF-8, half that in UTF-16 units.
    child.print("é".repeat(32 * 1024));
    expect(heard).toHaveLength(1);
  });
});

describe("a terminal's feed", () => {
  it("answers cursor 0 with the snapshot, a cursor it reaches with the chunks after it, and a cursor past its end with the snapshot", () => {
    const { pty, terminals } = setUp();
    terminals.open(request());
    const [child] = pty.spawned as [FakeProcess];
    for (const text of ["$ ", "ls\r\n", "a b\r\n$ "]) child.print(text);
    const { feed } = feedOf(terminals);

    const fromStart = feed.catchUp(0);
    expect(fromStart.snapshot).toEqual({
      sequence: 3,
      payload: {
        terminal: { id: ID, sessionId: SESSION, openedAt: NOW.toISOString(), cols: 80, rows: 24, exitCode: null, signal: null },
        scrollback: "$ ls\r\na b\r\n$ ",
        firstSequence: 1,
        lastSequence: 3,
        truncated: false,
      },
    });
    expect(fromStart.events).toEqual([]);

    const fromOne = feed.catchUp(1);
    expect(fromOne.snapshot).toBeUndefined();
    expect(fromOne.events.map((event) => [event.sequence, event.payload["data"]])).toEqual([
      [2, "ls\r\n"],
      [3, "a b\r\n$ "],
    ]);
    expect(feed.catchUp(3)).toEqual({ events: [], sequence: 3 });
    expect(feed.catchUp(9).snapshot?.sequence).toBe(3);
  });

  it("answers the snapshot when the chunks after the cursor pass the replay bound", () => {
    const { pty, terminals } = setUp();
    terminals.open(request());
    const [child] = pty.spawned as [FakeProcess];
    for (let i = 0; i < 1002; i += 1) child.print("x");
    const { feed } = feedOf(terminals);
    expect(feed.catchUp(2).events).toHaveLength(1000);
    expect(feed.catchUp(1).snapshot?.sequence).toBe(1002);
  });

  it("ends every catch-up of an exited terminal with its exit, a cursor at the exit included, and hears nothing after it", () => {
    const { pty, terminals } = setUp();
    terminals.open(request());
    const [child] = pty.spawned as [FakeProcess];
    child.print("bye\r\n");
    child.exit(3, 0);
    const source = feedOf(terminals);
    expect(types(source.feed.catchUp(0))).toEqual([["terminal.exited", 2]]);
    expect(types(source.feed.catchUp(1))).toEqual([["terminal.exited", 2]]);
    expect(types(source.feed.catchUp(2))).toEqual([["terminal.exited", 2]]);
    const [exit] = source.feed.catchUp(2).events as [EventEnvelope];
    expect(exit.payload).toEqual({ exitCode: 3, signal: null, cause: "exited" });
    expect(source.endOn?.(exit)).toBe("closed");
    const heard: EventEnvelope[] = [];
    source.feed.subscribe((event) => heard.push(event));
    child.print("late");
    expect(heard).toEqual([]);
    expect(terminals.info(ID)).toMatchObject({ exitCode: 3, signal: null });
  });
});

describe("closing a terminal", () => {
  it("hangs its shell up, forgets it at once, and kills a shell that lingers past the grace", () => {
    vi.useFakeTimers();
    const { pty, terminals } = setUp();
    terminals.open(request());
    const heard: EventEnvelope[] = [];
    const source = feedOf(terminals);
    source.feed.subscribe((event) => heard.push(event));
    const [child] = pty.spawned as [FakeProcess];

    terminals.close(ID, "closed");

    expect(child.signals).toEqual(["SIGHUP"]);
    expect(terminals.info(ID)).toBeUndefined();
    expect(terminals.list(SESSION)).toEqual([]);
    expect(terminals.used(ID)).toBe(true);
    vi.advanceTimersByTime(KILL_GRACE_MS);
    expect(child.signals).toEqual(["SIGHUP", "SIGKILL"]);
    child.exit(0, 9);
    expect(heard.map((event) => event.payload)).toEqual([{ exitCode: 0, signal: 9, cause: "closed" }]);
    expect(source.endOn?.(heard[0] as EventEnvelope)).toBe("closed");
  });

  it("with its session's deletion closes that session's terminals with cause deleted, and ends their subscriptions deleted", () => {
    const { pty, terminals } = setUp();
    terminals.open(request());
    const other = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const otherSession = "2c4e6a8b-1d3f-4b5a-9c7e-0a2b4c6d8e0f";
    terminals.open(request({ id: other, sessionId: otherSession }));
    const heard: EventEnvelope[] = [];
    const source = feedOf(terminals);
    source.feed.subscribe((event) => heard.push(event));

    terminals.closeSession(SESSION);

    const [mine, theirs] = pty.spawned as [FakeProcess, FakeProcess];
    expect([mine.signals, theirs.signals]).toEqual([["SIGHUP"], []]);
    mine.exit(0, 1);
    expect(heard.map((event) => event.payload)).toEqual([{ exitCode: 0, signal: 1, cause: "deleted" }]);
    expect(source.endOn?.(heard[0] as EventEnvelope)).toBe("deleted");
    expect(terminals.list(otherSession)).toHaveLength(1);
  });
});
