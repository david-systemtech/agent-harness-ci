import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Instance, RenderOptions } from "ink";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { KEY, SIZE, appUnderTest, renderApp, settle, type RenderedApp } from "../test/harness.js";
import { render as inkRender } from "ink";
import { INK_MAX_FPS, inkOptions } from "./app.js";
import { FRAME_MS } from "./frames.js";
import { runTui } from "./index.js";
import type { LocalService } from "./platform/services.js";

/**
 * Rendering (docs/specs/tui.md, "Rendering"): Ink 7 on the alternate screen,
 * `exitOnCtrlC` off, `incrementalRendering` on, no synchronized-output
 * escape written by the terminal UI (Ink 7.1.1 writes its own), and one
 * frame per 16 ms under streaming with keyboard input bypassing the
 * throttle.
 */

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

/** A terminal Ink sees as one: a TTY of a fixed size, recording every write. */
class FakeTerminal extends EventEmitter {
  readonly isTTY = true;
  readonly columns = SIZE.columns;
  readonly rows = SIZE.rows;
  readonly writes: string[] = [];
  write = (chunk: string) => {
    this.writes.push(chunk);
    return true;
  };
}

class FakeKeyboard extends EventEmitter {
  readonly isTTY = true;
  private data: string | null = null;
  send = (bytes: string) => {
    this.data = bytes;
    this.emit("readable");
  };
  read = () => {
    const data = this.data;
    this.data = null;
    return data;
  };
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const BSU = "\u001B[?2026h";
const ESU = "\u001B[?2026l";

describe("the Ink options", () => {
  it("are the alternate screen, no exit on Ctrl+C, incremental rendering, and Ink's own throttle out of the way", () => {
    const streams = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };
    expect(inkOptions(streams)).toEqual({
      ...streams,
      // Ink 7.1.1 turns itself non-interactive when `CI` is set (is-in-ci): no alternate screen, no incremental
      // rendering, no synchronized output. The terminal UI runs only on a terminal, so it says it is interactive.
      interactive: true,
      alternateScreen: true,
      exitOnCtrlC: false,
      incrementalRendering: true,
      maxFps: INK_MAX_FPS,
    });
    expect(Math.ceil(1000 / INK_MAX_FPS)).toBeLessThan(FRAME_MS);
  });

  it("are what `runTui` renders with", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "agent-harness-tui-render-"));
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
    const seen: RenderOptions[] = [];
    const render = (_element: ReactElement, options: RenderOptions): Instance => {
      seen.push(options);
      return { waitUntilExit: async () => undefined } as unknown as Instance;
    };
    const terminal = new FakeTerminal() as unknown as NodeJS.WriteStream;
    const keyboard = new FakeKeyboard() as unknown as NodeJS.ReadStream;
    const services: LocalService = {
      installed: async () => false,
      install: async () => ({ ok: false, message: "" }),
      start: async () => ({ ok: false, message: "" }),
      readiness: async () => "nothing",
    };
    const code = await runTui({ dataDir: stateDir, stateDir, version: "0.0.0-test", services, stdin: keyboard, stdout: terminal, stderr: terminal, render });
    expect(code).toBe(0);
    expect(seen).toEqual([
      expect.objectContaining({ interactive: true, alternateScreen: true, exitOnCtrlC: false, incrementalRendering: true, maxFps: INK_MAX_FPS }),
    ]);
  });

  it("refuses to run without a terminal", async () => {
    const out = new FakeTerminal();
    const piped = Object.assign(new FakeTerminal(), { isTTY: false });
    const services = {} as LocalService;
    const code = await runTui({
      dataDir: tmpdir(),
      version: "0.0.0-test",
      services,
      stdin: piped as unknown as NodeJS.ReadStream,
      stdout: out as unknown as NodeJS.WriteStream,
      stderr: out as unknown as NodeJS.WriteStream,
    });
    expect(code).toBe(1);
    expect(out.writes.join("")).toContain("needs a terminal");
  });
});

describe("Ink 7.1.1 on a terminal", () => {
  it("enters the alternate screen, frames each write in Ink's synchronized output, and redraws only the lines a key changed", async () => {
    const built = await appUnderTest({ script: { environments: [{ name: "desk", reach: "local" }] } });
    const terminal = new FakeTerminal();
    const keyboard = new FakeKeyboard();
    const streams = {
      stdin: keyboard as unknown as NodeJS.ReadStream,
      stdout: terminal as unknown as NodeJS.WriteStream,
      stderr: terminal as unknown as NodeJS.WriteStream,
    };
    // The terminal UI's options as they are; only the console is left alone, which the test runner owns.
    const instance = inkRender(built.element, { ...inkOptions(streams), patchConsole: false });
    cleanups.push(async () => {
      instance.unmount();
      await built.host.close();
    });
    await settle();
    await wait(10);
    const output = () => terminal.writes.join("");
    expect(terminal.writes[0]).toBe("\u001B[?1049h");
    expect(output()).toContain("● desk ready");

    const before = terminal.writes.length;
    keyboard.send("x");
    await settle();
    await wait(10);
    const redraw = terminal.writes.slice(before).join("");
    expect(redraw).toContain("› x");
    // Only the composer's line is rewritten: the header and the rail are not written again, and the screen is not cleared.
    expect(redraw).not.toContain("agent-harness");
    expect(redraw).not.toContain("no sessions");
    expect(redraw).not.toContain("\u001B[2J");
    // Every synchronized-output pair is Ink's, one around each frame.
    expect(output().split(BSU).length).toBe(output().split(ESU).length);
    expect(output().split(BSU).length).toBeGreaterThan(1);
  });

  it("writes no synchronized-output escape of its own: none is in its source", () => {
    const root = join(import.meta.dirname);
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) expect(readFileSync(join(root, file), "utf8"), file).not.toMatch(/\?2026|2026[hl]/);
  });
});

describe("the frame throttle", () => {
  let app: RenderedApp;
  afterEach(async () => app?.unmount());

  it("draws the runtime's changes one frame per 16 ms, and a key at once with what is waiting", async () => {
    app = await renderApp({ script: { environments: [{ name: "desk", reach: "local" }, { name: "laptop", reach: "paired" }] } });
    await app.waitFor("● desk ready");
    await app.tick(3);
    // A quiet spell: a window passes with nothing drawn.
    app.clock.advance(FRAME_MS);
    await settle();
    const runtime = app.runtime();
    const laptop = app.environment("laptop").environmentId;

    // Disabling is two changes in one instant: the enabled flag, then the phase. The first is drawn at once, the second at the window's end.
    const before = app.frames();
    await runtime.connections.setEnabled(laptop, false);
    await settle();
    expect(app.frames()).toBe(before + 1);
    expect(app.frame()).not.toContain("disabled");
    await app.tick();
    expect(app.frames()).toBe(before + 2);
    expect(app.frame()).toMatch(/laptop\s+│[\s\S]*disabled/);

    // Streaming: however many changes land within a window, one frame is drawn for them.
    const streaming = app.frames();
    await runtime.connections.setEnabled(laptop, true);
    await settle();
    expect(app.frames()).toBe(streaming);
    expect(app.frame()).toContain("disabled");

    // A key draws what is waiting at once, with its own echo.
    await app.press("z");
    expect(app.frame()).toContain("› z");
    expect(app.frame()).not.toContain("disabled");
    await app.press(KEY.backspace);
  });
});
