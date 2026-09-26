import { describe, expect, it } from "vitest";
import { parseCommand, shellLine } from "./parse.js";

/** The slash commands this build answers, and what goes to the agent (docs/specs/tui.md, "The composer"). */

describe("parseCommand", () => {
  it("reads the carried commands", () => {
    expect(parseCommand("/resume")).toEqual({ kind: "resume" });
    expect(parseCommand("/new")).toEqual({ kind: "new" });
    expect(parseCommand("/tasks")).toEqual({ kind: "tasks" });
    expect(parseCommand("/quit")).toEqual({ kind: "quit" });
    expect(parseCommand("/timeline")).toEqual({ kind: "timeline" });
    expect(parseCommand("/attach ~/shots/one two.png")).toEqual({ kind: "attach", path: "~/shots/one two.png" });
    expect(parseCommand("/export")).toEqual({ kind: "export", file: null });
    expect(parseCommand("/export talk.md")).toEqual({ kind: "export", file: "talk.md" });
    expect(parseCommand("/copy")).toEqual({ kind: "copy", block: null });
    expect(parseCommand("/copy 2")).toEqual({ kind: "copy", block: 2 });
    expect(parseCommand("/copy two").kind).toBe("usage");
  });

  it("reads the cards' commands, which take nothing after them", () => {
    expect(parseCommand("/asks")).toEqual({ kind: "asks" });
    expect(parseCommand("/notices")).toEqual({ kind: "notices" });
    expect(parseCommand("/asks all")).toEqual({ kind: "usage", line: "Usage: /asks" });
  });

  it("reads the rail's forms, what follows the name taken whole, and leaves every other command to its own case", () => {
    expect(parseCommand("/title Spare  parts")).toEqual({ kind: "rail", command: { name: "title", text: "Spare  parts" } });
    expect(parseCommand("/archive")).toEqual({ kind: "rail", command: { name: "archive", text: "" } });
    expect(parseCommand("/snooze tomorrow 9am")).toEqual({ kind: "rail", command: { name: "snooze", text: "tomorrow 9am" } });
    for (const name of ["pair", "environment", "help", "reload", "resume", "new", "attach", "snip", "tasks", "copy", "export", "timeline", "quit", "asks", "notices"]) {
      expect(parseCommand(`/${name}`).kind, name).not.toBe("rail");
    }
  });

  it("reads /snip's forms, a template's lines kept", () => {
    expect(parseCommand("/snip")).toEqual({ kind: "snip-list" });
    expect(parseCommand("/snip fix pnpm -w")).toEqual({ kind: "snip", name: "fix", words: ["pnpm", "-w"] });
    expect(parseCommand("/snip save fix Run $1\nthen $0")).toEqual({ kind: "snip-save", name: "fix", body: "Run $1\nthen $0" });
    expect(parseCommand("/snip save fix").kind).toBe("usage");
    expect(parseCommand("/snip rm fix")).toEqual({ kind: "snip-remove", name: "fix" });
    expect(parseCommand("/snip --examples")).toEqual({ kind: "snip-examples" });
  });

  it("answers /profile as the hidden alias of /account, a command of the list this build does not answer yet", () => {
    expect(parseCommand("/profile")).toEqual({ kind: "not-here", name: "account", line: "/account is not in this build of the terminal UI yet." });
    expect(parseCommand("/model")).toMatchObject({ kind: "not-here", name: "model" });
  });

  it("gives an absent command's reason", () => {
    expect(parseCommand("/undo")).toMatchObject({ kind: "not-here", line: expect.stringContaining("Deferred to phase D") });
  });

  it("leaves a command it does not know to the agent, as typed", () => {
    expect(parseCommand("/compact keep the tests")).toEqual({ kind: "text", text: "/compact keep the tests" });
    expect(parseCommand("hello")).toEqual({ kind: "text", text: "hello" });
  });
});

describe("the terminal's commands (#148)", () => {
  it("reads /terminal, /files with or without a path, and /diff", () => {
    expect(parseCommand("/terminal")).toEqual({ kind: "terminal" });
    expect(parseCommand("/terminal now").kind).toBe("usage");
    expect(parseCommand("/files")).toEqual({ kind: "files", path: null });
    expect(parseCommand("/files src/my file.ts")).toEqual({ kind: "files", path: "src/my file.ts" });
    expect(parseCommand("/diff")).toEqual({ kind: "diff" });
    expect(parseCommand("/diff more").kind).toBe("usage");
  });
});

describe("a shell line", () => {
  it("is ! and a command to run, !! and a command whose output goes to the agent, the command as typed", () => {
    expect(shellLine("!git status")).toEqual({ send: false, command: "git status" });
    expect(shellLine("!! ls -la | head ")).toEqual({ send: true, command: "ls -la | head" });
    expect(shellLine("!")).toEqual({ send: false, command: "" });
    expect(shellLine("!!")).toEqual({ send: true, command: "" });
    expect(shellLine("hello !")).toBeNull();
  });
});
