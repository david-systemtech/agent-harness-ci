import { describe, expect, it } from "vitest";
import { noticeEvent } from "../test/events.js";
import { usePaired } from "../test/paired.js";
import { runTool, verifyTool } from "./managed-tools/actions.js";
import { runWords, toolRunWords } from "./managed-tools/words.js";
import { flush } from "./testing/fake-wire.js";
import { MANUAL_CLOCK_START } from "./testing/in-memory-platform.js";

/**
 * Managed tools in the client runtime (key-managers spec, "Managed tools";
 * ADR 0026; #426), through the fake wire: a run sent through `tools.run`
 * and what each refusal says in one line, the vendor's command a
 * `tool_not_runnable` answers; Verify; and the tool runs the environment's
 * stream tells of, the run under way and each tool's last.
 */

const { paired } = usePaired();

const TERMINAL_ID = "7e000000-0000-4000-8000-0000000000a1";

/** A tool terminal as `tools.run` answers it. */
const terminal = { id: TERMINAL_ID, owner: "managed-tools", sessionId: null, openedAt: MANUAL_CLOCK_START, cols: 80, rows: 24, exitCode: null, signal: null } as const;

const started = { tool: "gh", action: "install", method: "homebrew", terminalId: TERMINAL_ID, command: "brew install gh" } as const;
const finished = {
  tool: "gh",
  action: "install",
  method: "homebrew",
  terminalId: TERMINAL_ID,
  exitCode: 0,
  signal: null,
  cause: "exited",
  verification: { tool: "gh", outcome: "passed", reason: "gh is signed in to github.com as milo." },
} as const;

const rejected = (code: string, message: string, data: Record<string, unknown>) => ({ result: { receipt: { status: "rejected", sequence: 2, changed: false, reason: code, error: { code, message, data } } } });

describe("a tool run", () => {
  it("is sent as tools.run with an id minted for its terminal, answering the terminal and the command it runs", async () => {
    const { runtime, wire, env } = await paired({ capabilities: ["managedTools"] });
    const asked: Record<string, unknown>[] = [];
    wire.answer("tools.run", (params) => {
      asked.push(params);
      return { result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: { terminal: { ...terminal, id: params["id"] }, tool: "gh", action: "install", method: "homebrew", command: "brew install gh", doctor: null } } };
    });
    const outcome = await runTool(runtime, env, "gh", "install", new Date(MANUAL_CLOCK_START));
    expect(asked).toEqual([{ commandId: expect.any(String), tool: "gh", action: "install", id: expect.stringMatching(/^[0-9a-f-]{36}$/) }]);
    expect(outcome).toEqual({ ok: true, run: expect.objectContaining({ terminal: expect.objectContaining({ id: asked[0]?.["id"], owner: "managed-tools" }), command: "brew install gh" }) });
  });

  it("refused says why in one line, with the vendor's command where tool_not_runnable answers one", async () => {
    const { runtime, wire, env } = await paired({ capabilities: ["managedTools"] });
    const answers = [
      rejected("tool_not_runnable", "The harness does not update gh installed by mise: run the vendor's command yourself.", { tool: "gh", action: "update", command: "brew install gh" }),
      rejected("conflict", "A bao install is running on this environment; package managers lock, so one tool run runs at a time.", { reason: "tool_run_in_progress", tool: "bao", terminalId: TERMINAL_ID }),
    ];
    wire.answer("tools.run", () => answers.shift());
    expect(await runTool(runtime, env, "gh", "update", new Date(MANUAL_CLOCK_START))).toEqual({
      ok: false,
      line: "Not run: The harness does not update gh installed by mise: run the vendor's command yourself.",
      command: "brew install gh",
    });
    expect(await runTool(runtime, env, "gh", "update", new Date(MANUAL_CLOCK_START))).toEqual({
      ok: false,
      line: "Not run: A bao install is running on this environment; package managers lock, so one tool run runs at a time.",
      command: null,
    });
  });

  it("as Run in a terminal pane is sent as tools.run's terminal action, answering the tool terminal that holds the vendor's command until Enter (#1833)", async () => {
    const { runtime, wire, env } = await paired({ capabilities: ["managedTools"] });
    const held = "printf '%s\\n\\n%s ' 'brew install gh' 'Press Enter to run it here, or Ctrl+C to cancel.' && sh -c 'read -r answer' && brew install gh";
    const asked: Record<string, unknown>[] = [];
    wire.answer("tools.run", (params) => {
      asked.push(params);
      return { result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: { terminal: { ...terminal, id: params["id"] }, tool: "gh", action: "terminal", method: "homebrew", command: held, doctor: null } } };
    });
    expect(runWords({ tool: "gh" }, "terminal")).toBe("Run in a terminal pane");
    const outcome = await runTool(runtime, env, "gh", "terminal", new Date(MANUAL_CLOCK_START));
    expect(asked).toEqual([{ commandId: expect.any(String), tool: "gh", action: "terminal", id: expect.stringMatching(/^[0-9a-f-]{36}$/) }]);
    expect(outcome).toEqual({ ok: true, run: expect.objectContaining({ action: "terminal", terminal: expect.objectContaining({ id: asked[0]?.["id"], owner: "managed-tools" }), command: held }) });
  });

  it("is not sent where the environment does not offer managedTools", async () => {
    const { runtime, env } = await paired({ capabilities: [] });
    expect(await runTool(runtime, env, "gh", "install", new Date(MANUAL_CLOCK_START))).toEqual({
      ok: false,
      line: "Not run: desk runs an older agent-harness without this. Update desk to use it.",
      command: null,
    });
  });
});

