import { describe, expect, it } from "vitest";
import { eventName, parseKeyName, type InkKey } from "../keys.js";
import { forwarded, heldApart, keyBytes, pasted } from "./keys.js";

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
    expect(keyBytes("q")).toBe("q");
  });

  it("are Esc and the lower-case letter for Alt and a letter, in the form the keymap stores it", () => {
    // The keymap stores `Alt+x` as `parseKeyName` writes it, `Alt+X`; pressing Alt+x sends Esc and a lower-case x.
    const stored = parseKeyName("Alt+x");
    expect(stored).toBe("Alt+X");
    expect(keyBytes(stored as string)).toBe("\u001Bx");
    expect(keyBytes("Alt+↑")).toBe("\u001B\u001B[A");
  });

  it("are the bytes the keymap's reading of a raw control hears as that key, both ways from one table", () => {
    const none = Object.fromEntries(
      ["upArrow", "downArrow", "leftArrow", "rightArrow", "pageDown", "pageUp", "home", "end", "return", "escape", "ctrl", "shift", "tab", "backspace", "delete", "meta"].map((flag) => [
        flag,
        false,
      ]),
    ) as unknown as InkKey;
    for (const name of ["Ctrl+\\", "Ctrl+]", "Ctrl+_", "Ctrl+J"]) expect(eventName(keyBytes(name) as string, none)).toBe(name);
  });

  it("are nothing for a name no single press sends", () => {
    expect(keyBytes("Esc Esc")).toBeUndefined();
    expect(keyBytes("Letters")).toBeUndefined();
    expect(keyBytes("Ctrl+Enter")).toBeUndefined();
    // A name the table's prototype answers is not a key in the table.
    expect(keyBytes("constructor")).toBeUndefined();
    expect(keyBytes("Alt+toString")).toBeUndefined();
  });
});

describe("the pane's own keys in what one read brought", () => {
  const held = ["\u001C", "\u000F", "\u001Bx"];

  it("are cut out of the text around them, each on its own, and text without them is one piece", () => {
    expect(heldApart("\u001C\u001C", held)).toEqual(["\u001C", "\u001C"]);
    expect(heldApart("ls\u001Cpwd\u000F", held)).toEqual(["ls", "\u001C", "pwd", "\u000F"]);
    expect(heldApart("ls -la", held)).toEqual(["ls -la"]);
    expect(heldApart("\u001C", held)).toEqual(["\u001C"]);
  });

  it("leave an escape sequence whole, which Ink gives as a key of its own", () => {
    expect(heldApart("\u001Bx", held)).toEqual(["\u001Bx"]);
    // Alt+Q with the leave key remapped to q: the q in it is not the leave key.
    expect(heldApart("\u001Bq", ["q"])).toEqual(["\u001Bq"]);
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

  it("drops the bracket's own sequences from a bracketed paste, so the paste cannot end the bracket early and type the rest", () => {
    const bracketed = { ...normal, bracketedPaste: true };
    expect(pasted("echo a\u001B[201~rm -rf build\r", bracketed)).toBe("\u001B[200~echo arm -rf build\r\u001B[201~");
    expect(pasted("\u001B[200~x", bracketed)).toBe("\u001B[200~x\u001B[201~");
  });
});
