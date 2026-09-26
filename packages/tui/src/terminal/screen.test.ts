import { describe, expect, it } from "vitest";
import { createScreen, colourOf } from "./screen.js";

/**
 * The pane's screen model (docs/specs/tui.md, "The terminal pane"): a
 * headless terminal emulator (`@xterm/headless`) the terminal's output is
 * written into, read back as rows of styled spans Ink's `Text` can carry.
 * Verified here, for the ticket's "verify first": every cell attribute the
 * emulator exposes has a carrier (a palette colour as `ansi256(n)`, a true
 * colour as `#rrggbb`, bold, dim, italic, underline, inverse,
 * strikethrough).
 */

const ESC = "\u001B";

describe("the screen", () => {
  it("reads a row's cells back as spans of one style each, with the colours and attributes the output set", async () => {
    const screen = createScreen({ cols: 40, rows: 3 });
    await screen.write(`${ESC}[31mred${ESC}[0m ${ESC}[1;38;5;208mbold orange${ESC}[0m ${ESC}[38;2;10;20;30;48;2;255;0;128mrgb${ESC}[0m`);
    expect(screen.view()[0]).toEqual([
      { text: "red", color: "ansi256(1)" },
      { text: " " },
      { text: "bold orange", color: "ansi256(208)", bold: true },
      { text: " " },
      { text: "rgb", color: "#0a141e", background: "#ff0080" },
    ]);
  });

  it("carries dim, italic, underline, inverse and strikethrough, and draws invisible text as blanks", async () => {
    const screen = createScreen({ cols: 40, rows: 2 });
    await screen.write(`${ESC}[2md${ESC}[0m${ESC}[3mi${ESC}[0m${ESC}[4mu${ESC}[0m${ESC}[7mv${ESC}[0m${ESC}[9ms${ESC}[0m${ESC}[8mhidden${ESC}[0m.`);
    expect(screen.view()[0]).toEqual([
      { text: "d", dim: true },
      { text: "i", italic: true },
      { text: "u", underline: true },
      { text: "v", inverse: true },
      { text: "s", strikethrough: true },
      { text: "      ." },
    ]);
  });

  it("shows the rows on screen now: output past the bottom scrolls, and a carriage return overwrites", async () => {
    const screen = createScreen({ cols: 20, rows: 2 });
    await screen.write("one\r\ntwo\r\nthree\r\n50%\r100%");
    expect(screen.view().map((line) => line.map((s) => s.text).join(""))).toEqual(["three", "100%"]);
  });

  it("marks the cursor's cell inverse when asked, a blank one past the text included", async () => {
    const screen = createScreen({ cols: 10, rows: 1 });
    await screen.write("$ ls");
    expect(screen.view({ cursor: true })[0]).toEqual([{ text: "$ ls" }, { text: " ", inverse: true }]);
    await screen.write("\b\b");
    expect(screen.view({ cursor: true })[0]).toEqual([{ text: "$ " }, { text: "l", inverse: true }, { text: "s" }]);
  });

  it("draws no cursor while the application hides it, and draws it again once it shows it or the screen is reset", async () => {
    const screen = createScreen({ cols: 10, rows: 1 });
    await screen.write(`${ESC}[?25lab`);
    expect(screen.view({ cursor: true })[0]).toEqual([{ text: "ab" }]);
    await screen.write(`${ESC}[?25h`);
    expect(screen.view({ cursor: true })[0]).toEqual([{ text: "ab" }, { text: " ", inverse: true }]);
    await screen.write(`${ESC}[?25l`);
    await screen.reset("x");
    expect(screen.view({ cursor: true })[0]).toEqual([{ text: "x" }, { text: " ", inverse: true }]);
  });

  it("keeps a wide character's second cell out of the text", async () => {
    const screen = createScreen({ cols: 10, rows: 1 });
    await screen.write("a漢b");
    expect(screen.view()[0]).toEqual([{ text: "a漢b" }]);
  });

  it("holds the scrollback: the history is every line, the oldest first, with no trailing blank lines", async () => {
    const screen = createScreen({ cols: 20, rows: 2 });
    await screen.write(`${ESC}[32mone${ESC}[0m\r\ntwo\r\nthree\r\n`);
    expect(screen.history().map((line) => line.map((s) => s.text).join(""))).toEqual(["one", "two", "three"]);
    expect(screen.history()[0]).toEqual([{ text: "one", color: "ansi256(2)" }]);
  });

  it("gives its text with wrapped lines joined and each line's trailing blanks trimmed, for what a command said", async () => {
    const screen = createScreen({ cols: 5, rows: 2, scrollback: 100 });
    await screen.write(`abcdefgh  \r\n${ESC}[31mok${ESC}[0m\r\n\r\n`);
    expect(screen.text()).toBe("abcdefgh\nok");
  });

  it("starts again from a reset: what was on it goes, and the modes an app set with it", async () => {
    const screen = createScreen({ cols: 20, rows: 2 });
    await screen.write(`old${ESC}[?1h${ESC}[?2004h`);
    expect(screen.modes()).toEqual({ applicationCursorKeys: true, bracketedPaste: true });
    await screen.reset("new");
    expect(screen.view()[0]).toEqual([{ text: "new" }]);
    expect(screen.modes()).toEqual({ applicationCursorKeys: false, bracketedPaste: false });
  });

  it("is resized to the pane, rewrapping nothing it cannot", async () => {
    const screen = createScreen({ cols: 20, rows: 2 });
    screen.resize(8, 3);
    expect({ cols: screen.cols(), rows: screen.rows() }).toEqual({ cols: 8, rows: 3 });
    expect(screen.view()).toHaveLength(3);
  });
});

describe("a cell's colour", () => {
  it("is the palette entry as ansi256, a true colour as hex, and nothing for the default", () => {
    expect(colourOf({ palette: true, rgb: false, value: 12 })).toBe("ansi256(12)");
    expect(colourOf({ palette: false, rgb: true, value: 0x0a141e })).toBe("#0a141e");
    expect(colourOf({ palette: false, rgb: false, value: 0 })).toBeUndefined();
  });
});