describe("Verify", () => {
  it("says passed or failed with the environment's one-line reason", async () => {
    const { runtime, wire, env } = await paired({ capabilities: ["managedTools"] });
    const answers: Record<string, unknown>[] = [
      { tool: "gh", outcome: "passed", reason: "gh is signed in to github.com as milo." },
      { tool: "bao", outcome: "failed", reason: "OpenBao at https://bao.home.test:8200 is sealed." },
    ];
    wire.answer("tools.verify", () => ({ result: answers.shift() ?? {} }));
    expect(await verifyTool(runtime, env, "gh")).toEqual({ ok: true, line: "Verified: gh is signed in to github.com as milo." });
    expect(await verifyTool(runtime, env, "bao")).toEqual({ ok: false, line: "Verify failed: OpenBao at https://bao.home.test:8200 is sealed." });
  });
});

describe("the tool runs the environment's stream tells of", () => {
  it("hold the run under way from tool.run-started until its tool.run-finished, then that tool's last run with its verification", async () => {
    const { runtime, env, environment } = await paired({ capabilities: ["managedTools"] });
    const runs = runtime.projections.toolRuns(env);
    expect(runs.read()).toEqual({ running: null, finished: {} });

    environment.event(noticeEvent(1, env, "tool.run-started", started));
    await flush();
    expect(runs.read()).toEqual({ running: started, finished: {} });

    environment.event(noticeEvent(2, env, "tool.run-finished", finished));
    await flush();
    expect(runs.read()).toEqual({ running: null, finished: { gh: finished } });
    expect(toolRunWords(finished)).toBe("The install of gh finished. Verified: gh is signed in to github.com as milo.");
  });

  it("say how a run that did not finish on its own ended", () => {
    const base = { tool: "bao", action: "update", method: "apt", terminalId: TERMINAL_ID, signal: null, verification: null } as const;
    expect(toolRunWords({ ...base, exitCode: 100, cause: "exited" })).toBe("The update of bao exited with code 100.");
    expect(toolRunWords({ ...base, exitCode: null, cause: "closed" })).toBe("The update of bao was closed before it finished.");
    expect(toolRunWords({ ...base, exitCode: -1, cause: "failed" })).toBe("The update of bao could not start.");
    expect(toolRunWords({ ...base, exitCode: null, signal: 9, cause: "exited" })).toBe("The update of bao was killed by signal 9.");
  });
});
