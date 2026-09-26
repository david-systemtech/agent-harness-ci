import { describe, expect, it } from "vitest";
import { writable, type Runtime, type TerminalOutput, type TerminalStreamView } from "@agent-harness/client-runtime";
import { manualClock } from "@agent-harness/client-runtime/testing";
import { flush } from "@agent-harness/client-runtime/testing/fake-wire";
import { ONE_OFF_LINE, ONE_OFF_MAX_CHARS, ONE_OFF_VARIABLE, oneOffEnv } from "@agent-harness/contracts";
import { afterMarker, clipOutput, oneOffMessage, runOneOff } from "./one-off.js";

/**
 * `!!`'s one-off command (docs/specs/tui.md, "The composer"): the command
 * rides a terminal's variables behind a marker line, what came after the
 * marker is what it said, read as a terminal showed it and cut, and a
 * minute at most. The real shell's side is proven against real
 * pseudo-terminals in the environment's `terminals/one-off.test.ts`; this
 * is the reading of what came back, over a terminal the test plays.
 */

const MARKER = "agent-harness-one-off-t1";
const TARGET = { environmentId: "env-1", sessionId: "session-1" };

describe("the marker", () => {
  it("is what the output comes after: the greeting, prompt and echo before its line are dropped", () => {
    expect(afterMarker(`motd\r\n$  exec /bin/sh -c "$${ONE_OFF_VARIABLE}"\r\n${MARKER}\r\nhi\r\n`, MARKER)).toBe("hi\r\n");
  });

  it("is null when it never came, and nothing follows it when its line has not ended", () => {
    expect(afterMarker("$ nu: unknown command exec\r\n", MARKER)).toBeNull();
    expect(afterMarker(`$ ${MARKER}`, MARKER)).toBe("");
  });
});

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
  let writeAnswer: "accepted" | "unreachable" = "accepted";
  const runtime = {
    requests: {
      call: async (_environmentId: string, method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "terminals.write" && writeAnswer === "unreachable") return { ok: false, error: { code: "unreachable", message: "desk cannot be reached." } };
        return { ok: true, result: { receipt: { status: "accepted", sequence: 1, changed: false } } };
      },
    },
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
    failWrites: () => void (writeAnswer = "unreachable"),
    print: (data: string) => listener?.({ kind: "output", data, sequence: ++sequence, live: true }),
    /** A snapshot of what the terminal's scrollback still holds, as a resubscription answered with one. */
    reset: (data: string, truncated: boolean) => listener?.({ kind: "reset", data, sequence: ++sequence, truncated, terminal: null as never }),
    exit: (exitCode: number) => listener?.({ kind: "exited", exit: { exitCode, signal: null, cause: "exited" } }),
    /** The terminal gone with no exit said (closed by another client, lost to a restart of the environment). */
    vanish: () => state.set({ status: "ended", cursor: sequence, terminal: null, exit: null, fault: null }),
    deps: { runtime, clock, newCommandId: () => "c", newTerminalId: () => "t1" },
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
  it("opens its terminal with the script in its variables, types the line, and reads only what came after the marker", async () => {
    const terminal = played();
    const result = await run(terminal, "echo hi", () => {
      terminal.print(`motd\r\n$ ${ONE_OFF_LINE}\n`);
      terminal.print(`${MARKER}\r\nhi\r\n`);
      terminal.exit(0);
    });
    expect(result).toEqual({ ok: true, output: "hi", exitCode: 0, signal: null, timedOut: false, gone: false, timeoutMs: 60_000, cut: false, dropped: false });
    expect(terminal.calls.map((c) => c.method)).toEqual(["terminals.open", "terminals.write", "terminals.close"]);
    expect(terminal.calls[0]?.params).toMatchObject({ id: "t1", sessionId: "session-1", cols: 120, rows: 40, env: oneOffEnv("echo hi", MARKER) });
    expect(terminal.calls[1]?.params).toMatchObject({ data: ONE_OFF_LINE });
  });

  it("finds the marker when it arrives in pieces", async () => {
    const terminal = played();
    const result = await run(terminal, "echo hi", () => {
      terminal.print("$ agent-harness-one-");
      terminal.print("off-t1\r");
      terminal.print("\nhi\r\n");
      terminal.exit(0);
    });
    expect(result).toMatchObject({ ok: true, output: "hi" });
  });

  it("sends nothing when the marker never came, and says the last line the terminal showed", async () => {
    const terminal = played();
    const result = await run(terminal, "ls", () => {
      terminal.print("Welcome\r\n> nu: unknown command: exec\r\n");
      terminal.exit(1);
    });
    expect(result).toEqual({ ok: false, line: "The shell never started it before its terminal ended; it last showed: > nu: unknown command: exec" });
  });

  it("stops waiting at its limit, closes the terminal, and says how long it was given", async () => {
    const terminal = played();
    const result = runOneOff({ ...terminal.deps, timeoutMs: 5_000 }, TARGET, "sleep 100");
    await flush();
    await flush();
    terminal.print(`${MARKER}\r\nstarted\r\n`);
    terminal.clock.advance(5_000);
    const ended = await result;
    expect(ended).toEqual({ ok: true, output: "started", exitCode: null, signal: null, timedOut: true, gone: false, timeoutMs: 5_000, cut: false, dropped: false });
    expect(terminal.calls.at(-1)?.method).toBe("terminals.close");
    expect(oneOffMessage("sleep 100", ended as Extract<typeof ended, { ok: true }>)).toBe("Ran `sleep 100`:\n```\nstarted\ntimed out after 5s\n```");
  });

  it("cuts what comes after the marker at its limit, marks the cut, and counts past it in characters", async () => {
    const terminal = played();
    const result = await run(terminal, "yes", () => {
      terminal.print(`${MARKER}\r\n`);
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
      terminal.print(`${MARKER}\r\n`);
      terminal.print(`${lines.join("\r\n")}\r\n`);
      terminal.exit(0);
    });
    expect(result).toMatchObject({ ok: true, cut: false });
    const output = (result as Extract<typeof result, { ok: true }>).output.split("\n");
    expect(output.slice(0, 3)).toEqual(["1", "2", "3"]);
    expect(output.at(-2)).toBe("200");
    expect(output.at(-1)).toBe("… 4800 more lines");
  });

  it("reads a scrollback that no longer holds the marker, after a resubscription mid-run, as the command's, and says its start was dropped", async () => {
    const terminal = played();
    const result = await run(terminal, "make", () => {
      terminal.print(`$ ${ONE_OFF_LINE}\n${MARKER}\r\nstep 1\r\n`);
      terminal.reset("step 4000\r\nstep 4001\r\n", true);
      terminal.print("done\r\n");
      terminal.exit(0);
    });
    expect(result).toMatchObject({ ok: true, output: "step 4000\nstep 4001\ndone", exitCode: 0, dropped: true });
    expect(oneOffMessage("make", result as Extract<typeof result, { ok: true }>)).toBe("Ran `make`:\n```\n… earlier output dropped\nstep 4000\nstep 4001\ndone\n```");
  });

  it("reads a resubscription's snapshot that still holds the marker from the marker, as before", async () => {
    const terminal = played();
    const result = await run(terminal, "make", () => {
      terminal.print(`$ ${ONE_OFF_LINE}\n${MARKER}\r\nstep 1\r\n`);
      terminal.reset(`$ ${ONE_OFF_LINE}\n${MARKER}\r\nstep 1\r\nstep 2\r\n`, false);
      terminal.exit(0);
    });
    expect(result).toMatchObject({ ok: true, output: "step 1\nstep 2", dropped: false });
  });

  it("says the terminal went away when it ends with no exit after the command started, rather than send its output as a finished run", async () => {
    const terminal = played();
    const result = await run(terminal, "make", () => {
      terminal.print(`${MARKER}\r\nstep 1\r\n`);
      terminal.vanish();
    });
    expect(result).toEqual({ ok: true, output: "step 1", exitCode: null, signal: null, timedOut: false, gone: true, timeoutMs: 60_000, cut: false, dropped: false });
    expect(oneOffMessage("make", result as Extract<typeof result, { ok: true }>)).toBe("Ran `make`:\n```\nstep 1\nthe terminal went away before the command ended\n```");
  });

  it("stops its clock when the line could not be typed, and says why", async () => {
    const terminal = played();
    terminal.failWrites();
    const result = await runOneOff(terminal.deps, TARGET, "ls");
    expect(result).toEqual({ ok: false, line: "desk cannot be reached." });
    expect(terminal.clock.pending()).toBe(0);
  });
});
