import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ReactElement } from "react";
import type { Instance } from "ink";
import { afterEach, describe, expect, it } from "vitest";
import { runTui } from "../index.js";
import type { LocalService } from "../platform/services.js";
import type { ColourDepth } from "./colours.js";
import { askGround, groundOf } from "./ground.js";

/**
 * The terminal's ground (David, 2026-09-28, on #392): a light-background
 * terminal gets the theme's light ladder. At launch, under truecolour, the
 * terminal UI asks the terminal's background colour (OSC 11) and then its
 * device attributes (DA1), which every terminal answers, so that answer
 * coming first says there is no other; with none the ground is dark, and
 * `AGENT_HARNESS_TUI_BACKGROUND` overrides the choice.
 */

const QUERIES = "\u001B]11;?\u001B\\\u001B[c";
const ATTRIBUTES = "\u001B[?62;22c";

/** A keyboard that is a TTY in raw mode or not, which the scripted terminal answers on. */
class FakeKeyboard extends PassThrough {
  readonly isTTY = true;
  isRaw = false;
  readonly modes: boolean[] = [];
  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.modes.push(mode);
    return this;
  }
}

/** A terminal that records what is written to it and answers the queries with `answer`, unless it is undefined. */
const terminalAnswering = (keyboard: FakeKeyboard, answer: string | undefined) => {
  const writes: string[] = [];
  const write = (chunk: string) => {
    writes.push(chunk);
    if (answer !== undefined && chunk.includes("\u001B[c")) queueMicrotask(() => keyboard.write(answer));
    return true;
  };
  return { writes, stream: Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 30, write }) as unknown as NodeJS.WriteStream };
};

/** A timer that fires only when told to. */
const heldTimer = () => {
  let fire: (() => void) | undefined;
  return { setTimer: (callback: () => void) => ((fire = callback), () => (fire = undefined)), fire: () => fire?.() };
};

const ask = (keyboard: FakeKeyboard, answer: string | undefined, timer = heldTimer()) => {
  const terminal = terminalAnswering(keyboard, answer);
  const asked = askGround({ stdin: keyboard as unknown as NodeJS.ReadStream, stdout: terminal.stream, setTimer: timer.setTimer });
  return { asked, writes: terminal.writes, timer };
};

describe("the ground a background colour names", () => {
  it.each([
    ["rgb:0000/0000/0000", "dark"],
    ["rgb:1e1e/1e1e/2e2e", "dark"],
    ["rgb:ffff/ffff/ffff", "light"],
    ["rgb:fd/f6/e3", "light"],
    ["rgb:f/f/f", "light"],
    ["rgba:2828/2c2c/3434/ffff", "dark"],
  ] as const)("%s is %s", (colour, ground) => {
    expect(groundOf(`\u001B]11;${colour}\u001B\\`)).toBe(ground);
    expect(groundOf(`\u001B]11;${colour}\u0007`)).toBe(ground);
  });

  it("is none for an answer that names no colour", () => {
    expect(groundOf(ATTRIBUTES)).toBeUndefined();
    expect(groundOf("\u001B]11;?\u001B\\")).toBeUndefined();
  });
});

