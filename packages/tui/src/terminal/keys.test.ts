import { describe, expect, it } from "vitest";
import { forwarded, keyBytes, pasted } from "./keys.js";

/**
 * What the pane sends for a key (docs/specs/tui.md, "The terminal pane"):
 * with focus every key goes to the terminal as the bytes the user's terminal
 * sent, but for the `terminal` actions' keys, which are recognised by the
 * bytes their names stand for; an application that asked for application
 * cursor keys gets its arrows in that form, and one that asked for
 * bracketed paste gets pastes wrapped.
 */

describe("the bytes a key name stands for", () => {
  it("are the control byte for Ctrl and a letter or one of the raw controls", () => {
    expect(keyBytes("Ctrl+\\")).toBe("\u001C");
    expect(keyBytes("Ctrl+O")).toBe("\u000F");
    expect(keyBytes("Ctrl+A")).toBe("\u0001");
    expect(keyBytes("Ctrl+]")).toBe("\u001D");
    expect(keyBytes("Ctrl+_")).toBe("\u001F");
  });

  it("are the sequences a terminal sends for the named keys, and Alt as an Esc before the key", () => {
    expect(keyBytes("Enter")).toBe("\r");
    expect(keyBytes("Tab")).toBe("\t");
    expect(keyBytes("Shift+Tab")).toBe("\u001B[Z");
    expect(keyBytes("Esc")).toBe("\u001B");
    expect(keyBytes("Backspace")).toBe("\u007F");
    expect(keyBytes("↑")).toBe("\u001B[A");
    expect(keyBytes("PgDn")).toBe("\u001B[6~");
    expect(keyBytes("Space")).toBe(" ");
    expect(keyBytes("Alt+x")).toBe("\u001Bx");
    expect(keyBytes("q")).toBe("q");
  });

  it("are nothing for a name no single press sends", () => {
    expect(keyBytes("Esc Esc")).toBeUndefined();
    expect(keyBytes("Letters")).toBeUndefined();
    expect(keyBytes("Ctrl+Enter")).toBeUndefined();
  });
});

describe("a key forwarded to the terminal", () => {
  const normal = { applicationCursorKeys: false, bracketedPaste: false };
  const application = { applicationCursorKeys: true, bracketedPaste: false };

  it("goes as its bytes", () => {
    expect(forwarded("\u0003", normal)).toBe("\u0003");
    expect(forwarded("\u001B[A", normal)).toBe("\u001B[A");
    expect(forwarded("ls -la", normal)).toBe("ls -la");
  });

  it("sends the arrows, Home and End in their application form when the application asked for it", () => {
    expect(forwarded("\u001B[A", application)).toBe("\u001BOA");
    expect(forwarded("\u001B[D", application)).toBe("\u001BOD");
    expect(forwarded("\u001B[H", application)).toBe("\u001BOH");
    expect(forwarded("\u001B[1;5A", application)).toBe("\u001B[1;5A");
  });

  it("wraps a paste when the application asked for bracketed paste, and not otherwise", () => {
    expect(pasted("two\nlines", { ...normal, bracketedPaste: true })).toBe("\u001B[200~two\nlines\u001B[201~");
    expect(pasted("two\nlines", normal)).toBe("two\rlines");
  });
});
