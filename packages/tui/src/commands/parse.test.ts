import { describe, expect, it } from "vitest";
import { parseCommand } from "./parse.js";

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

  it("reads /snip's forms, a template's lines kept", () => {
    expect(parseCommand("/snip")).toEqual({ kind: "snip-list" });
    expect(parseCommand("/snip fix pnpm -w")).toEqual({ kind: "snip", name: "fix", words: ["pnpm", "-w"] });
    expect(parseCommand("/snip save fix Run $1\nthen $0")).toEqual({ kind: "snip-save", name: "fix", body: "Run $1\nthen $0" });
    expect(parseCommand("/snip save fix").kind).toBe("usage");
    expect(parseCommand("/snip rm fix")).toEqual({ kind: "snip-remove", name: "fix" });
    expect(parseCommand("/snip --examples")).toEqual({ kind: "snip-examples" });
  });

  it("reads the accounts, models, permissions, settings and Set up commands, /profile as the hidden alias of /account (#147)", () => {
    expect(parseCommand("/profile")).toEqual({ kind: "picker", command: { name: "account", argument: "" } });
    expect(parseCommand("/model")).toEqual({ kind: "picker", command: { name: "model", argument: "" } });
    for (const name of ["account", "model", "mode", "containment", "usage", "review", "settings"]) {
      expect(parseCommand(`/${name}`)).toEqual({ kind: "picker", command: { name, argument: "" } });
      expect(parseCommand(`/${name} extra`)).toEqual({ kind: "usage", line: `Usage: /${name}` });
    }
    expect(parseCommand("/handoff")).toEqual({ kind: "picker", command: { name: "handoff", argument: "" } });
    expect(parseCommand("/handoff My Laptop")).toEqual({ kind: "picker", command: { name: "handoff", argument: "My Laptop" } });
    expect(parseCommand("/setup desk")).toEqual({ kind: "picker", command: { name: "setup", argument: "desk" } });
  });

  it("says a command of the list this build does not answer yet is not here", () => {
    expect(parseCommand("/terminal")).toEqual({ kind: "not-here", name: "terminal", line: "/terminal is not in this build of the terminal UI yet." });
  });

  it("gives an absent command's reason", () => {
    expect(parseCommand("/undo")).toMatchObject({ kind: "not-here", line: expect.stringContaining("Deferred to phase D") });
  });

  it("leaves a command it does not know to the agent, as typed", () => {
    expect(parseCommand("/compact keep the tests")).toEqual({ kind: "text", text: "/compact keep the tests" });
    expect(parseCommand("hello")).toEqual({ kind: "text", text: "hello" });
  });
});
