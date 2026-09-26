import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KEY, renderApp, type RenderedApp } from "../test/harness.js";
import { ONE_OFF_LINE } from "./terminal/one-off.js";

/**
 * The terminal pane (docs/specs/tui.md, "The terminal pane"; #148):
 * `/terminal` opens the session's environment-owned terminal, or reopens
 * the one it has, as a pane between the transcript and the composer, sized
 * through `terminals.resize` to the columns and rows it is drawn at, and
 * drawn from a headless emulator fed by `terminals.subscribe`. With focus
 * every key goes to the terminal through `terminals.write` but the two
 * `terminal` actions; a reconnect resubscribes from the cursor and replays;
 * an environment that cannot be reached refuses `/terminal` at once.
 */

let apps: RenderedApp[] = [];
afterEach(async () => {
  for (const app of apps) await app.unmount();
  apps = [];
});

const SESSION = "0199aa00-0000-4000-8000-000000000001";
const FIRST = "7e000000-0000-4000-8000-000000000001";
const SECOND = "7e000000-0000-4000-8000-000000000002";
const EXISTING = "0a1b2c3d-0000-4000-8000-000000000009";
/** The pane at the harness's 100 by 30: the width beside the rail, and 40% of the rows. */
const PANE = { cols: 72, rows: 12 };

