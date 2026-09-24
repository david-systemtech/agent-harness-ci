import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BYPASS_SENTENCE,
  CLAUDE_PERMISSION_MODE,
  Ceiling,
  ContainmentLevel,
  EVENT_TYPES,
  HelloFrame,
  MODES,
  Mode,
  PERMISSION_SETTINGS,
  PERMISSION_SETTINGS_KEYS,
  ParkedPromptTtl,
  PermissionSettingsPatch,
  SUMMARY_FIELD_OWNERS,
  UnattendedMode,
  compareModes,
  isListEvent,
  methods,
  parkedPromptTtlMs,
  presetPermissionSettings,
  registry,
} from "./index.js";

/**
 * The permissions contract (permissions spec, "Modes and the Claude
 * mapping", "Ceilings", "Methods on the wire", "Events"; ADR 0006): the four
 * modes and their order, the Claude mapping, the bypass sentence, the
 * permission settings' keys, and the scope of every permissions method.
 */

describe("the modes", () => {
  it("are plan < acceptEdits < auto < bypassPermissions, in that order", () => {
    expect(MODES).toEqual(["plan", "acceptEdits", "auto", "bypassPermissions"]);
    expect(compareModes("plan", "acceptEdits")).toBeLessThan(0);
    expect(compareModes("acceptEdits", "auto")).toBeLessThan(0);
    expect(compareModes("auto", "bypassPermissions")).toBeLessThan(0);
    expect(compareModes("auto", "auto")).toBe(0);
    expect(compareModes("bypassPermissions", "plan")).toBeGreaterThan(0);
  });

  it("each have a Claude mapping, the SDK permissionMode of the same name, and a place in the order", () => {
    expect(Object.keys(CLAUDE_PERMISSION_MODE).sort()).toEqual([...MODES].sort());
    for (const mode of MODES) {
      expect(CLAUDE_PERMISSION_MODE[mode], mode).toBe(mode);
      expect(MODES.indexOf(mode), mode).toBeGreaterThanOrEqual(0);
    }
  });

  it("reject default and dontAsk on the wire with an issue that names the four", () => {
    for (const refused of ["default", "dontAsk"]) {
      const parsed = Mode.safeParse(refused);
      expect(parsed.success, refused).toBe(false);
      expect(parsed.error?.issues[0]?.message, refused).toContain("plan, acceptEdits, auto, bypassPermissions");
      expect(parsed.error?.issues[0]?.message, refused).toContain(`${refused} is never used`);
      expect(Ceiling.safeParse(refused).success, refused).toBe(false);
    }
    expect(Mode.safeParse("Plan").success).toBe(false);
    expect(Mode.safeParse("").success).toBe(false);
  });

  it("make the ceiling a mode: hello refuses a ceiling that is not one", () => {
    const hello = {
      type: "hello",
      protocolVersion: 1,
      capabilities: [],
      environmentId: "0f8fad5b-d9cb-469f-a165-70867728950e",
      environmentName: "SYSTEM-SERVER",
      clientSessionId: "cs-1",
      scopes: ["read"],
      ceiling: "acceptEdits",
      serverTime: "2026-09-24T01:02:03.456Z",
    };
    expect(HelloFrame.safeParse(hello).success).toBe(true);
    expect(HelloFrame.safeParse({ ...hello, ceiling: "dontAsk" }).success).toBe(false);
  });
});

describe("the modes' descriptions", () => {
  // zod 4's .meta() gives a new schema, so a site that describes a mode for its own use (the ceiling, a
  // setting, the event) never changes Mode's own description, nor another site's.
  it("keep Mode's own through every site that describes a mode for itself, the ceiling's apart", () => {
    const describe = (schema: z.ZodType): unknown => z.toJSONSchema(schema)["description"];
    const own = describe(Mode);
    expect(own).toMatch(/^What an agent may do without asking/);
    expect(describe(Ceiling)).toMatch(/^The highest mode a client session/);
    expect(describe(PERMISSION_SETTINGS["permissions.defaultCeiling"].schema)).toBe("The ceiling a pairing gives when none is chosen.");
    expect(describe(ContainmentLevel)).toMatch(/^Where a run may reach/);
    expect(describe(PERMISSION_SETTINGS["permissions.containment.default"].schema)).toBe("The containment level of a run whose session names none.");
    expect(describe(Mode)).toBe(own);
    const schemaDir = join(import.meta.dirname, "..", "schema");
    const read = (path: string) => (JSON.parse(readFileSync(join(schemaDir, path), "utf8")) as { description: string }).description;
    expect(read("permissions/mode.json")).toBe(own);
    expect(read("ceiling.json")).not.toBe(read("permissions/mode.json"));
  });
});

describe("the bypass sentence", () => {
  it("is carried verbatim", () => {
    expect(BYPASS_SENTENCE).toBe("The agent will act without asking and can do anything this account can, within the containment you chose.");
  });
});

