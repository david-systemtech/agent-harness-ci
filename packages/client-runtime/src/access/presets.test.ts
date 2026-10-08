import { describe, expect, it } from "vitest";
import { SCOPES } from "@agent-harness/contracts";
import { CEILING_CHOICES, CANNOT_GIVE_MORE, SCOPE_TICKS, ceilingAboveOwn, offeredPresets } from "./presets.js";

/**
 * The pairing presets as Add a device offers them on an environment
 * (setup-copy.md §5.5; #180, #577, #1847): who the code is for, in words,
 * each dim, with why, where its ceiling is above the one this client's own
 * session there holds or it asks a scope this client lacks, since a code
 * grants at most its minter's; Me unless it is dim.
 */

const EVERY = [...SCOPES];

describe("the presets offered", () => {
  it("ask who the code is for in setup-copy.md §5.5's words, Me first, with no scope or mode id in them", () => {
    const offered = offeredPresets("bypassPermissions", EVERY);
    expect(offered.presets.map(({ preset, label, note }) => [preset.id, label, note])).toEqual([
      ["own-client", "Me", "Your own phone or computer. It can do everything you can do here."],
      ["phone", "A phone with limited access", "It can chat with agents and answer their questions. It cannot open terminals or change settings. Agents on it edit files but ask before anything else."],
      ["program", "A program or bot", "A tool such as a bot. It can start and follow sessions but not change settings."],
      ["custom", "Custom", undefined],
    ]);
    expect(offered.preset.id).toBe("own-client");
  });

  it("are all offered, Me preset, where this client holds every scope and the top ceiling", () => {
    expect(offeredPresets("bypassPermissions", EVERY).presets.every(({ dim }) => dim === null)).toBe(true);
  });

  it("dim Me where this client holds acceptEdits, with why in words, and preset the phone instead", () => {
    const offered = offeredPresets("acceptEdits", EVERY);
    expect(offered.presets.map(({ preset, dim }) => [preset.id, dim])).toEqual([
      ["own-client", "This app itself has limited access, so it cannot give more."],
      ["phone", null],
      ["program", null],
      ["custom", null],
    ]);
    expect(offered.preset.id).toBe("phone");
  });

  it("dim the phone and the program too where this client holds plan, Custom being offered always", () => {
    const offered = offeredPresets("plan", EVERY);
    expect(offered.presets.filter(({ dim }) => dim !== null).map(({ preset }) => preset.id)).toEqual(["own-client", "phone", "program"]);
    expect(offered.preset.id).toBe("custom");
  });

  it("dim a preset that asks a scope this client was not given, with the same words", () => {
    const offered = offeredPresets("bypassPermissions", ["read", "sessions:write", "runs:drive"]);
    expect(offered.presets.map(({ preset, dim }) => [preset.id, dim])).toEqual([
      ["own-client", CANNOT_GIVE_MORE],
      ["phone", null],
      ["program", null],
      ["custom", null],
    ]);
  });

  it("dim none while this client's own ceiling there is not known", () => {
    expect(offeredPresets(null, EVERY).presets.every(({ dim }) => dim === null)).toBe(true);
  });

  it("say why a ceiling picked is above this client's own, and nothing for one at or below it", () => {
    expect(ceilingAboveOwn("auto", "acceptEdits")).toBe("This app itself has limited access, so it cannot give more.");
    expect(ceilingAboveOwn("acceptEdits", "acceptEdits")).toBeNull();
    expect(ceilingAboveOwn("bypassPermissions", null)).toBeNull();
  });
});

describe("the words a code's access is chosen in", () => {
  it("offer the four plain mode choices of setup-copy.md §5.12, one per mode, in the modes' order", () => {
    expect(CEILING_CHOICES.map(({ mode, label }) => [mode, label])).toEqual([
      ["plan", "Ask before any change"],
      ["acceptEdits", "Edit files, ask for the rest"],
      ["auto", "Let Claude decide"],
      ["bypassPermissions", "Never ask"],
    ]);
    expect(CEILING_CHOICES.map(({ note }) => note)).toEqual([
      "Agents can read and plan. They ask before changing anything.",
      "Agents can edit files in your project. They ask before running commands.",
      "Claude reviews each action and asks you only when it is unsure.",
      "Agents act without asking. Use it only for trusted work in a sandbox.",
    ]);
  });

  it("tick Custom's scopes by what they let the device do, one tick per scope", () => {
    expect(SCOPES.map((scope) => SCOPE_TICKS[scope])).toEqual([
      "See sessions",
      "Start and organise sessions",
      "Run agents and answer their questions",
      "Use terminals, files and changes",
      "Change settings and sign in accounts",
    ]);
  });
});
