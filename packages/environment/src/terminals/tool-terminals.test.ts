import { randomUUID } from "node:crypto";
import { Ceiling, type EventFrame, type Scope } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { fakePty, type FakePty } from "../../test/fake-pty.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { deleteSession } from "../../test/sessions.js";
import { follow, openTerminal, refusedWith, sessionIn, terminalCommand, typeInto } from "../../test/terminals.js";
import type { WireClient } from "../../test/wire-client.js";
import { nodePty } from "./pty.js";

/**
 * Tool terminals (#362; key-managers spec, "Managed tools"; ADR 0026): a
 * terminal the Managed tools registry owns rather than a session, opened in
 * process with a command, a directory and a size, and streamed, written to,
 * resized and closed through the terminal methods by its id. Through the
 * primary seam: the in-process environment and a real client over a real
 * WebSocket; the fake pty for the lifecycle and the close after the exit on
 * the manual clock; a real pty for a scripted command, skipped where
 * `node-pty` is unbuilt.
 */

const { onCleanup, tempDir } = useCleanups();

/** The login shell a test's terminals start: zsh as a login shell, which the fake pty never runs. */
const ZSH = { file: "/bin/zsh", args: ["-l"] } as const;
/** The clean base a test's terminals start over. */
const BASE = { TERM: "xterm-256color", PATH: "/usr/bin:/bin", HOME: "/home/tester", LANG: "C.UTF-8" };

/** Whether this machine built node-pty: the real-pty test needs it. */
const ptyBuilt = (() => {
  try {
    nodePty.check();
    return true;
  } catch {
    return false;
  }
})();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

/** An environment whose terminals start on the fake pty, and its default client, which holds every scope. */
const withFakePty = async (): Promise<{ t: TestEnvironment; client: WireClient; pty: FakePty }> => {
  const pty = fakePty();
  const t = await start({ terminals: { pty, shell: () => ZSH, baseEnvironment: () => ({ ...BASE }), gatherMs: 0 } });
  return { t, client: await t.client(), pty };
};

/** A client session issued straight from the environment, holding only `scopes`. */
const narrowClient = (t: TestEnvironment, scopes: Scope[]): Promise<WireClient> =>
  t.client({ token: t.env.clientSessions.issue({ kind: "program", label: "a narrow program", scopes, ceiling: Ceiling.parse("acceptEdits") }).token });

/** Opens a tool terminal in process running `command` in `cwd`, at 100 by 30 unless asked otherwise. */
const openTool = (t: TestEnvironment, command: string, extra: { cwd?: string; cols?: number; rows?: number; env?: Record<string, string> } = {}) =>
  t.env.toolTerminals.open({ id: randomUUID(), command, cwd: extra.cwd ?? "/work/tools", cols: extra.cols ?? 100, rows: extra.rows ?? 30, env: extra.env ?? {} });

/** The fake pty's `index`th process; throws when it was never started. */
const spawnedAt = (pty: FakePty, index = 0) => {
  const process = pty.spawned[index];
  if (process === undefined) throw new Error(`No process ${index} was spawned.`);
  return process;
};

