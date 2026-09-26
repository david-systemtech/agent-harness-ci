import { describe, expect, it } from "vitest";
import { diffPage, plainPage, sgrPage } from "./pages.js";

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
});
