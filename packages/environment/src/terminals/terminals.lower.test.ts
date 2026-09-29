import type { TerminalSnapshot } from "@agent-harness/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventEnvelope } from "../event-log/event-log.js";
import type { FeedCatchUp } from "../wire/subscriptions.js";
import { fakePty, type FakeProcess, type FakePty } from "../../test/fake-pty.js";
import { gate } from "../../test/fake-adapter.js";
import { createScrubRegistry } from "../scrub/registry.js";
import { runsCommand } from "./pty.js";
import type { ProcessEnvironment } from "../adapter/contract.js";
import { KILL_GRACE_MS, createTerminals, type OpenTerminal, type Terminals, type TerminalsOptions } from "./terminals.js";

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

const setUp = (gatherMs = 0, extra: Partial<TerminalsOptions> = {}): { pty: FakePty; terminals: Terminals } => {
  const pty = fakePty();
  const terminals = createTerminals({
    clock: { now: () => NOW, setTimeout: () => ({ cancel: () => undefined }), setInterval: () => ({ cancel: () => undefined }) },
    scrub: createScrubRegistry(),
    pty,
    shell: () => ({ file: "/bin/zsh", args: ["-l"] }),
    baseEnvironment: () => ({ TERM: "xterm-256color", PATH: "/usr/bin", HOME: "/home/david", LANG: "C.UTF-8" }),
    gatherMs,
    ...extra,
  });
  return { pty, terminals };
};

/**
 * Terminals whose process environment supplies `variables` when `held`
 * opens (at once without one), recording the session each was built for
 * and how many times each supply was released.
 */
const holding = (variables: Readonly<Record<string, string>>, held?: Promise<void>) => {
  const asked = { sessions: [] as string[], releases: [] as number[] };
  const processEnvironment = (sessionId: string): ProcessEnvironment => {
    asked.sessions.push(sessionId);
    return {
      key: "test",
      supply: async () => {
        await held;
        const spawn = asked.releases.push(0) - 1;
        return { variables, release: () => void (asked.releases[spawn] = (asked.releases[spawn] ?? 0) + 1) };
      },
    };
  };
  return { ...setUp(0, { processEnvironment }), asked };
};