describe("the permission settings", () => {
  it("are the five keys the Permissions step writes, each with a schema its preset passes", () => {
    expect(PERMISSION_SETTINGS_KEYS).toEqual([
      "permissions.defaultCeiling",
      "permissions.unattended.mode",
      "permissions.unattended.bypassAcknowledgedAt",
      "permissions.parkedPrompt.ttl",
      "permissions.containment.default",
    ]);
    for (const key of PERMISSION_SETTINGS_KEYS) {
      const definition = PERMISSION_SETTINGS[key];
      expect(definition.schema.safeParse(definition.preset).success, key).toBe(true);
      // The Permissions step (#141), in the Access band whose row is access.permissions (ADR 0027).
      expect(definition.step, key).toEqual({ id: "permissions", band: "access" });
    }
  });

  it("preset the default ceiling acceptEdits, the unattended mode acceptEdits unacknowledged, the TTL 24 hours, containment off", () => {
    expect(presetPermissionSettings()).toEqual({
      "permissions.defaultCeiling": "acceptEdits",
      "permissions.unattended.mode": "acceptEdits",
      "permissions.unattended.bypassAcknowledgedAt": null,
      "permissions.parkedPrompt.ttl": { amount: 24, unit: "hours" },
      "permissions.containment.default": "off",
    });
  });

  it("take acceptEdits or bypassPermissions as the unattended mode, and no other", () => {
    expect(UnattendedMode.safeParse("acceptEdits").success).toBe(true);
    expect(UnattendedMode.safeParse("bypassPermissions").success).toBe(true);
    for (const other of ["plan", "auto", "default"]) expect(UnattendedMode.safeParse(other).success, other).toBe(false);
  });

  it("take a duration or never as the parked-prompt TTL", () => {
    for (const ttl of [{ amount: 24, unit: "hours" }, { amount: 30, unit: "minutes" }, { amount: 7, unit: "days" }, "never"]) {
      expect(ParkedPromptTtl.safeParse(ttl).success, JSON.stringify(ttl)).toBe(true);
    }
    for (const ttl of [{ amount: 0, unit: "hours" }, { amount: 1.5, unit: "hours" }, { amount: 1, unit: "weeks" }, "forever", null, 86_400_000]) {
      expect(ParkedPromptTtl.safeParse(ttl).success, JSON.stringify(ttl)).toBe(false);
    }
    expect(parkedPromptTtlMs({ amount: 24, unit: "hours" })).toBe(24 * 60 * 60 * 1000);
    expect(parkedPromptTtlMs({ amount: 90, unit: "minutes" })).toBe(90 * 60 * 1000);
    expect(parkedPromptTtlMs({ amount: 2, unit: "days" })).toBe(2 * 24 * 60 * 60 * 1000);
    expect(parkedPromptTtlMs("never")).toBeNull();
  });

  it("are written in any subset, but never the acknowledgement time, which only the environment records", () => {
    expect(PermissionSettingsPatch.safeParse({}).success).toBe(true);
    expect(PermissionSettingsPatch.safeParse({ "permissions.parkedPrompt.ttl": "never" }).success).toBe(true);
    expect(PermissionSettingsPatch.safeParse({ "permissions.unattended.bypassAcknowledgedAt": "2026-09-24T01:02:03.456Z" }).success).toBe(false);
    expect(PermissionSettingsPatch.safeParse({ "permissions.defaultCeiling": "dontAsk" }).success).toBe(false);
    expect(PermissionSettingsPatch.safeParse({ "permissions.other": 1 }).success).toBe(false);
  });
});

describe("the permissions methods", () => {
  it("each have one scope, a commandId on the mutating ones", () => {
    const table = Object.fromEntries(
      methods.filter((m) => m.name.startsWith("permissions.") || m.name === "access.sessions.setCeiling").map((m) => [m.name, [m.kind, m.scope]]),
    );
    expect(table).toEqual({
      "permissions.mode.set": ["command", "runs:drive"],
      "permissions.settings.get": ["query", "read"],
      "permissions.settings.set": ["command", "admin"],
      "access.sessions.setCeiling": ["command", "admin"],
    });
    for (const name of ["permissions.mode.set", "permissions.settings.set", "access.sessions.setCeiling"] as const) {
      expect(Object.keys(registry[name].params.shape), name).toContain("commandId");
    }
  });

  it("refuse a mode that is not one of the four in permissions.mode.set and a ceiling in access.pairings.create", () => {
    const sessionId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
    expect(registry["permissions.mode.set"].params.safeParse({ commandId, sessionId, mode: "auto" }).success).toBe(true);
    expect(registry["permissions.mode.set"].params.safeParse({ commandId, sessionId, mode: "default" }).success).toBe(false);
    expect(registry["access.pairings.create"].params.safeParse({ commandId, ceiling: "dontAsk" }).success).toBe(false);
    expect(registry["runs.start"].params.safeParse({ commandId, sessionId, text: "Go", mode: "dontAsk" }).success).toBe(false);
  });
});

describe("the permissions events", () => {
  it("put run.policy.resolved and session.mode.set on the session stream: the policy changes nothing listed, the mode patches the summary's mode (#179)", () => {
    for (const type of ["run.policy.resolved", "session.mode.set"]) expect(EVENT_TYPES.session, type).toHaveProperty(type);
    expect(isListEvent("session", "run.policy.resolved")).toBe(false);
    expect(isListEvent("session", "session.mode.set")).toBe(true);
    expect(SUMMARY_FIELD_OWNERS.mode).toEqual({ command: "permissions.mode.set" });
  });

  it("put ceiling.changed, bypass.acknowledged and settings.changed on the access stream", () => {
    for (const type of ["ceiling.changed", "bypass.acknowledged", "settings.changed"]) expect(EVENT_TYPES.access, type).toHaveProperty(type);
  });

  it("resolve a run's policy with its run, actor kind, attended, mode, containment and the unattended default", () => {
    const payload = EVENT_TYPES.session["run.policy.resolved"].payload;
    const resolved = {
      runId: "3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b",
      actorKind: "client",
      attended: true,
      mode: { requested: "bypassPermissions", effective: "acceptEdits", ceiling: "acceptEdits", clamped: true, clampReason: "ceiling" },
      containment: { requested: null, effective: "off", mechanism: null, reason: null },
      unattendedDefaultApplied: false,
    };
    expect(payload.safeParse(resolved).success).toBe(true);
    expect(payload.safeParse({ ...resolved, mode: { ...resolved.mode, clampReason: "because" } }).success).toBe(false);
    expect(payload.safeParse({ ...resolved, actorKind: "provider" }).success).toBe(false);
  });
});
