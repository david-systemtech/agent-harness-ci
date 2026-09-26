import { describe, expect, it } from "vitest";

import type { Runtime } from "@agent-harness/client-runtime";

import { readFile, rowDiff } from "./views.js";

const runtimeAnswering = (text: string): Runtime =>
  ({ requests: { call: async () => ({ ok: true, result: { path: "notes.md", size: text.length, binary: false, truncated: false, text } }) } }) as unknown as Runtime;

describe("a file read into the pager", () => {
  it("ends at its last line, not at the blank row a file's trailing newline would make", async () => {
    const paged = await readFile(runtimeAnswering("one\ntwo\n"), { environmentId: "desk", sessionId: "s" }, "notes.md", 80);
    expect(paged.ok && paged.page.lines.map((l) => l.spans.map((s) => s.text).join(""))).toEqual(["one", "two"]);
  });

  it("keeps a blank last line the file really has", async () => {
    const paged = await readFile(runtimeAnswering("one\n\n"), { environmentId: "desk", sessionId: "s" }, "notes.md", 80);
    expect(paged.ok && paged.page.lines.map((l) => l.spans.map((s) => s.text).join(""))).toEqual(["one", ""]);
  });
});

describe("d on a row whose files the session diff does not hold", () => {
  const answering = (truncated: boolean): Runtime => ({ requests: { call: async () => ({ ok: true, result: { files: [], truncated } }) } }) as unknown as Runtime;

  it("says the diff holds nothing of the row when the diff is whole", async () => {
    const paged = await rowDiff(answering(false), { environmentId: "desk", sessionId: "s" }, ["call-1"], 80, null);
    expect(paged).toEqual({ ok: false, line: "The session's diff holds nothing that row changed." });
  });

  it("says the row's files may lie past the cut when the diff was cut, rather than that the row changed nothing", async () => {
    const paged = await rowDiff(answering(true), { environmentId: "desk", sessionId: "s" }, ["call-1"], 80, null);
    expect(paged).toEqual({ ok: false, line: "The session's diff was cut at 8 MiB before anything that row changed: not shown." });
  });
});
