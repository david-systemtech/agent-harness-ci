import { describe, expect, it } from "vitest";
import type { InProcessToolServer } from "../../adapter/contract.js";
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
      input: { file_path: "/etc/hosts" },
    });
    expect(claudeGatedCall("Bash", { command: "echo a\necho b" }, "toolu_2").summary).toBe("Bash echo a");
    expect(claudeGatedCall("Bash", { command: "ls" }, "toolu_3", { title: "List the files" }).summary).toBe("List the files");
  });

  it("reads WebSearch's allowed domains for the denylist's hosts (#132)", () => {
    expect(claudeGatedCall("WebSearch", { query: "status", allowed_domains: ["api.internal.example", 3] }, "toolu_6").access).toEqual({
      kind: "search",
      query: "status",
      domains: ["api.internal.example"],
    });
    expect(claudeGatedCall("WebSearch", { query: "status" }, "toolu_7").access).toEqual({ kind: "search", query: "status" });
  });

  it("reads Glob's pattern as a path it can expand to, in its directory when it names one (the pinned SDK's GlobInput)", () => {
    expect(claudeToolAccess("Glob", { pattern: "~/.ssh/*" })).toEqual({ kind: "read", paths: ["~/.ssh/*"] });
    expect(claudeToolAccess("Glob", { pattern: "**/*.pem", path: "/etc/ssl" })).toEqual({ kind: "read", paths: ["/etc/ssl", "/etc/ssl/**/*.pem"] });
    expect(claudeToolAccess("Glob", { pattern: "/home/david/.aws/*", path: "/work/repo" })).toEqual({ kind: "read", paths: ["/work/repo", "/home/david/.aws/*"] });
    expect(claudeToolAccess("Glob", { pattern: "src/**/*.ts" })).toEqual({ kind: "read", paths: ["src/**/*.ts"] });
    expect(claudeToolAccess("Grep", { pattern: "BEGIN RSA", path: "~/.ssh", glob: "*.pem" })).toEqual({ kind: "read", paths: ["~/.ssh"] });
  });

  it("reads Monitor's command as a shell line, and one with none as anything else", () => {
    expect(claudeToolAccess("Monitor", { description: "Tail", timeout_ms: 1000, command: "tail -f ~/.ssh/known_hosts" })).toEqual({ kind: "shell", command: "tail -f ~/.ssh/known_hosts" });
    expect(claudeToolAccess("Monitor", { description: "Socket", timeout_ms: 1000, ws: { url: "wss://example.com/" } })).toEqual({ kind: "other" });
  });

  it("reads the sandbox's ask for a host (SandboxNetworkAccess) as a fetch of that host", () => {
    expect(claudeToolAccess("SandboxNetworkAccess", { host: "registry.npmjs.org" })).toEqual({ kind: "fetch", urls: ["registry.npmjs.org"] });
    expect(claudeToolAccess("SandboxNetworkAccess", {})).toEqual({ kind: "fetch", urls: [] });
  });

  it("cuts a long title to 200 characters, as it cuts a long command", () => {
    const title = claudeGatedCall("Bash", { command: "ls" }, "toolu_4", { title: `${"t".repeat(300)}\nsecond line` }).summary;
    expect(title).toBe(`${"t".repeat(199)}…`);
    const command = claudeGatedCall("Bash", { command: "c".repeat(300) }, "toolu_5").summary;
    expect(command).toBe(`Bash ${"c".repeat(194)}…`);
    expect(command).toHaveLength(200);
  });

  it("reads an in-process tool's call as its tool declares it, naming the address in the summary, and one that declares nothing as other (#540)", () => {
    const browser: InProcessToolServer = {
      name: "browser",
      external: false,
      tools: [
        { name: "open", description: "", inputSchema: {}, access: (input) => ({ kind: "browse", urls: [String(input["address"])] }), call: async () => ({ text: "", isError: false }) },
        { name: "read", description: "", inputSchema: {}, access: (input) => ({ kind: "fetch", urls: [String(input["url"])] }), call: async () => ({ text: "", isError: false }) },
        { name: "close", description: "", inputSchema: {}, call: async () => ({ text: "", isError: false }) },
      ],
    };
    const servers = [{ name: "memory", config: {} }, browser];
    expect(claudeGatedCall("mcp__browser__open", { address: "https://www.paypal.com/" }, "toolu_8", { servers })).toEqual({
      toolCallId: "toolu_8",
      tool: "mcp__browser__open",
      summary: "mcp__browser__open https://www.paypal.com/",
      access: { kind: "browse", urls: ["https://www.paypal.com/"] },
      input: { address: "https://www.paypal.com/" },
    });
    expect(claudeGatedCall("mcp__browser__read", { url: "http://169.254.169.254/latest" }, "toolu_9", { servers })).toMatchObject({
      summary: "mcp__browser__read http://169.254.169.254/latest",
      access: { kind: "fetch", urls: ["http://169.254.169.254/latest"] },
    });
    expect(claudeGatedCall("mcp__browser__close", { address: "https://www.paypal.com/" }, "toolu_10", { servers }).access).toEqual({ kind: "other" });
    // A tool no in-process server has, and the same name with no servers handed over, are read as before.
    expect(claudeGatedCall("mcp__memory__recall", { query: "x" }, "toolu_11", { servers }).access).toEqual({ kind: "other" });
    expect(claudeGatedCall("mcp__browser__open", { address: "https://www.paypal.com/" }, "toolu_12").access).toEqual({ kind: "other" });
  });
});
