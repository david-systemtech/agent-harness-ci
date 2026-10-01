import xterm from "@xterm/headless";
import { describe, expect, it } from "vitest";
import { ONE_OFF_MAX_CHARS, type TerminalInfo } from "@agent-harness/contracts";
import { writable } from "../observable.js";
import type { Runtime } from "../runtime.js";
import type { TerminalOutput, TerminalStreamView } from "../streams/terminals.js";
import { flush } from "../testing/fake-wire.js";
import { manualClock } from "../testing/in-memory-platform.js";
import { clipOutput, oneOffMessage, reusableTerminal, runOneOff } from "./one-off.js";
import { xtermScreen, type TextScreens } from "./text-screen.js";

/** One-off output collection over the runtime's terminal subscription and the renderer's emulator. */

/** The terminal UI's emulator, as it hands it to a one-off. */
const screens: TextScreens = (size) => xtermScreen(new xterm.Terminal({ ...size, allowProposedApi: true }));

const TARGET = { environmentId: "env-1", sessionId: "session-1" };

describe("the output cut to lines", () => {
  it("is kept whole up to the limit, and past it the first lines and a count of the rest", () => {
    expect(clipOutput("a\nb", 2)).toBe("a\nb");
    expect(clipOutput("a\nb\nc", 2)).toBe("a\nb\n… 1 more line");
    expect(clipOutput("a\nb\nc\nd", 2)).toBe("a\nb\n… 2 more lines");
  });
});

/** A runtime whose one terminal the test plays: its writes recorded, its output and exit said when the test says. */
const played = () => {
  const clock = manualClock();
  const calls: { readonly method: string; readonly params: Record<string, unknown> }[] = [];
  let listener: ((output: TerminalOutput) => void) | undefined;
  const state = writable<TerminalStreamView>({ status: "live", cursor: 0, terminal: null, exit: null, fault: null });
  let sequence = 0;
  let runAnswer: "accepted" | "unreachable" = "accepted";
  /** Whether the environment can be asked: while it cannot, every write and close fails as the runtime fails one. */
  let reachable = true;
  const environments = writable<readonly unknown[]>([]);
  const runtime = {
    requests: {
      call: async (_environmentId: string, method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        const unreachable = { ok: false, error: { code: "unreachable", message: "desk cannot be reached." } };
        if (method === "terminals.run" && (runAnswer === "unreachable" || !reachable)) return unreachable;
        if (method === "terminals.close" && !reachable) return unreachable;
        return { ok: true, result: { receipt: { status: "accepted", sequence: 1, changed: false } } };
      },
    },
    projections: { environments },
    capability: () => (reachable ? { status: "present" } : { status: "absent", reason: "not-ready", message: "desk cannot be reached." }),
    subscriptions: {
      terminal: (_environmentId: string, _id: string, heard: (output: TerminalOutput) => void) => {
        listener = heard;
        return { environmentId: "env-1", terminalId: "t1", state, release: () => undefined };
      },
    },
  } as unknown as Runtime;
  return {
    clock,
    calls,
    runtime,
    failRuns: () => void (runAnswer = "unreachable"),
    /** The environment drops: nothing can be asked of it until `back`. */
    drop: () => void (reachable = false),
    /** The environment answers again, as its connection coming back changes the environments' projection. */
    back: () => {
      reachable = true;
      environments.set([]);
    },
    print: (data: string) => listener?.({ kind: "output", data, sequence: ++sequence, live: true }),
    /** A snapshot of what the terminal's scrollback still holds, as a resubscription answered with one. */
    reset: (data: string, truncated: boolean) => listener?.({ kind: "reset", data, sequence: ++sequence, truncated, terminal: null as never }),
    exit: (exitCode: number) => listener?.({ kind: "exited", exit: { exitCode, signal: null, cause: "exited" }, occurredAt: clock.now().toISOString() }),
    /** The terminal gone with no exit said (closed by another client, lost to a restart of the environment). */
    vanish: () => state.set({ status: "ended", cursor: sequence, terminal: null, exit: null, fault: null }),
    deps: { runtime, clock, newCommandId: () => "c", newTerminalId: () => "t1", screens },
  };
};