const opened = async (extra: Partial<Parameters<typeof renderApp>[0]["script"]["environments"][number]> = {}) => {
  const app = await renderApp({
    script: { environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts", workspace: { kind: "directory", path: "/home/seth/receipts" } }], ...extra }] },
    flags: { session: SESSION },
  });
  apps.push(app);
  await app.waitFor("Nothing said yet.");
  return { app, env: app.environment("desk") };
};

const command = async (app: RenderedApp, text: string) => {
  await app.type(text);
  await app.press(KEY.enter);
};

/** Everything written to a terminal, in order, as one string. */
const written = (app: RenderedApp, id: string) => app.environment("desk").terminal(id).writes.join("");

/** The frame's rows that hold `text`, trimmed. */
const rowsWith = (app: RenderedApp, text: string) =>
  app
    .rows()
    .filter((row) => row.includes(text))
    .map((row) => row.slice(row.lastIndexOf("│") + 1).trim());

describe("opening the pane", () => {
  it("opens a terminal for the session with a client-minted id at the pane's size, and draws its output between the transcript and the composer", async () => {
    const { app, env } = await opened();
    await command(app, "/terminal");
    await app.waitFor("terminal · desk");
    expect(env.terminals().map((t) => ({ id: t.id, sessionId: t.sessionId, cols: t.cols, rows: t.rows }))).toEqual([{ id: FIRST, sessionId: SESSION, ...PANE }]);
    env.terminalOutput(FIRST, "hello from the shell\r\n$ ");
    await app.waitFor("hello from the shell");
    const rows = app.rows();
    const transcript = rows.findIndex((row) => row.includes("Nothing said yet."));
    const header = rows.findIndex((row) => row.includes("terminal · desk"));
    const output = rows.findIndex((row) => row.includes("hello from the shell"));
    const composer = rows.findIndex((row) => row.includes("› "));
    expect(transcript).toBeLessThan(header);
    expect(header).toBeLessThan(output);
    expect(output).toBeLessThan(composer);
  });

  it("reopens the terminal the session already has, from its scrollback, and sizes it to the pane", async () => {
    const { app, env } = await opened({ terminals: [{ id: EXISTING, output: "earlier output\r\n$ ", cols: 80, rows: 24 }] });
    await command(app, "/terminal");
    await app.waitFor("earlier output");
    expect(env.terminals()).toHaveLength(1);
    await app.waitUntil(() => env.terminal(EXISTING).resizes.length === 1, "the terminal to be resized");
    expect(env.terminal(EXISTING).resizes).toEqual([PANE]);
    expect(env.requests("terminals.open")).toEqual([]);
  });

  it("sizes the terminal again when the pane is drawn at another size", async () => {
    const { app, env } = await opened();
    await command(app, "/terminal");
    await app.waitFor("terminal · desk");
    await app.resize({ columns: 128, rows: 40 });
    await app.waitUntil(() => env.terminal(FIRST).resizes.length === 1, "the terminal to be resized");
    expect(env.terminal(FIRST).resizes).toEqual([{ cols: 100, rows: 16 }]);
  });

  it("sizes the terminal once the environment is back when the pane was resized while it could not be reached", async () => {
    const { app, env } = await opened();
    await command(app, "/terminal");
    await app.waitFor("terminal · desk");
    env.server.drop();
    await app.waitFor("reconnecting");
    await app.resize({ columns: 128, rows: 40 });
    await app.waitUntil(() => !app.frame().includes("reconnecting"), "the environment to be back");
    await app.waitUntil(() => env.terminal(FIRST).resizes.length === 1, "the terminal to be sized to the pane");
    expect(env.terminal(FIRST).resizes).toEqual([{ cols: 100, rows: 16 }]);
  });

  it("refuses at once with one line while the environment cannot be reached, asking it nothing", async () => {
    const { app, env } = await opened();
    env.autoAccept(false);
    env.discovery("nothing");
    env.server.drop();
    await app.waitFor("◌ cached");
    await command(app, "/terminal");
    await app.waitFor(/No terminal: desk cannot be reached\./);
    expect(app.frame()).not.toContain("terminal · desk");
    expect(env.requests("terminals.list")).toEqual([]);
    expect(env.requests("terminals.open")).toEqual([]);
  });

  it("closes the pane with a line when the terminal's shell exits", async () => {
    const { app, env } = await opened();
    await command(app, "/terminal");
    await app.waitFor("terminal · desk");
    env.exitTerminal(FIRST, 3);
    await app.waitFor("The terminal on desk exited with code 3.");
    expect(app.frame()).not.toContain("terminal · desk");
  });
});

describe("keys in the pane", () => {
  it("forwards every key through terminals.write while the pane has the keys, Ctrl+C, the arrows, Esc and Tab included", async () => {
    const { app } = await opened();
    await command(app, "/terminal");
    await app.waitFor("The terminal has the keys");
    await app.type("ls");
    await app.press(KEY.enter, KEY.ctrlC, KEY.up, KEY.tab, KEY.esc);
    await app.waitUntil(() => written(app, FIRST) === "ls\r\u0003\u001B[A\t\u001B", "every key to reach the terminal");
    expect(app.frame()).toContain("terminal · desk");
  });

  it("sends a paste as the application asked: wrapped when it turned bracketed paste on", async () => {
    const { app, env } = await opened();
    await command(app, "/terminal");
    await app.waitFor("The terminal has the keys");
    // Drawn once the emulator has taken the chunk in, the mode with it.
    env.terminalOutput(FIRST, "\u001B[?2004h$ ready");
    await app.waitFor("$ ready");
    await app.paste("one\ntwo");
    await app.waitUntil(() => written(app, FIRST) === "\u001B[200~one\ntwo\u001B[201~", "the paste to reach the terminal");
  });

  it("leaves the pane on Ctrl+\\ for the next stop, the transcript; pressed twice it sends the key to the shell and keeps the pane", async () => {
    const { app } = await opened();
    await command(app, "/terminal");
    await app.waitFor("The terminal has the keys");
    await app.press(KEY.ctrlBackslash);
    await app.waitFor("The transcript has the keys");
    await app.press(KEY.ctrlBackslash);
    await app.waitFor("The terminal has the keys");
    await app.waitUntil(() => written(app, FIRST) === "\u001C", "the literal to reach the shell");
    // Left again, a key between the two presses makes the second one a leave from the transcript, not a literal.
    await app.press(KEY.ctrlBackslash);
    await app.waitFor("The transcript has the keys");
    await app.press(KEY.esc);
    await app.waitFor("› ");
    await app.press(KEY.ctrlBackslash);
    // Back in the pane, a key typed there is the next thing written: the Ctrl+\\ from the composer wrote nothing.
    await app.press(KEY.tab, KEY.tab);
    await app.waitFor("The terminal has the keys");
    await app.type("z");
    await app.waitUntil(() => written(app, FIRST) === "\u001Cz", "the key to follow the literal");
  });

  it("sends the literal only when Ctrl+\\ comes again within half a second of leaving", async () => {
    const { app } = await opened();
    await command(app, "/terminal");
    await app.waitFor("The terminal has the keys");
    await app.press(KEY.ctrlBackslash);
    await app.waitFor("The transcript has the keys");
    await app.advance(600);
    await app.press(KEY.ctrlBackslash);
    await app.press(KEY.tab, KEY.tab, KEY.tab);
    await app.waitFor("The terminal has the keys");
    await app.type("z");
    await app.waitUntil(() => written(app, FIRST) === "z", "only the key typed in the pane to reach the shell");
  });

  it("walks Tab through the pane while it is open, before the transcript", async () => {
    const { app } = await opened();
    await command(app, "/terminal");
    await app.waitFor("The terminal has the keys");
    await app.press(KEY.ctrlBackslash, KEY.esc);
    await app.press(KEY.tab);
    await app.waitFor("The rail has the keys");
    await app.press(KEY.tab);
    await app.waitFor("The terminal has the keys");
    await app.type("x");
    await app.waitUntil(() => written(app, FIRST) === "x", "the key to reach the terminal");
  });

  it("opens the retained scrollback in the pager on Ctrl+O, and gives the pane its keys back when it closes", async () => {
    const { app, env } = await opened();
    await command(app, "/terminal");
    await app.waitFor("The terminal has the keys");
    env.terminalOutput(FIRST, Array.from({ length: 40 }, (_, i) => `scrolled line ${i + 1}`).join("\r\n"));
    await app.waitFor("scrolled line 40");
    expect(app.frame()).not.toContain("scrolled line 1\n");
    await app.press(KEY.ctrlO);
    await app.waitFor("Terminal scrollback");
    await app.press("g");
    await app.waitFor(/scrolled line 1$/m);
    await app.press("q");
    await app.waitFor("The terminal has the keys");
    await app.type("y");
    await app.waitUntil(() => written(app, FIRST) === "y", "the key to reach the terminal");
  });
});

describe("a reconnect", () => {
  it("resubscribes from the cursor and replays what the pane missed, each chunk once and in order, then goes on live", async () => {
    const { app, env } = await opened();
    await command(app, "/terminal");
    await app.waitFor("The terminal has the keys");
    env.terminalOutput(FIRST, "before the blip\r\n");
    await app.waitFor("before the blip");
    const before = env.requests("terminals.subscribe").at(-1)?.params;
    expect(before).toMatchObject({ id: FIRST, afterSequence: 0 });

    env.server.drop();
    await app.waitFor("reconnecting");
    env.terminalOutput(FIRST, "during the blip\r\n");
    await app.waitFor("during the blip", 400);
    const after = env.requests("terminals.subscribe").at(-1)?.params;
    expect(after).toMatchObject({ id: FIRST, afterSequence: 2 });
    env.terminalOutput(FIRST, "after the blip\r\n");
    await app.waitFor("after the blip");
    expect(rowsWith(app, "blip")).toEqual(["$ before the blip", "during the blip", "after the blip"]);
  });

  it("draws the pane again from the snapshot when the scrollback no longer reaches its cursor, and says so on the scrollback page", async () => {
    const { app, env } = await opened();
    await command(app, "/terminal");
    await app.waitFor("The terminal has the keys");
    env.terminalOutput(FIRST, "long gone\r\n");
    await app.waitFor("long gone");
    env.server.drop();
    await app.waitFor("reconnecting");
    env.terminalOutput(FIRST, "dropped too\r\n");
    env.terminalOutput(FIRST, "kept\r\n");
    env.dropScrollback(FIRST, 3);
    await app.waitFor("kept", 400);
    expect(app.frame()).not.toContain("long gone");
    expect(app.frame()).not.toContain("dropped too");
    await app.press(KEY.ctrlO);
    await app.waitFor("Terminal scrollback · desk · earlier output dropped");
  });
});

describe("a shell line", () => {
  const startsOf = (app: RenderedApp) => app.environment("desk").requests("runs.start").map((r) => r.params);
  const history = (app: RenderedApp) =>
    readFileSync(join(app.stateDir, "history.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as { readonly text: string }).text);

  it("runs ! and a command in a terminal of its own, shown in the pane, never typed into the session's shell, the composer keeping the keys", async () => {
    const { app, env } = await opened({ terminals: [{ id: EXISTING, output: "vim is running\r\n" }], oneOff: () => ({ output: "total 0\n" }) });
    await command(app, "!ls -la");
    await app.waitFor("total 0");
    expect(app.frame()).toContain("!ls -la · desk");
    expect(env.terminal(FIRST).env).toEqual({ AGENT_HARNESS_ONE_OFF: "ls -la" });
    expect(env.terminal(FIRST).writes).toEqual([ONE_OFF_LINE]);
    expect(env.terminal(EXISTING).writes).toEqual([]);
    expect(app.frame()).not.toContain("The terminal has the keys");
    await app.type("next");
    await app.waitFor("› next");
    expect(env.terminal(FIRST).writes).toEqual([ONE_OFF_LINE]);
    expect(startsOf(app)).toEqual([]);
  });

  it("closes a ! command's terminal when it exits, keeping what it showed in the pane until a key there closes it", async () => {
    const { app, env } = await opened({ oneOff: () => ({ output: "total 0\n" }) });
    await command(app, "!ls");
    await app.waitFor("total 0");
    env.exitTerminal(FIRST, 2);
    await app.waitFor("!ls · desk · exit 2");
    await app.waitUntil(() => env.terminal(FIRST).closed, "the terminal to be closed");
    expect(app.frame()).toContain("total 0");
    await app.press(KEY.tab, KEY.tab);
    await app.waitFor("any key closes it");
    await app.type("q");
    await app.waitFor("message the agent");
    expect(app.frame()).not.toContain("total 0");
    expect(env.terminal(FIRST).writes).toEqual([ONE_OFF_LINE]);
  });

  it("opens the session's shell on /terminal while a ! command runs, and closes that command's terminal when it exits later", async () => {
    const { app, env } = await opened({ oneOff: () => ({ output: "watching\n" }) });
    await command(app, "!watch ls");
    await app.waitFor("watching");
    await command(app, "/terminal");
    await app.waitFor("terminal · desk");
    expect(env.requests("terminals.open").map((r) => r.params["id"])).toEqual([FIRST, SECOND]);
    expect(env.terminal(SECOND).env).toEqual({});
    env.exitTerminal(FIRST, 0);
    await app.waitFor("`watch ls` on desk exited with code 0.");
    await app.waitUntil(() => env.terminal(FIRST).closed, "the command's terminal to be closed");
    expect(app.frame()).toContain("terminal · desk");
  });

  it("runs !! and a command in a terminal of its own and sends what it printed to the agent, closing that terminal", async () => {
    const { app, env } = await opened({ oneOff: (script) => ({ output: script === "echo hi" ? "hi\n" : "", exitCode: 0 }) });
    await command(app, "!!echo hi");
    await app.waitUntil(() => startsOf(app).length === 1, "the output to be sent to the agent");
    expect(startsOf(app)[0]).toMatchObject({ sessionId: SESSION, text: "Ran `echo hi`:\n```\nhi\n```" });
    // The command rode the terminal's environment, never typed: the line typed is always the same.
    const terminal = env.terminal(FIRST);
    expect(terminal.env["AGENT_HARNESS_ONE_OFF"]).toMatch(/\necho hi$/);
    expect(terminal.env).toMatchObject({ PAGER: "cat", GIT_PAGER: "cat", MANPAGER: "cat", SYSTEMD_PAGER: "cat" });
    expect(terminal.writes).toEqual([ONE_OFF_LINE]);
    await app.waitUntil(() => env.terminal(FIRST).closed, "the one-off terminal to be closed");
    expect(app.frame()).not.toContain("terminal · desk");
    // The prompt history holds the line typed, not the message it became.
    expect(history(app)).toEqual(["!!echo hi"]);
  });

  it("says how a !! command ended when it did not end cleanly", async () => {
    const { app } = await opened({ oneOff: () => ({ output: "no such file\n", exitCode: 2 }) });
    await command(app, "!!cat nope");
    await app.waitUntil(() => startsOf(app).length === 1, "the output to be sent to the agent");
    expect(startsOf(app)[0]).toMatchObject({ text: "Ran `cat nope`:\n```\nno such file\nexit 2\n```" });
  });

  it("sends nothing when the login shell never ran the command, and says what it showed", async () => {
    const { app } = await opened({ posixShell: false });
    await command(app, "!!ls");
    await app.waitFor("Not run: The shell never started it before its terminal ended; it last showed: nu: unknown command: exec");
    expect(startsOf(app)).toEqual([]);
  });

  it("sends a !! command's output to nobody when its session is no longer open, and leaves a later line alone", async () => {
    const { app, env } = await opened({
      sessions: [
        { title: "Receipts", workspace: { kind: "directory", path: "/home/seth/receipts" } },
        { title: "Parser", workspace: { kind: "directory", path: "/home/seth/parser" } },
      ],
      oneOff: () => ({ output: "slow\n" }),
    });
    await command(app, "!!sleep 5");
    await app.waitFor("Running sleep 5 on desk…");
    await command(app, "/resume");
    await app.waitFor("Sessions");
    await app.type("Pars");
    await app.press(KEY.enter);
    await app.waitFor("Parser");
    env.exitTerminal(FIRST, 0);
    await app.waitFor("The output of sleep 5 was not sent: its session is no longer open.");
    expect(startsOf(app)).toEqual([]);
  });

  it("keeps a line said while a !! command ran when it sends the output", async () => {
    const { app, env } = await opened({ oneOff: () => ({ output: "slow\n" }) });
    await command(app, "!!sleep 5");
    await app.waitFor("Running sleep 5 on desk…");
    await command(app, "/files nope.txt");
    await app.waitFor("Not read:");
    env.exitTerminal(FIRST, 0);
    await app.waitUntil(() => startsOf(app).length === 1, "the output to be sent to the agent");
    await app.tick(2);
    expect(app.frame()).toContain("Not read:");
  });

  it("does not reopen a !! command's terminal for /terminal while the command runs", async () => {
    const { app, env } = await opened({ oneOff: () => ({ output: "slow\n" }) });
    await command(app, "!!sleep 5");
    await app.waitUntil(() => env.terminals().length === 1 && env.terminal(FIRST).writes.length === 1, "the command to run");
    await command(app, "/terminal");
    await app.waitFor("terminal · desk");
    await app.waitUntil(() => env.requests("terminals.open").length === 2, "a terminal to be opened for the shell");
    await app.type("x");
    await app.waitUntil(() => written(app, SECOND) === "x", "the key to reach the shell's terminal");
    expect(env.terminal(FIRST).writes).toEqual([ONE_OFF_LINE]);
  });

  it("refuses ! and !! at once with one line while the environment cannot be reached", async () => {
    const { app, env } = await opened();
    env.autoAccept(false);
    env.discovery("nothing");
    env.server.drop();
    await app.waitFor("◌ cached");
    await command(app, "!!ls");
    await app.waitFor(/Not run: desk cannot be reached\./);
    expect(app.frame()).toContain("✕ !!ls");
    await app.press(KEY.ctrlU);
    await command(app, "!pwd");
    await app.waitFor("✕ !pwd");
    expect(app.frame()).toMatch(/Not run: desk cannot be reached\./);
    expect(app.frame()).not.toContain("!pwd · desk");
    expect(env.terminals()).toEqual([]);
  });
});
