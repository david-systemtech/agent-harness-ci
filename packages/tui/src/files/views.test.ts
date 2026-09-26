import { describe, expect, it } from "vitest";

import type { Runtime } from "@agent-harness/client-runtime";

import { readFile } from "./views.js";

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
