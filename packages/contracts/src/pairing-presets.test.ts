import { describe, expect, it } from "vitest";
import { PAIRING_PRESETS, PAIRING_PRESET_IDS, PairingPreset, SCOPES, pairingPreset, presetGrant } from "./index.js";

describe("the pairing presets", () => {
  it("are My own client, A program, Phone and Custom, in that order, each valid against its schema", () => {
    expect(PAIRING_PRESETS.map((preset) => [preset.id, preset.name])).toEqual([
      ["own-client", "My own client"],
      ["program", "A program"],
      ["phone", "Phone"],
      ["custom", "Custom"],
    ]);
    expect(PAIRING_PRESETS.map((preset) => preset.id)).toEqual([...PAIRING_PRESET_IDS]);
    for (const preset of PAIRING_PRESETS) expect(PairingPreset.parse(preset), preset.id).toEqual(preset);
  });

  it("grant Phone read, session writing and run driving up to acceptEdits, without terminal or admin", () => {
    expect(presetGrant(pairingPreset("phone"))).toEqual({ ok: true, scopes: ["read", "sessions:write", "runs:drive"], ceiling: "acceptEdits" });
    expect(presetGrant(pairingPreset("phone"), { ceiling: "bypassPermissions" }).ok).toBe(false);
  });

  it("grant my own client every scope and bypassPermissions, which nobody changes", () => {
    expect(pairingPreset("own-client")).toMatchObject({ scopes: [...SCOPES], ceiling: "bypassPermissions", chooses: "nothing" });
    expect(presetGrant(pairingPreset("own-client"))).toEqual({ ok: true, scopes: [...SCOPES], ceiling: "bypassPermissions" });
    expect(presetGrant(pairingPreset("own-client"), { ceiling: "plan" })).toEqual({
      ok: false,
      message: "My own client grants every scope, up to bypassPermissions: it takes no other scopes or ceiling.",
    });
    expect(presetGrant(pairingPreset("own-client"), { scopes: ["read"] }).ok).toBe(false);
  });

  it("grant a program read, sessions:write and runs:drive up to acceptEdits, its ceiling picked and its scopes not", () => {
    expect(pairingPreset("program")).toMatchObject({ scopes: ["read", "sessions:write", "runs:drive"], ceiling: "acceptEdits", chooses: "ceiling" });
    expect(presetGrant(pairingPreset("program"))).toEqual({ ok: true, scopes: ["read", "sessions:write", "runs:drive"], ceiling: "acceptEdits" });
    expect(presetGrant(pairingPreset("program"), { ceiling: "plan" })).toEqual({ ok: true, scopes: ["read", "sessions:write", "runs:drive"], ceiling: "plan" });
    expect(presetGrant(pairingPreset("program"), { scopes: ["read"] })).toEqual({
      ok: false,
      message: "A program grants read, sessions:write and runs:drive: only its ceiling may be picked.",
    });
  });

  it("let a custom code tick its scopes and pick its ceiling, from read up to plan", () => {
    expect(pairingPreset("custom")).toMatchObject({ scopes: ["read"], ceiling: "plan", chooses: "scopes-and-ceiling" });
    expect(presetGrant(pairingPreset("custom"))).toEqual({ ok: true, scopes: ["read"], ceiling: "plan" });
    expect(presetGrant(pairingPreset("custom"), { scopes: ["terminal", "read"], ceiling: "auto" })).toEqual({ ok: true, scopes: ["read", "terminal"], ceiling: "auto" });
    expect(presetGrant(pairingPreset("custom"), { scopes: [] })).toEqual({ ok: false, message: "A pairing code grants at least one scope." });
  });
});