/** Runs `command`, then lets the test play the terminal once the line is typed. */
const run = async (terminal: ReturnType<typeof played>, command: string, play: () => void) => {
  const result = runOneOff(terminal.deps, TARGET, command);
  await flush();
  await flush();
  play();
  return result;
};

describe("a one-off command run", () => {
  it("runs the command directly, reads all its output and never types an exec line", async () => {
    const terminal = played();
    const result = await run(terminal, "echo hi", () => {
      terminal.print("hi\r\n");
      terminal.exit(0);
    });
    expect(result).toMatchObject({ ok: true, output: "hi", exitCode: 0 });
    expect(terminal.calls.map((c) => c.method)).toEqual(["terminals.run", "terminals.close"]);
    expect(terminal.calls[0]?.params).toMatchObject({ command: "echo hi", id: "t1", sessionId: "session-1", cols: 120, rows: 40 });
  });


  it("stops waiting at its limit, closes the terminal, and says how long it was given", async () => {
    const terminal = played();
    const result = runOneOff({ ...terminal.deps, timeoutMs: 5_000 }, TARGET, "sleep 100");
    await flush();
    await flush();
    terminal.print(`started\r\n`);
    terminal.clock.advance(5_000);
    const ended = await result;
    expect(ended).toEqual({ ok: true, output: "started", exitCode: null, signal: null, timedOut: true, gone: false, timeoutMs: 5_000, cut: false, dropped: false });
    expect(terminal.calls.at(-1)?.method).toBe("terminals.close");
    expect(oneOffMessage("sleep 100", ended as Extract<typeof ended, { ok: true }>)).toBe("Ran `sleep 100`:\n```\nstarted\ntimed out after 5s\n```");
  });

  it("cuts command output at its limit, marks the cut, and counts past it in characters", async () => {
    const terminal = played();
    const result = await run(terminal, "yes", () => {

      terminal.print("é".repeat(ONE_OFF_MAX_CHARS - 1));
      terminal.print("éé");
      terminal.exit(0);
    });
    expect(result).toMatchObject({ ok: true, cut: true });
    expect(oneOffMessage("yes", result as Extract<typeof result, { ok: true }>)).toMatch(/… output stopped after 256K characters\n```$/);
  });

  it("keeps the first lines of output longer than a screen's scrollback, and counts every line after them", async () => {
    const terminal = played();
    const lines = Array.from({ length: 5000 }, (_, i) => String(i + 1));
    const result = await run(terminal, "seq 5000", () => {

      terminal.print(`${lines.join("\r\n")}\r\n`);
      terminal.exit(0);
    });
    expect(result).toMatchObject({ ok: true, cut: false });
    const output = (result as Extract<typeof result, { ok: true }>).output.split("\n");
    expect(output.slice(0, 3)).toEqual(["1", "2", "3"]);
    expect(output.at(-2)).toBe("200");
    expect(output.at(-1)).toBe("… 4800 more lines");
  });

  it("keeps the first lines of wide-character output, whose lines wrap to more rows than they are lines", async () => {
    const terminal = played();
    // 1,600 lines of four digits and 119 wide characters: 242 cells, three rows of 120, 4,800 rows in all, under the
    // character cap and the line feeds read through the screen.
    const lines = Array.from({ length: 1600 }, (_, i) => `${String(i + 1).padStart(4, "0")}${"漢".repeat(119)}`);
    const result = await run(terminal, "cat wide.txt", () => {

      terminal.print(`${lines.join("\r\n")}\r\n`);
      terminal.exit(0);
    });
    expect(result).toMatchObject({ ok: true, cut: false });
    const output = (result as Extract<typeof result, { ok: true }>).output.split("\n");
    expect(output.slice(0, 2)).toEqual([lines[0], lines[1]]);
    expect(output.at(-2)).toBe(lines[199]);
    expect(output.at(-1)).toBe("… 1400 more lines");
  });

  it("keeps the first lines when what follows them moves down more rows than a screen holds without a line feed", async () => {
    const terminal = played();
    // A vertical tab moves down a row as a line feed does, and none of them is counted as one.
    const result = await run(terminal, "tabs", () => {

      terminal.print(`first\r\nsecond\r\n${"x\v".repeat(8000)}\r\nlast\r\n`);
      terminal.exit(0);
    });
    const output = (result as Extract<typeof result, { ok: true }>).output.split("\n");
    expect(output.slice(0, 2)).toEqual(["first", "second"]);
  });

  it("reads a truncated snapshot after a resubscription mid-run, as the command's, and says its start was dropped", async () => {
    const terminal = played();
    const result = await run(terminal, "make", () => {
      terminal.print(`step 1\r\n`);
      terminal.reset("step 4000\r\nstep 4001\r\n", true);
      terminal.print("done\r\n");
      terminal.exit(0);
    });
    expect(result).toMatchObject({ ok: true, output: "step 4000\nstep 4001\ndone", exitCode: 0, dropped: true });
    expect(oneOffMessage("make", result as Extract<typeof result, { ok: true }>)).toBe("Ran `make`:\n```\n… earlier output dropped\nstep 4000\nstep 4001\ndone\n```");
  });

  it("reads a resubscription's complete snapshot as the command's output", async () => {
    const terminal = played();
    const result = await run(terminal, "make", () => {
      terminal.print(`step 1\r\n`);
      terminal.reset(`step 1\r\nstep 2\r\n`, false);
      terminal.exit(0);
    });
    expect(result).toMatchObject({ ok: true, output: "step 1\nstep 2", dropped: false });
  });

  it("says a command that printed nothing and ended cleanly printed nothing, rather than send an empty fence", async () => {
    const terminal = played();
    const result = await run(terminal, "touch x", () => {
      terminal.exit(0);
    });
    expect(result).toMatchObject({ ok: true, output: "", exitCode: 0, cut: false, dropped: false });
    expect(oneOffMessage("touch x", result as Extract<typeof result, { ok: true }>)).toBe("Ran `touch x`; it printed nothing.");
  });

  it("says the terminal went away when it ends with no exit after the command started, rather than send its output as a finished run", async () => {
    const terminal = played();
    const result = await run(terminal, "make", () => {
      terminal.print(`step 1\r\n`);
      terminal.vanish();
    });
    expect(result).toEqual({ ok: true, output: "step 1", exitCode: null, signal: null, timedOut: false, gone: true, timeoutMs: 60_000, cut: false, dropped: false });
    expect(oneOffMessage("make", result as Extract<typeof result, { ok: true }>)).toBe("Ran `make`:\n```\nstep 1\nthe terminal went away before the command ended\n```");
  });

  it("retries a lost close when the environment is back", async () => {
    const terminal = played();
    const result = await run(terminal, "ls", () => {
      terminal.drop();
      terminal.exit(0);
    });
    expect(result).toMatchObject({ ok: true });
    await flush();
    const closes = () => terminal.calls.filter((c) => c.method === "terminals.close");
    expect(closes()).toHaveLength(1);
    terminal.back();
    await flush();
    expect(closes()).toHaveLength(2);
    expect(closes()[1]?.params).toMatchObject({ id: "t1" });
    // Sent once more, not on every change after.
    terminal.back();
    await flush();
    expect(closes()).toHaveLength(2);
  });

  it("starts no clock when the run is refused, and says why", async () => {
    const terminal = played();
    terminal.failRuns();
    const result = await runOneOff(terminal.deps, TARGET, "ls");
    expect(result).toEqual({ ok: false, line: "desk cannot be reached." });
    expect(terminal.clock.pending()).toBe(0);
  });
});

describe("the terminal a pane reopens", () => {
  const info = (id: string, exitCode: number | null = null): TerminalInfo => ({ id, owner: "session", sessionId: "s", openedAt: "2026-09-29T00:00:00.000Z", cols: 80, rows: 24, exitCode, signal: null });

  it("is the newest still running that is not a one-off this client started, in any case of its id", () => {
    expect(reusableTerminal([info("a"), info("b"), info("c", 0)], new Set())?.id).toBe("b");
    expect(reusableTerminal([info("a"), info("B")], new Set(["b"]))?.id).toBe("a");
    expect(reusableTerminal([info("a", 1)], new Set())).toBeUndefined();
  });
});
