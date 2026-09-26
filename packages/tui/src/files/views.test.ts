import { describe, expect, it } from "vitest";

import type { Runtime } from "@agent-harness/client-runtime";

import { readFile, rowDiff, sessionDiff } from "./views.js";

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

describe("/diff when a cut left nothing to show", () => {
  const answering = (session: { files: readonly unknown[]; truncated: boolean }, tree: { diff: string; truncated: boolean }): Runtime =>
    ({
      requests: {
        call: async (_environment: string, method: string) => ({ ok: true, result: method === "diffs.session" ? session : { ...tree, repository: true } }),
      },
    }) as unknown as Runtime;
  const rows = async (runtime: Runtime): Promise<string[]> => {
    const paged = await sessionDiff(runtime, { environmentId: "desk", sessionId: "s" }, 80, null);
    return paged.ok ? paged.page.lines.map((l) => l.spans.map((s) => s.text).join("")) : [];
  };

  it("marks both cuts, and that nothing was left, rather than saying nothing changed", async () => {
    expect(await rows(answering({ files: [], truncated: true }, { diff: "", truncated: true }))).toEqual([
      "What this session changed",
      "The cut left nothing to show.",
      "… cut at 8 MiB: the rest is not shown.",
      "",
      "The working tree against HEAD",
      "The cut left nothing to show.",
      "… cut at 8 MiB: the rest is not shown.",
    ]);
  });

  it("still says nothing changed when neither diff was cut", async () => {
    expect(await rows(answering({ files: [], truncated: false }, { diff: "", truncated: false }))).toEqual([
      "What this session changed",
      "Nothing yet.",
      "",
      "The working tree against HEAD",
      "Nothing changed.",
    ]);
  });
});
