import { afterEach, describe, expect, it } from "vitest";
import { KEY, renderApp, type RenderedApp } from "../test/harness.js";

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

  it("refuses at once with one line while the environment cannot be reached, asking it nothing", async () => {
    const { app, env } = await opened();
    env.autoAccept(false);
    env.discovery("nothing");
    env.server.drop();
    await app.waitFor("◌ cached");
    await command(app, "/terminal");
    await app.waitFor(/No terminal: desk cannot be reached\./);
    expect(app.frame()).not.toContain("terminal · desk");
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
    env.terminalOutput(FIRST, "\u001B[?2004h$ ");
    await app.tick(2);
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
    await app.tick(2);
    expect(written(app, FIRST)).toBe("\u001C");
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
  it("resubscribes from the cursor and replays what the pane missed, keeping what it drew", async () => {
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
    expect(app.frame()).toContain("before the blip");
    const after = env.requests("terminals.subscribe").at(-1)?.params;
    expect(after).toMatchObject({ id: FIRST, afterSequence: 2 });
  });
});
