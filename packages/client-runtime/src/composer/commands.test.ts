import { describe, expect, it } from "vitest";
import { matchCommands } from "./commands.js";

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
