import { describe, expect, it } from "vitest";
import { colouredDiff, diffPage, plainPage, sgrPage } from "./pages.js";

/**
 * What the pager shows for a file, a diff and a diff tool's answer
 * (docs/specs/tui.md, "The composer" and "The transcript"): lines of styled
 * spans wrapped to the pager's width. A file is plain text, its tabs
 * expanded and its control bytes dropped; a diff with no tool of the user's
 * is coloured as a diff; a tool's answer keeps the colours it wrote.
 */

const texts = (lines: readonly { readonly spans: readonly { readonly text: string }[] }[]) => lines.map((line) => line.spans.map((s) => s.text).join(""));

describe("a file in the pager", () => {
  it("is its lines, tabs expanded to the next stop of eight, control bytes dropped, long lines wrapped", () => {
    expect(texts(plainPage("a\tb\r\nbell\u0007!\n0123456789abc", 10))).toEqual(["a       b", "bell!", "0123456789", "abc"]);
  });
});

describe("C1 controls in the pager", () => {
  // U+009B is CSI and U+009D OSC in their one-character forms, U+009C ST; U+0085 is NEL and U+008E, U+008F single shifts:
  // a terminal reading C1 in UTF-8 would take `U+009B 31m` in a page as a colour.
  const C1 = "a\u009B31mred\u009D8;;https://x\u009Clink\u0085nel\u008Ess\u008F";
  const noC1 = (lines: ReturnType<typeof plainPage>) => lines.every((line) => line.spans.every((span) => !/[\u0080-\u009F]/.test(span.text)));

  it("drops them from a file and from a diff, as it drops C0", () => {
    expect(texts(plainPage(C1, 60))).toEqual(["a31mred8;;https://xlinknelss"]);
    expect(texts(diffPage(`+${C1}`, 60))).toEqual(["+a31mred8;;https://xlinknelss"]);
    expect(noC1(plainPage(C1, 60)) && noC1(diffPage(C1, 60))).toBe(true);
  });

  it("reads a tool's CSI and OSC in their C1 forms as their ESC forms: an SGR kept, the rest dropped, a stray C1 dropped", () => {
    const lines = sgrPage("\u009B1mbold\u009B0m \u009D8;;https://x\u009Clink\u009D8;;\u0007 \u009B2Kstill \u009B31mred\u0085\u008E\u009B", 60);
    expect(lines.map((line) => line.spans)).toEqual([[{ text: "bold", bold: true }, { text: " link still " }, { text: "red", color: "ansi256(1)" }]]);
  });
});

describe("widths in terminal cells", () => {
  it("wraps a line of wide characters at the pager's cells, two a character, never past the width", () => {
    expect(texts(plainPage("日本語のテキスト", 10))).toEqual(["日本語のテ", "キスト"]);
    expect(texts(plainPage("ab日本", 5))).toEqual(["ab日", "本"]);
  });

  it("keeps a character whole with its combining marks at a wrap, an emoji keycap and an accent alike", () => {
    // 1 U+FE0F U+20E3 is the keycap emoji, two cells; e U+0301 is an e with its acute accent, one.
    expect(texts(plainPage("abc1\uFE0F\u20E3x", 4))).toEqual(["abc", "1\uFE0F\u20E3x"]);
    expect(texts(plainPage("abcde\u0301f", 5))).toEqual(["abcde\u0301", "f"]);
  });

  it("expands a tab after a wide character to the stop the cells reach, in a file and in a tool's page", () => {
    expect(texts(plainPage("日\tx", 40))).toEqual(["日      x"]);
    expect(texts(sgrPage("\u001B[1m日本\u001B[0m\tx", 40))).toEqual(["日本    x"]);
    expect(texts(sgrPage("\u001B[1m日本語のテ\u001B[0mキスト", 10))).toEqual(["日本語のテ", "キスト"]);
  });
});

describe("a diff in the pager", () => {
  it("is coloured as a diff: headers bold, hunks cyan, additions green, removals red", () => {
    const lines = diffPage("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same", 40);
    expect(lines.map((line) => line.spans)).toEqual([
      [{ text: "diff --git a/x b/x", bold: true }],
      [{ text: "--- a/x", bold: true }],
      [{ text: "+++ b/x", bold: true }],
      [{ text: "@@ -1 +1 @@", color: "cyan" }],
      [{ text: "-old", color: "red" }],
      [{ text: "+new", color: "green" }],
      [{ text: " same" }],
    ]);
  });
});

