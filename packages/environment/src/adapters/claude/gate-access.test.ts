import { describe, expect, it } from "vitest";
import { claudeGatedCall, claudeToolAccess } from "./gate-access.js";

/** Claude's tool inputs as the tool gate reads them. */
describe("Claude's tools as the gate reads them", () => {
  it("maps the file tools' paths, Bash's command, WebFetch's URL and WebSearch's query, and anything else to other", () => {
    expect(claudeToolAccess("Write", { file_path: "/etc/hosts", content: "x" })).toEqual({ kind: "write", paths: ["/etc/hosts"] });
    expect(claudeToolAccess("Edit", { file_path: "a.ts", old_string: "a", new_string: "b" })).toEqual({ kind: "write", paths: ["a.ts"] });
    expect(claudeToolAccess("MultiEdit", { file_path: "b.ts", edits: [] })).toEqual({ kind: "write", paths: ["b.ts"] });
    expect(claudeToolAccess("NotebookEdit", { notebook_path: "n.ipynb", new_source: "" })).toEqual({ kind: "write", paths: ["n.ipynb"] });
    expect(claudeToolAccess("Read", { file_path: "~/.ssh/id_rsa" })).toEqual({ kind: "read", paths: ["~/.ssh/id_rsa"] });
    expect(claudeToolAccess("Bash", { command: "curl https://example.com/" })).toEqual({ kind: "shell", command: "curl https://example.com/" });
    expect(claudeToolAccess("WebFetch", { url: "https://example.com/", prompt: "?" })).toEqual({ kind: "fetch", urls: ["https://example.com/"] });
    expect(claudeToolAccess("WebSearch", { query: "bubblewrap" })).toEqual({ kind: "search", query: "bubblewrap" });
    expect(claudeToolAccess("mcp__memory__recall", { query: "x" })).toEqual({ kind: "other" });
  });

  it("reads a write tool with no path as a write naming none, which a workspace level denies", () => {
    expect(claudeToolAccess("Write", { content: "x" })).toEqual({ kind: "write", paths: [] });
    expect(claudeToolAccess("Edit", { file_path: 42 })).toEqual({ kind: "write", paths: [] });
  });

  it("summarises a call by its title, else the tool and what it names, on one line", () => {
    expect(claudeGatedCall("Write", { file_path: "/etc/hosts" }, "toolu_1")).toEqual({
      toolCallId: "toolu_1",
      tool: "Write",
      summary: "Write /etc/hosts",
      access: { kind: "write", paths: ["/etc/hosts"] },
    });
    expect(claudeGatedCall("Bash", { command: "echo a\necho b" }, "toolu_2").summary).toBe("Bash echo a");
    expect(claudeGatedCall("Bash", { command: "ls" }, "toolu_3", "List the files").summary).toBe("List the files");
  });
});