describe("a tool terminal, opened in process", () => {
  it("is owned by the Managed tools registry and names no session, running its command through the login shell in the directory, at the size, over the clean base and the opener's variables", async () => {
    const { t, pty } = await withFakePty();

    const opened = openTool(t, "brew upgrade gh", { cwd: "/home/tester", cols: 120, rows: 40, env: { HOMEBREW_NO_ENV_HINTS: "1", PATH: "/opt/homebrew/bin:/usr/bin" } });

    expect(opened.terminal).toEqual({
      id: opened.terminal.id,
      owner: "managed-tools",
      sessionId: null,
      openedAt: MANUAL_CLOCK_START,
      cols: 120,
      rows: 40,
      exitCode: null,
      signal: null,
    });
    const child = spawnedAt(pty);
    expect([child.file, child.args, child.options.cwd, child.options.cols, child.options.rows]).toEqual(["/bin/zsh", ["-l", "-c", "brew upgrade gh"], "/home/tester", 120, 40]);
    expect(child.options.env).toEqual({ ...BASE, PATH: "/opt/homebrew/bin:/usr/bin", SHELL: "/bin/zsh", HOMEBREW_NO_ENV_HINTS: "1" });
  });

  it("is refused an id used on this environment already, conflict exists, and where no pseudo-terminal can start, conflict pty_unavailable", async () => {
    const { t, client, pty } = await withFakePty();
    const sessionId = await sessionIn(client, tempDir("agent-harness-tool-terminal-"));
    const { id } = await openTerminal(client, sessionId);

    const taken = (() => {
      try {
        t.env.toolTerminals.open({ id: id.toUpperCase(), command: "gh --version", cwd: "/", cols: 80, rows: 24, env: {} });
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(taken).toMatchObject({ code: "conflict", data: { reason: "exists", id } });

    pty.unavailable = true;
    expect(() => openTool(t, "gh --version")).toThrow(expect.objectContaining({ code: "conflict", data: expect.objectContaining({ reason: "pty_unavailable" }) }));
    expect(pty.spawned).toHaveLength(1);
  });

  it("tells its opener the command's exit code when it exits", async () => {
    const { t, pty } = await withFakePty();
    const opened = openTool(t, "sudo apt-get install --only-upgrade gh");

    spawnedAt(pty).exit(3);

    await expect(opened.exited).resolves.toEqual({ exitCode: 3, signal: null, cause: "exited" });
  });
});

describe("the terminal methods on a tool terminal", () => {
  it("stream it, write to it, resize it and close it by its id, as a session's terminal", async () => {
    const { client, t, pty } = await withFakePty();
    const opened = openTool(t, "doppler update");
    const { id } = opened.terminal;
    const child = spawnedAt(pty);
    child.print("Password: ");

    const view = await follow(client, id, 0);
    await view.until((v) => v.synchronized);
    expect(view.snapshot).toMatchObject({ terminal: { id, owner: "managed-tools", sessionId: null }, scrollback: "Password: " });

    expect((await terminalCommand(client, "terminals.write", { id, data: "correct horse\r" })).receipt.status).toBe("accepted");
    expect(child.written).toEqual(["correct horse\r"]);
    expect((await terminalCommand(client, "terminals.resize", { id, cols: 132, rows: 43 })).result?.terminal).toEqual({ ...opened.terminal, cols: 132, rows: 43 });
    expect(child.resized).toEqual([[132, 43]]);
    child.print("\r\nUpdated.\r\n");
    await view.until((v) => v.text.includes("Updated."));

    expect((await terminalCommand(client, "terminals.close", { id })).result).toEqual({ id });
    expect(child.signals).toEqual(["SIGHUP"]);
    child.exit(0, 1);
    await view.until((v) => v.ended !== undefined);
    expect([view.exited, view.ended]).toEqual([{ exitCode: 0, signal: 1, cause: "closed" }, "closed"]);
    await expect(opened.exited).resolves.toEqual({ exitCode: 0, signal: 1, cause: "closed" });
  });

  it("let a client session with the terminal scope watch it, but write to it, resize it and close it only with admin, refused forbidden in a receipt", async () => {
    const { t, pty } = await withFakePty();
    const { id } = openTool(t, "sudo apt-get install gh").terminal;
    const child = spawnedAt(pty);
    child.print("[sudo] password for tester: ");
    const watcher = await narrowClient(t, ["read", "terminal"]);

    const view = await follow(watcher, id, 0);
    await view.until((v) => v.synchronized);
    expect(view.text).toBe("[sudo] password for tester: ");
    for (const answer of [
      await terminalCommand(watcher, "terminals.write", { id, data: "hunter2\r" }),
      await terminalCommand(watcher, "terminals.resize", { id, cols: 90, rows: 20 }),
      await terminalCommand(watcher, "terminals.close", { id }),
    ]) {
      expect(answer.receipt).toMatchObject({ status: "rejected", reason: "forbidden", error: { code: "forbidden", data: { scope: "admin" } } });
    }
    expect([child.written, child.resized, child.signals]).toEqual([[], [], []]);

    const admin = await narrowClient(t, ["terminal", "admin"]);
    expect((await terminalCommand(admin, "terminals.write", { id, data: "hunter2\r" })).receipt.status).toBe("accepted");
    expect(child.written).toEqual(["hunter2\r"]);
  });

  it("never list it under a session, count it toward a session's sixteen, or close it with a session's deletion", async () => {
    const { t, client, pty } = await withFakePty();
    const sessionId = await sessionIn(client, tempDir("agent-harness-tool-terminal-"));
    const tool = openTool(t, "gh extension upgrade --all").terminal;

    for (let i = 0; i < 16; i += 1) await openTerminal(client, sessionId);
    const listed = (await client.request("terminals.list", { sessionId })).terminals;
    expect(listed).toHaveLength(16);
    expect(listed.map((terminal) => terminal.id)).not.toContain(tool.id);
    expect(listed.every((terminal) => terminal.owner === "session" && terminal.sessionId === sessionId)).toBe(true);

    await deleteSession(client, sessionId);
    const view = await follow(client, tool.id, 0);
    await view.until((v) => v.synchronized);
    expect(view.snapshot?.terminal).toMatchObject({ id: tool.id, exitCode: null });
    expect(spawnedAt(pty).signals).toEqual([]);
  });
});

describe("a tool terminal's end", () => {
  it("keeps its scrollback thirty minutes after its command exits, by the environment's clock, and then closes", async () => {
    const { t, client, pty } = await withFakePty();
    const { id } = openTool(t, "bws --version").terminal;
    const child = spawnedAt(pty);
    child.print("bws 1.0.0\r\n");
    child.exit(0);

    t.clock.advance(30 * 60 * 1000 - 1);
    const before = await follow(client, id, 0);
    await before.until((v) => v.ended !== undefined);
    expect(before.snapshot).toMatchObject({ scrollback: "bws 1.0.0\r\n", terminal: { exitCode: 0 } });
    expect(before.exited).toEqual({ exitCode: 0, signal: null, cause: "exited" });

    t.clock.advance(1);
    const error = await refusedWith(client.subscribe("terminals.subscribe", { id, afterSequence: 0 }));
    expect([error.code, error.data]).toEqual(["not_found", { kind: "terminal", id }]);
    const closed = await terminalCommand(client, "terminals.close", { id });
    expect(closed.receipt).toMatchObject({ status: "rejected", reason: "not_found" });
  });

  it("comes at once when the environment stops: its command is hung up, and its opener hears it closed", async () => {
    const { t, pty } = await withFakePty();
    const opened = openTool(t, "op update");
    const child = spawnedAt(pty);

    await t.env.close();

    expect(child.signals).toEqual(["SIGHUP"]);
    child.exit(129, 1);
    await expect(opened.exited).resolves.toEqual({ exitCode: 129, signal: 1, cause: "closed" });
  });

  it("holds the environment busy while its command runs, as a terminal running a command does, and nothing once it has exited", async () => {
    const { t, client, pty } = await withFakePty();
    openTool(t, "brew upgrade openbao");

    expect((await client.request("environment.status", {})).activity).toEqual({ state: "busy", reason: "terminal-running" });
    spawnedAt(pty).exit(0);
    expect((await client.request("environment.status", {})).activity).toEqual({ state: "idle" });
  });
});

describe("a tool terminal on a real pseudo-terminal", () => {
  it.skipIf(!ptyBuilt)("runs a scripted command that prompts, takes the answer typed at it, and tells its opener the exit code", async () => {
    const t = await start({ terminals: { shell: () => ({ file: "/bin/sh", args: [] }) } });
    const client = await t.client();
    const dir = tempDir("agent-harness-tool-terminal-");

    const opened = t.env.toolTerminals.open({
      id: randomUUID(),
      command: `printf 'Answer: '; read answer; echo "got-$answer in $(pwd) with [$TOOL_VAR]"; exit 5`,
      cwd: dir,
      cols: 80,
      rows: 24,
      env: { TOOL_VAR: "from the opener" },
    });
    const { id } = opened.terminal;
    const view = await follow(client, id, 0);
    await view.until((v) => v.text.includes("Answer: "), "the prompt");

    await typeInto(client, id, "yes\r");
    await view.until((v) => v.ended !== undefined);

    expect(view.text).toMatch(/got-yes in \S*agent-harness-tool-terminal-\S* with \[from the opener\]/);
    expect(view.exited).toEqual({ exitCode: 5, signal: null, cause: "exited" });
    await expect(opened.exited).resolves.toEqual({ exitCode: 5, signal: null, cause: "exited" });
    const events = view.frames.filter((frame): frame is EventFrame => frame.type === "event");
    expect(events.at(-1)?.event).toMatchObject({ streamKind: "terminal", streamId: id, type: "terminal.exited" });
  });
});
