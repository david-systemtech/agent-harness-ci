import { describe, expect, it } from "vitest";
import { ceilingAboveOwn, offeredPresets } from "./presets.js";

/**
 * The pairing presets as a client offers them on an environment (the Set up
 * spec, "Pairing codes"; #180, #577): each dim, with its reason, where its
 * ceiling is above the one this client's own session there holds, since a
 * code grants at most its minter's; my own client preset unless it is dim.
 */

const LINE = "Above this client's own ceiling on laptop, acceptEdits: a pairing code grants at most its minter's.";

describe("the presets offered", () => {
  it("are all offered, my own client preset, where this client holds the top ceiling", () => {
    const offered = offeredPresets("bypassPermissions", "laptop");
    expect(offered.presets.map(({ preset, dim }) => [preset.id, dim])).toEqual([
      ["own-client", null],
      ["program", null],
      ["custom", null],
    ]);
    expect(offered.preset.id).toBe("own-client");
  });

  it("dim my own client where this client holds acceptEdits, and preset a program's instead", () => {
    const offered = offeredPresets("acceptEdits", "laptop");
    expect(offered.presets.map(({ preset, dim }) => [preset.id, dim])).toEqual([
      ["own-client", LINE],
      ["program", null],
      ["custom", null],
    ]);
    expect(offered.preset.id).toBe("program");
  });

  it("dim a program's too where this client holds plan, custom being offered always", () => {
    const offered = offeredPresets("plan", "laptop");
    expect(offered.presets.filter(({ dim }) => dim !== null).map(({ preset }) => preset.id)).toEqual(["own-client", "program"]);
    expect(offered.preset.id).toBe("custom");
  });

  it("say what each grants: my own client every scope up to bypassPermissions, a program its three up to the ceiling picked, custom what is ticked and picked", () => {
    expect(offeredPresets("bypassPermissions", "laptop").presets.map(({ words }) => words)).toEqual([
      "Grants every scope, up to bypassPermissions.",
      "Grants read, sessions:write and runs:drive, up to the ceiling picked, preset acceptEdits.",
      "Grants the scopes ticked, up to the ceiling picked.",
    ]);
  });

  it("dim none while this client's own ceiling there is not known", () => {
    expect(offeredPresets(null, "laptop").presets.every(({ dim }) => dim === null)).toBe(true);
  });

  it("say why a ceiling picked is above this client's own, and nothing for one at or below it", () => {
    expect(ceilingAboveOwn("auto", "acceptEdits", "laptop")).toBe(
      "Above this client's own ceiling on laptop, acceptEdits: a pairing code grants at most its minter's.",
    );
    expect(ceilingAboveOwn("acceptEdits", "acceptEdits", "laptop")).toBeNull();
    expect(ceilingAboveOwn("bypassPermissions", null, "laptop")).toBeNull();
  });
});
