import { describe, expect, it } from "vitest";

import { printableText } from "./picker.js";

const plain = { ctrl: false, meta: false, escape: false, tab: false, return: false, backspace: false, delete: false };

describe("what a key typed at a list adds to its query", () => {
  it("is the text, with control bytes left out and line breaks as spaces", () => {
    expect(printableText("a", plain)).toBe("a");
    expect(printableText("one\ntwo", plain)).toBe("one two");
    expect(printableText("a\u0007b", plain)).toBe("ab");
  });

  it("is nothing for a key that is not text: a chord, Enter, Esc, Tab, Backspace, or an escape sequence a key arrives as", () => {
    expect(printableText("k", { ...plain, ctrl: true })).toBeUndefined();
    expect(printableText("\r", { ...plain, return: true })).toBeUndefined();
    expect(printableText("", plain)).toBeUndefined();
    // An arrow, Home or a function key Ink does not name arrives as its sequence with no flag set: never text.
    expect(printableText("\u001b[B", plain)).toBeUndefined();
    expect(printableText("\u001b[H", plain)).toBeUndefined();
    expect(printableText("\u001bOP", plain)).toBeUndefined();
  });
});