/** Resolves once the fake pty has started `count` shells. */
const spawned = async (pty: FakePty, count = 1): Promise<FakeProcess[]> => {
  await vi.waitFor(() => expect(pty.spawned).toHaveLength(count));
  return pty.spawned;
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

describe("a terminal as a holder of its session's process environment (#307)", () => {
  it("asks it as the terminal opens, starts the shell in its variables over the clean base and under the client's, and releases them once as it closes", async () => {
    const { pty, terminals, asked } = holding({ HARNESS_TEST_TOKEN: "token-for-tests", PATH: "/supplied/bin", EDITOR: "nano" });

    terminals.open(request({ env: { EDITOR: "vi" } }));

    const [child] = (await spawned(pty)) as [FakeProcess];
    expect(asked.sessions).toEqual([SESSION]);
    expect(child.options.env).toEqual({ TERM: "xterm-256color", PATH: "/supplied/bin", HOME: "/home/david", LANG: "C.UTF-8", SHELL: "/bin/zsh", HARNESS_TEST_TOKEN: "token-for-tests", EDITOR: "vi" });
    expect(JSON.stringify([child.file, child.args])).not.toContain("token-for-tests");
    expect(asked.releases).toEqual([0]);
    terminals.close(ID, "closed");
    expect(asked.releases).toEqual([1]);
    child.exit(0, 1);
    expect(asked.releases).toEqual([1]);
  });

  it("releases them once when its shell exits on its own, and not again as the terminal is closed", async () => {
    const { pty, terminals, asked } = holding({ HARNESS_TEST_TOKEN: "token-for-tests" });
    terminals.open(request());
    const [child] = (await spawned(pty)) as [FakeProcess];

    child.exit(0);
    terminals.close(ID, "closed");

    expect(asked.releases).toEqual([1]);
  });

  it("types what was written, and takes the size set, before its shell started, once it starts", async () => {
    const supplied = gate();
    const { pty, terminals } = holding({ HARNESS_TEST_TOKEN: "token-for-tests" }, supplied.opened);
    terminals.open(request());

    terminals.write(ID, "echo one\r");
    terminals.resize(ID, 132, 50);
    terminals.write(ID, "echo two\r");
    expect(pty.spawned).toEqual([]);
    supplied.open();

    const [child] = (await spawned(pty)) as [FakeProcess];
    expect([child.options.cols, child.options.rows]).toEqual([132, 50]);
    expect(child.written).toEqual(["echo one\r", "echo two\r"]);
  });

  it("closed before its shell started, exits at once and never starts one, releasing what it is supplied as that comes", async () => {
    const supplied = gate();
    const { pty, terminals, asked } = holding({ HARNESS_TEST_TOKEN: "token-for-tests" }, supplied.opened);
    terminals.open(request());
    const heard: EventEnvelope[] = [];
    feedOf(terminals).feed.subscribe((event) => heard.push(event));

    terminals.close(ID, "closed");
    expect(heard.map((event) => event.payload)).toEqual([{ exitCode: -1, signal: null, cause: "closed" }]);
    supplied.open();

    await vi.waitFor(() => expect(asked.releases).toEqual([1]));
    expect(pty.spawned).toEqual([]);
  });

  it("starts its shell without it, saying so, when it cannot be had", async () => {
    const loud = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { pty, terminals } = setUp(0, {
      processEnvironment: () => {
        throw new Error("The session could not be read.");
      },
    });

    terminals.open(request());

    const [child] = (await spawned(pty)) as [FakeProcess];
    expect(child.options.env).toEqual({ TERM: "xterm-256color", PATH: "/usr/bin", HOME: "/home/david", LANG: "C.UTF-8", SHELL: "/bin/zsh" });
    expect(String(loud.mock.calls[0]?.[0])).toContain("could not be supplied");
    loud.mockRestore();
  });

  it("releases what it was supplied when its shell cannot start", async () => {
    const { pty, terminals, asked } = holding({ HARNESS_TEST_TOKEN: "token-for-tests" });
    pty.failNext = "posix_spawnp failed";

    terminals.open(request());

    await vi.waitFor(() => expect(asked.releases).toEqual([1]));
    expect(terminals.info(ID)).toMatchObject({ exitCode: -1 });
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

describe("a burst of output", () => {
  it("reaches a live subscriber whole, byte for byte, in consecutive sequences, whether one read or many in a window", () => {
    vi.useFakeTimers();
    const { pty, terminals } = setUp(5);
    terminals.open(request());
    const heard: EventEnvelope[] = [];
    feedOf(terminals).feed.subscribe((event) => heard.push(event));
    const [child] = pty.spawned as [FakeProcess];
    const burst = Array.from({ length: 200 * 1024 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
    child.print(burst);
    for (let at = 0; at < burst.length; at += 4096) child.print(burst.slice(at, at + 4096));
    vi.advanceTimersByTime(5);
    expect(heard.map((event) => event.payload["data"]).join("")).toBe(burst + burst);
    expect(heard.map((event) => event.sequence)).toEqual(heard.map((_, i) => i + 1));
  });
});

describe("a shell that fails to start after the command committed", () => {
  it("leaves a terminal exited with cause failed, the error in its scrollback, and says so in the log", () => {
    const { pty, terminals } = setUp();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    pty.failNext = "posix_spawnp failed";
    const info = terminals.open(request());
    expect(info).toMatchObject({ exitCode: -1 });
    const answer = feedOf(terminals).feed.catchUp(0);
    expect(answer.snapshot?.payload.scrollback).toContain("posix_spawnp failed");
    expect(answer.events.map((event) => event.payload)).toEqual([{ exitCode: -1, signal: null, cause: "failed" }]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(ID), expect.any(Error));
    errors.mockRestore();
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

describe("a terminal running a command (#343)", () => {
  it("counts while an open terminal's shell runs one, and not once it is back at its prompt, has exited or is closing", () => {
    const { pty, terminals } = setUp();
    const other = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    terminals.open(request());
    terminals.open(request({ id: other }));
    const [one, two] = pty.spawned as [FakeProcess, FakeProcess];
    expect(terminals.commandRunning()).toBe(false);

    two.running = true;
    expect(terminals.commandRunning()).toBe(true);
    two.running = false;
    expect(terminals.commandRunning()).toBe(false);

    one.running = true;
    terminals.close(ID, "closed");
    expect(terminals.commandRunning()).toBe(false);
    two.running = true;
    two.exit(0);
    expect(terminals.commandRunning()).toBe(false);
  });

  it("reads a shell whose foreground cannot be read as at its prompt", () => {
    const { pty, terminals } = setUp();
    terminals.open(request());
    const [child] = pty.spawned as [FakeProcess];
    const loud = vi.spyOn(console, "error").mockImplementation(() => undefined);
    child.commandRunning = () => {
      throw new Error("gone");
    };
    expect(terminals.commandRunning()).toBe(false);
    loud.mockRestore();
  });

  it("is a foreground process group other than the shell's own, which a shell at its prompt leads", () => {
    expect(runsCommand(4242, () => 4242)).toBe(false);
    expect(runsCommand(4242, () => 4250)).toBe(true);
    expect(runsCommand(4242, () => undefined)).toBe(false);
  });
});