describe("asking the terminal", () => {
  it("writes the background colour query, then the attributes query, in raw mode, and hears a light ground", async () => {
    const keyboard = new FakeKeyboard();
    const { asked, writes } = ask(keyboard, `\u001B]11;rgb:fafa/fafa/fafa\u001B\\${ATTRIBUTES}`);
    await expect(asked).resolves.toBe("light");
    expect(writes.join("")).toBe(QUERIES);
    expect(keyboard.modes).toEqual([true, false]);
  });

  it("hears a dark ground in an answer cut across reads", async () => {
    const keyboard = new FakeKeyboard();
    const { asked } = ask(keyboard, undefined);
    keyboard.write("\u001B]11;rgb:1010/");
    await new Promise((resolve) => setImmediate(resolve));
    keyboard.write(`1010/1010\u0007${ATTRIBUTES}`);
    await expect(asked).resolves.toBe("dark");
  });

  it("hears none from a terminal with no background colour to give, without waiting for the timer", async () => {
    const keyboard = new FakeKeyboard();
    const { asked } = ask(keyboard, ATTRIBUTES);
    await expect(asked).resolves.toBeUndefined();
  });

  it("hears none from a terminal that answers nothing, once the wait is over", async () => {
    const keyboard = new FakeKeyboard();
    const { asked, timer } = ask(keyboard, undefined);
    timer.fire();
    await expect(asked).resolves.toBeUndefined();
    expect(keyboard.modes).toEqual([true, false]);
  });

  it("hands back keys typed after the answers, for the screen to read", async () => {
    const keyboard = new FakeKeyboard();
    const { asked } = ask(keyboard, `\u001B]11;rgb:0000/0000/0000\u001B\\${ATTRIBUTES}hi`);
    await expect(asked).resolves.toBe("dark");
    expect(String(keyboard.read())).toBe("hi");
  });

  it("asks nothing of an input that cannot be put in raw mode", async () => {
    const terminal = terminalAnswering(new FakeKeyboard(), ATTRIBUTES);
    const piped = new PassThrough() as unknown as NodeJS.ReadStream;
    await expect(askGround({ stdin: piped, stdout: terminal.stream })).resolves.toBeUndefined();
    expect(terminal.writes).toEqual([]);
  });
});

describe("agent-harness tui's colour depth", () => {
  let cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    cleanups = [];
  });

  /** Runs the terminal UI on a keyboard the terminal answers on, and says the colour depth the screen was given. */
  const launched = async (env: NodeJS.ProcessEnv, answer: string | undefined) => {
    const stateDir = mkdtempSync(join(tmpdir(), "agent-harness-tui-ground-"));
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
    const keyboard = new FakeKeyboard();
    const terminal = terminalAnswering(keyboard, answer);
    const depths: (ColourDepth | undefined)[] = [];
    const render = (element: ReactElement<{ readonly depth?: ColourDepth }>): Instance => {
      depths.push(element.props.depth);
      return { waitUntilExit: async () => undefined } as unknown as Instance;
    };
    const services: LocalService = {
      installed: async () => false,
      install: async () => ({ ok: false, message: "" }),
      start: async () => ({ ok: false, message: "" }),
      readiness: async () => "nothing",
    };
    const stdin = keyboard as unknown as NodeJS.ReadStream;
    const code = await runTui({ dataDir: stateDir, stateDir, version: "0.0.0-test", services, stdin, stdout: terminal.stream, stderr: terminal.stream, render, env });
    expect(code).toBe(0);
    return { depths, writes: terminal.writes };
  };

  it("is truecolour on the ground the terminal answers, under COLORTERM=truecolor", async () => {
    const { depths, writes } = await launched({ COLORTERM: "truecolor" }, `\u001B]11;rgb:ffff/ffff/ffff\u001B\\${ATTRIBUTES}`);
    expect(depths).toEqual([{ truecolour: true, ground: "light" }]);
    expect(writes.join("")).toContain(QUERIES);
  });

  it("is dark where the terminal has no background colour to give", async () => {
    const { depths } = await launched({ COLORTERM: "24bit" }, ATTRIBUTES);
    expect(depths).toEqual([{ truecolour: true, ground: "dark" }]);
  });

  it("takes AGENT_HARNESS_TUI_BACKGROUND's ground without asking the terminal", async () => {
    const { depths, writes } = await launched({ COLORTERM: "truecolor", AGENT_HARNESS_TUI_BACKGROUND: "light" }, `\u001B]11;rgb:0000/0000/0000\u001B\\${ATTRIBUTES}`);
    expect(depths).toEqual([{ truecolour: true, ground: "light" }]);
    expect(writes.join("")).not.toContain(QUERIES);
  });

  it("asks nothing without truecolour: the sixteen alone are drawn", async () => {
    const { depths, writes } = await launched({}, `\u001B]11;rgb:ffff/ffff/ffff\u001B\\${ATTRIBUTES}`);
    expect(depths).toEqual([{ truecolour: false, ground: "dark" }]);
    expect(writes.join("")).not.toContain(QUERIES);
  });
});
