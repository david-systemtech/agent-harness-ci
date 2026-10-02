import { describe, expect, it } from "vitest";
import { ACTIONS } from "@agent-harness/contracts";
import { parseCommand } from "./parse.js";

/** The slash commands this build answers, and what goes to the agent (docs/specs/tui.md, "The composer"). */

describe("parseCommand", () => {
  it("reads the trust decision and rejects extra words", () => {
    expect(parseCommand("/trust")).toEqual({ kind: "trust", decision: "trusted" });
    expect(parseCommand("/trust decline")).toEqual({ kind: "trust", decision: "declined" });
    for (const text of ["/trust accept", "/trust decline now"]) expect(parseCommand(text)).toEqual({ kind: "usage", line: "Usage: /trust or /trust decline" });
  });
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

  it("reads /rewind and /fork with the count of prompts back (#232)", () => {
    expect(parseCommand("/rewind")).toEqual({ kind: "rewind", back: 1 });
    expect(parseCommand("/rewind 3")).toEqual({ kind: "rewind", back: 3 });
    expect(parseCommand("/rewind undo")).toEqual({ kind: "rewind-undo" });
    expect(parseCommand("/rewind 0")).toEqual({ kind: "usage", line: "Usage: /rewind [n | undo]: n prompts back, one by default; undo takes the rewind back." });
    expect(parseCommand("/rewind undo now").kind).toBe("usage");
    expect(parseCommand("/fork")).toEqual({ kind: "fork", back: null });
    expect(parseCommand("/fork 2")).toEqual({ kind: "fork", back: 2 });
    expect(parseCommand("/fork end")).toEqual({ kind: "usage", line: "Usage: /fork [n]: bare, the whole session; n, before the prompt n back." });
  });

  it("reads /environment's rename, icon and colour, a name keeping the spaces inside it, bare as null (#327)", () => {
    expect(parseCommand("/environment")).toEqual({ kind: "environment" });
    expect(parseCommand("/environment rename  Tower   box ")).toEqual({ kind: "environment-look", field: "name", value: "Tower   box" });
    expect(parseCommand("/environment Rename")).toEqual({ kind: "environment-look", field: "name", value: null });
    expect(parseCommand("/environment icon server")).toEqual({ kind: "environment-look", field: "icon", value: "server" });
    expect(parseCommand("/environment colour")).toEqual({ kind: "environment-look", field: "colour", value: null });
    expect(parseCommand("/environment colour teal green").kind).toBe("usage");
    expect(parseCommand("/environment constructor").kind).toBe("usage");
    expect(parseCommand("/environments icon nas")).toEqual({ kind: "environment-look", field: "icon", value: "nas" });
  });

  it("reads the cards' commands, which take nothing after them", () => {
    expect(parseCommand("/browser")).toEqual({ kind: "browser" });
    expect(parseCommand("/browser pair")).toEqual({ kind: "usage", line: "Usage: /browser" });
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

  it("reads the accounts, models, permissions, settings and Set up commands, /profile as the hidden alias of /account (#147)", () => {
    expect(parseCommand("/profile")).toEqual({ kind: "picker", command: { name: "account", argument: "" } });
    expect(parseCommand("/model")).toEqual({ kind: "picker", command: { name: "model", argument: "" } });
    for (const name of ["account", "model", "mode", "containment", "usage", "review"]) {
      expect(parseCommand(`/${name}`)).toEqual({ kind: "picker", command: { name, argument: "" } });
      expect(parseCommand(`/${name} extra`)).toEqual({ kind: "usage", line: `Usage: /${name}` });
    }
    expect(parseCommand("/handoff")).toEqual({ kind: "picker", command: { name: "handoff", argument: "" } });
    expect(parseCommand("/handoff My Laptop")).toEqual({ kind: "picker", command: { name: "handoff", argument: "My Laptop" } });
    expect(parseCommand("/setup desk")).toEqual({ kind: "picker", command: { name: "setup", argument: "desk" } });
    expect(parseCommand("/settings")).toEqual({ kind: "picker", command: { name: "settings", argument: "" } });
    expect(parseCommand("/settings access.permissions")).toEqual({ kind: "picker", command: { name: "settings", argument: "access.permissions" } });
  });

  it("answers every command the shared list wires, so none says it is not in this build yet", () => {
    // With the terminal pane (#148) and fork and rewind (#232) both in, the list has no wired command this build leaves out.
    const wired = ACTIONS.filter((a) => a.id.startsWith("command.") && a.status === "wired" && a.aliasOf === undefined).map((a) => a.id.slice("command.".length));
    expect(wired).toContain("terminal");
    expect(wired).toContain("fork");
    for (const name of wired) expect(parseCommand(`/${name}`), name).not.toMatchObject({ kind: "not-here" });
  });

  it("answers file undo and workspace checks", () => {
    expect(parseCommand("/undo")).toEqual({ kind: "file-undo" });
    expect(parseCommand("/undo now")).toMatchObject({ kind: "usage", line: expect.stringContaining("/undo") });
    expect(parseCommand("/check")).toEqual({ kind: "check", action: "get" });
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

  it("reads /documents bare (#427)", () => {
    expect(parseCommand("/documents")).toEqual({ kind: "documents" });
    expect(parseCommand("/documents notes.md")).toEqual({ kind: "usage", line: "Usage: /documents" });
  });
});

describe("/routines (#533)", () => {
  it("reads the list, a new routine, an import from a path, the webhook endpoints and a pre-check's test", () => {
    expect(parseCommand("/routines")).toEqual({ kind: "routines", command: { name: "list" } });
    expect(parseCommand("/routines new")).toEqual({ kind: "routines", command: { name: "new" } });
    expect(parseCommand("/routines import ~/routines/nightly watch.yaml")).toEqual({ kind: "routines", command: { name: "import", path: "~/routines/nightly watch.yaml" } });
    expect(parseCommand("/routines endpoints")).toEqual({ kind: "routines", command: { name: "endpoints" } });
    expect(parseCommand("/routines test-precheck Upstream  watch")).toEqual({ kind: "routines", command: { name: "test-precheck", routine: "Upstream  watch" } });
  });

  it("says its usage for a form it does not have, or one missing what it needs", () => {
    const usage = { kind: "usage", line: "Usage: /routines [new | import <path> | endpoints | test-precheck <name>]" };
    expect(parseCommand("/routines import")).toEqual(usage);
    expect(parseCommand("/routines test-precheck")).toEqual(usage);
    expect(parseCommand("/routines new nightly")).toEqual(usage);
    expect(parseCommand("/routines endpoints hermes")).toEqual(usage);
    expect(parseCommand("/routines delete nightly")).toEqual(usage);
  });
});
