import type { CommandsListEntry } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { matchCommands, slashMenuRows } from "./commands.js";

/** The slash menu's order, which both renderers draw (docs/specs/tui.md, "The composer"). */

const rows = (...names: string[]) => names.map((name) => ({ name }));
const names = (word: string, ...commands: string[]) => matchCommands(word, rows(...commands)).map((row) => row.name);

describe("the slash menu's order", () => {
  it("puts the command named exactly first, then those the word begins, then those holding its letters in order", () => {
    expect(names("mode", "model", "mode")).toEqual(["mode", "model"]);
    expect(names("mo", "model", "mode")).toEqual(["model", "mode"]);
    expect(names("rs", "resume", "attach", "rewind")).toEqual(["resume"]);
    expect(names("at", "compact", "attach", "tasks")).toEqual(["attach", "compact"]);
  });

  it("reads the word ignoring its case, and keeps every row it matches as it was given", () => {
    expect(names("Mode", "model", "mode")).toEqual(["mode", "model"]);
    const given = [{ name: "compact", description: "Compact the conversation" }];
    expect(matchCommands("comp", given)).toEqual(given);
    expect(names("zz", "compact")).toEqual([]);
  });
});

describe("the slash menu's rows (#503)", () => {
  const own = [
    { name: "model", usage: "/model [name]", description: "Choose the model" },
    { name: "new", usage: "/new", description: "Start a session" },
  ];
  const answers = (name: string) => own.some((row) => row.name === name);
  const skill = (name: string, invocation: "model+slash" | "slash-only", argumentHint: string | null = null): CommandsListEntry => ({
    kind: "skill",
    name,
    description: `The ${name} skill.`,
    invocation,
    origin: null,
    alwaysOn: false,
    argumentHint,
  });
  const command = (name: string, builtin: boolean): CommandsListEntry => ({ kind: "command", name, description: `The provider's ${name}.`, builtin });

  it("lists the client's own commands, then the session's skills with slash-only ones marked, then the provider's own commands", () => {
    const rows = slashMenuRows(own, [skill("tdd", "slash-only", "<feature>"), skill("review", "model+slash"), command("compact", true), command("deploy", false)], answers);
    expect(rows).toEqual([
      { name: "model", usage: "/model [name]", description: "Choose the model", source: "client", slashOnly: false },
      { name: "new", usage: "/new", description: "Start a session", source: "client", slashOnly: false },
      { name: "tdd", usage: "/tdd <feature>", description: "The tdd skill.", source: "skill", slashOnly: true },
      { name: "review", usage: "/review", description: "The review skill.", source: "skill", slashOnly: false },
      { name: "compact", usage: "/compact", description: "The provider's compact.", source: "provider", slashOnly: false },
      { name: "deploy", usage: "/deploy", description: "The provider's deploy.", source: "provider", slashOnly: false },
    ]);
  });

  it("leaves out a provider command a client command shadows, and one a skill's or a built-in's /name reaches instead; a skill a client command or a built-in takes the name of is /skill:<name>", () => {
    const rows = slashMenuRows(
      own,
      [skill("new", "model+slash"), skill("compact", "slash-only"), skill("deploy", "model+slash"), command("model", true), command("compact", true), command("deploy", false), command("compact", false)],
      answers,
    );
    expect(rows.map((row) => [row.source, row.usage])).toEqual([
      ["client", "/model [name]"],
      ["client", "/new"],
      ["skill", "/skill:new"],
      ["skill", "/skill:compact"],
      ["skill", "/deploy"],
      ["provider", "/compact"],
    ]);
    // What a row types is its name after the slash, so every row types something no other row does.
    expect(new Set(rows.map((row) => row.name)).size).toBe(rows.length);
  });
});