describe("a diff tool's answer in the pager", () => {
  it("keeps the colours and attributes it wrote, and drops every other escape", () => {
    const lines = sgrPage("\u001B[1;32m+add\u001B[0m \u001B[38;5;208mor\u001B[39m\u001B[48;2;1;2;3mbg\u001B[0m\u001B]8;;https://x\u001B\\link\u001B]8;;\u001B\\\u001B[K\n\u001B[31;7mred\u001B[27m", 40);
    expect(lines.map((line) => line.spans)).toEqual([
      [{ text: "+add", color: "ansi256(2)", bold: true }, { text: " " }, { text: "or", color: "ansi256(208)" }, { text: "bg", background: "#010203" }, { text: "link" }],
      [{ text: "red", color: "ansi256(1)", inverse: true }],
    ]);
  });

  it("reads the bright colours and the resets of each attribute", () => {
    const lines = sgrPage("\u001B[91;1;3mx\u001B[22;23my\u001B[0m\u001B[104mz", 40);
    expect(lines[0]?.spans).toEqual([{ text: "x", color: "ansi256(9)", bold: true, italic: true }, { text: "y", color: "ansi256(9)" }, { text: "z", background: "ansi256(12)" }]);
  });

  it("drops escapes with an intermediate byte, as tput sgr0 writes, and a CSI with a private marker, leaving nothing of them in the page", () => {
    // `tput sgr0` on xterm is ESC ( B then SGR 0; ESC [ > 4 ; 2 m is xterm's modifyOtherKeys, not a colour; ESC [ 1 $ p asks a mode.
    const lines = sgrPage("\u001B[1mbold\u001B(B\u001B[m plain\u001B[>4;2m still\u001B[1$p\u001B)0 end", 60);
    expect(lines[0]?.spans).toEqual([{ text: "bold", bold: true }, { text: " plain still end" }]);
  });

  it("drops a two-byte escape whose final byte is a digit, a sign or a small letter, leaving no stray byte in the page", () => {
    // ESC = and ESC > switch the keypad (xterm's smkx and rmkx), ESC 7 and ESC 8 save and restore the cursor, ESC c resets.
    const lines = sgrPage("\u001B=keypad\u001B7 saved\u001B8 back\u001B> numeric\u001Bc reset", 60);
    expect(lines[0]?.spans).toEqual([{ text: "keypad saved back numeric reset" }]);
  });

  it("reads colon sub-parameters as one parameter: a curly underline is an underline, 4:0 turns it off alone, and 38:2 skips its colour space", () => {
    const lines = sgrPage("\u001B[1;4:3mA\u001B[4:0mB\u001B[38:2::10:20:30mC\u001B[38:5:208mD\u001B[38:2:1:2:3mE", 60);
    expect(lines[0]?.spans).toEqual([
      { text: "A", bold: true, underline: true },
      { text: "B", bold: true },
      { text: "C", bold: true, color: "#0a141e" },
      { text: "D", bold: true, color: "ansi256(208)" },
      { text: "E", bold: true, color: "#010203" },
    ]);
  });

  it("drops an OSC left unterminated to the end of the answer, and one another escape cuts short, leaving none of its text", () => {
    expect(sgrPage("\u001B[32mgreen\u001B[0m see \u001B]8;;https://x", 40).map((line) => line.spans)).toEqual([[{ text: "green", color: "ansi256(2)" }, { text: " see " }]]);
    // A control string runs across lines to its terminator (ECMA-48): a newline inside it is part of it, not a new line.
    expect(texts(sgrPage("before\u001B]8;;https://x\nstill the link\u001B\\after\nnext", 40))).toEqual(["beforeafter", "next"]);
    // An escape inside an OSC ends it and is read as itself.
    expect(sgrPage("\u001B]8;;https://x\u001B[1mbold", 40)[0]?.spans).toEqual([{ text: "bold", bold: true }]);
  });

  it("drops a CSI left unterminated to the end of the answer, and one a control cuts short up to the control, leaving none of its parameters", () => {
    // A killed or capped tool can stop inside a sequence; its parameters are never text.
    expect(sgrPage("y\u001B[31mz\u001B[38;5;", 40).map((line) => line.spans)).toEqual([[{ text: "y" }, { text: "z", color: "ansi256(1)" }]]);
    expect(sgrPage("\u009B1;2", 40).map((line) => line.spans)).toEqual([[]]);
    // A control inside a CSI ends it there and stands: a newline is still the next line, an escape is read as itself.
    expect(texts(sgrPage("a\u001B[38;5\nb\u001B[1\u001B[1mc", 40))).toEqual(["a", "bc"]);
    expect(sgrPage("\u001B[4\u001B[1mc", 40)[0]?.spans).toEqual([{ text: "c", bold: true }]);
  });

  it("drops DCS, SOS, PM and APC strings whole, ESC and C1 forms alike, to their ST or the end", () => {
    expect(texts(sgrPage("a\u001BP1$r0m\u001B\\b\u001B_apc\u009Cc\u0090dcs\u001B\\d\u009Epm\u009Ce\u001BXsos to the end", 40))).toEqual(["abcde"]);
  });

  it("passes over the underline colour (58 and 59) with its arguments, never reading them as codes", () => {
    const lines = sgrPage("\u001B[58;5;3;1mA\u001B[0;58;2;1;2;33;4mB\u001B[0;58:2::1:2:3;59mC", 60);
    expect(lines[0]?.spans).toEqual([{ text: "A", bold: true }, { text: "B", underline: true }, { text: "C" }]);
  });
});

describe("a diff coloured as git colours one, for a tool that reads colour", () => {
  it("wraps the headers in bold, the hunk lines in cyan, the additions in green and the removals in red, each reset", () => {
    expect(colouredDiff("diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n same")).toBe(
      "\u001B[1mdiff --git a/x b/x\u001B[m\n\u001B[36m@@ -1 +1 @@\u001B[m\n\u001B[31m-old\u001B[m\n\u001B[32m+new\u001B[m\n same",
    );
  });
});
