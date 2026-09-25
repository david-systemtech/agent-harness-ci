import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BYPASS_SENTENCE,
  CLAUDE_PERMISSION_MODE,
  CONTAINMENT_LEVELS,
  CONTAINMENT_MECHANISMS,
  Ceiling,
  ContainmentLevel,
  ContainmentReport,
  compareContainment,
  EVENT_TYPES,
  HelloFrame,
  MODES,
  Mode,
  PERMISSION_SETTINGS,
  PERMISSION_SETTINGS_KEYS,
  ParkedPromptTtl,
  PermissionSettingsPatch,
  SUMMARY_FIELD_OWNERS,
  TOOL_DECIDERS,
  ToolDecisionPayload,
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
      "permissions.containment.set": ["command", "runs:drive"],
      "permissions.settings.get": ["query", "read"],
      "permissions.settings.set": ["command", "admin"],
      "permissions.prompts.list": ["query", "read"],
      "permissions.prompts.answer": ["command", "runs:drive"],
      "permissions.review.list": ["query", "read"],
      "permissions.review.seen": ["command", "sessions:write"],
      "access.sessions.setCeiling": ["command", "admin"],
    });
    for (const name of ["permissions.mode.set", "permissions.containment.set", "permissions.settings.set", "permissions.prompts.answer", "permissions.review.seen", "access.sessions.setCeiling"] as const) {
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

  it("set a session's containment level with permissions.containment.set, one of the three, which may answer containment_unavailable", () => {
    const sessionId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const params = registry["permissions.containment.set"].params;
    for (const level of CONTAINMENT_LEVELS) expect(params.safeParse({ commandId, sessionId, level }).success, level).toBe(true);
    expect(params.safeParse({ commandId, sessionId, level: "sandbox" }).success).toBe(false);
    expect(params.safeParse({ sessionId, level: "off" }).success).toBe(false);
    expect(registry["permissions.containment.set"].errors.map((error) => error.shape.code.value)).toEqual(["containment_unavailable"]);
    const result = registry["permissions.containment.set"].result;
    expect(result.safeParse({ sessionId, containment: { requested: "workspace", effective: "workspace", clamped: false } }).success).toBe(true);
    expect(result.safeParse({ sessionId, containment: { requested: "workspace", effective: "workspace" } }).success).toBe(false);
  });
});

describe("containment", () => {
  it("has three levels, off < workspace < workspace-no-network, and two mechanisms, Seatbelt and bubblewrap", () => {
    expect(CONTAINMENT_LEVELS).toEqual(["off", "workspace", "workspace-no-network"]);
    expect(compareContainment("off", "workspace")).toBeLessThan(0);
    expect(compareContainment("workspace", "workspace-no-network")).toBeLessThan(0);
    expect(compareContainment("workspace", "workspace")).toBe(0);
    expect(compareContainment("workspace-no-network", "off")).toBeGreaterThan(0);
    expect(CONTAINMENT_MECHANISMS).toEqual(["seatbelt", "bubblewrap"]);
  });

  it("is reported by permissions.settings.get: each level with its reason, the mechanism, and the container as the operator's outer boundary", () => {
    const report = {
      levels: [
        { level: "off", available: true, reason: null, cause: null },
        { level: "workspace", available: true, reason: null, cause: null },
        { level: "workspace-no-network", available: false, reason: "socat is not installed.", cause: "socat_missing" },
      ],
      mechanism: "bubblewrap",
      container: { declared: true, detected: true },
    };
    expect(ContainmentReport.safeParse(report).success).toBe(true);
    expect(ContainmentReport.safeParse({ ...report, mechanism: null }).success).toBe(true);
    expect(ContainmentReport.safeParse({ ...report, mechanism: "none" }).success).toBe(false);
    expect(ContainmentReport.safeParse({ ...report, container: { declared: true } }).success).toBe(false);
    expect(registry["permissions.settings.get"].result.shape.containment).toBe(ContainmentReport);
  });
});

describe("the permissions events", () => {
  it("put run.policy.resolved and session.mode.set on the session stream: the policy changes nothing listed, the mode patches the summary's mode (#179)", () => {
    for (const type of ["run.policy.resolved", "session.mode.set"]) expect(EVENT_TYPES.session, type).toHaveProperty(type);
    expect(isListEvent("session", "run.policy.resolved")).toBe(false);
    expect(isListEvent("session", "session.mode.set")).toBe(true);
    expect(SUMMARY_FIELD_OWNERS.mode).toEqual({ command: "permissions.mode.set" });
  });

  it("put session.containment.set and tool.decision on the session stream, neither listed: the summary has no field for them", () => {
    for (const type of ["session.containment.set", "tool.decision"]) {
      expect(EVENT_TYPES.session, type).toHaveProperty(type);
      expect(isListEvent("session", type), type).toBe(false);
    }
    const set = EVENT_TYPES.session["session.containment.set"].payload;
    expect(set.safeParse({ containment: { requested: "workspace", effective: "workspace", clamped: false } }).success).toBe(true);
    expect(set.safeParse({ containment: { requested: "jail", effective: "workspace", clamped: false } }).success).toBe(false);
  });

  it("put ceiling.changed, bypass.acknowledged and settings.changed on the access stream", () => {
    for (const type of ["ceiling.changed", "bypass.acknowledged", "settings.changed"]) expect(EVENT_TYPES.access, type).toHaveProperty(type);
  });

  it("resolve a run's policy with its run, actor kind and name, attended, mode, containment and the unattended default", () => {
    const payload = EVENT_TYPES.session["run.policy.resolved"].payload;
    const resolved = {
      runId: "3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b",
      actorKind: "client",
      actorName: null,
      attended: true,
      mode: { requested: "bypassPermissions", effective: "acceptEdits", ceiling: "acceptEdits", clamped: true, clampReason: "ceiling" },
      containment: { requested: null, effective: "off", mechanism: null, reason: null },
      unattendedDefaultApplied: false,
    };
    expect(payload.safeParse(resolved).success).toBe(true);
    const contained = { ...resolved, containment: { requested: "workspace", effective: "workspace", mechanism: "bubblewrap", reason: null } };
    expect(payload.safeParse(contained).success).toBe(true);
    expect(payload.safeParse({ ...contained, containment: { ...contained.containment, mechanism: "docker" } }).success).toBe(false);
    expect(payload.safeParse({ ...resolved, mode: { ...resolved.mode, clampReason: "because" } }).success).toBe(false);
    expect(payload.safeParse({ ...resolved, actorKind: "provider" }).success).toBe(false);
    expect(payload.safeParse({ ...resolved, actorKind: "routine", actorName: "nightly-backup", attended: false }).success).toBe(true);
    expect(payload.safeParse({ ...resolved, actorName: "" }).success).toBe(false);
  });

  it("put tool.decision on the session stream, unflagged: one per tool call, with its tool, summary, outcome, decider, prompt and reason (#131)", () => {
    expect(EVENT_TYPES.session["tool.decision"].payload).toBe(ToolDecisionPayload);
    expect(isListEvent("session", "tool.decision")).toBe(false);
    expect(TOOL_DECIDERS).toEqual(["person", "mode", "rule", "classifier", "denylist", "containment", "ttl", "unattended", "bypass", "provider"]);
    const decision = {
      runId: "3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b",
      toolCallId: "toolu_1",
      tool: "Bash",
      summary: "Bash: rm -rf build",
      decision: "denied",
      decidedBy: "unattended",
      promptId: "toolu_1",
      reason: "Denied: nobody is present to approve this. Continue without it and say what you could not do.",
    };
    expect(ToolDecisionPayload.parse(decision)).toEqual(decision);
    expect(ToolDecisionPayload.safeParse({ ...decision, decision: "allowed", decidedBy: "mode", promptId: null, reason: null }).success).toBe(true);
    expect(ToolDecisionPayload.safeParse({ ...decision, decidedBy: "auto" }).success).toBe(false);
    expect(ToolDecisionPayload.safeParse({ ...decision, decision: "deny" }).success).toBe(false);
    // A denial always says why.
    expect(ToolDecisionPayload.safeParse({ ...decision, reason: null }).success).toBe(false);
    expect(ToolDecisionPayload.safeParse({ ...decision, summary: "" }).success).toBe(false);
    // The gate's containment denial (#133): a call it ruled on, with no prompt.
    const contained = { ...decision, toolCallId: "toolu_01", tool: "Write", summary: "Write /etc/hosts", decidedBy: "containment", promptId: null, reason: "Outside the workspace." };
    expect(ToolDecisionPayload.safeParse(contained).success).toBe(true);
    expect(ToolDecisionPayload.safeParse({ ...contained, decidedBy: "sandbox" }).success).toBe(false);
    // An allowed call carries no reason, and says so.
    expect(ToolDecisionPayload.safeParse({ ...contained, decision: "allowed", decidedBy: "mode" }).success).toBe(false);
    // A prompt that named no call still gets its decision (#131).
    expect(ToolDecisionPayload.safeParse({ ...decision, toolCallId: null, tool: null, decidedBy: "ttl" }).success).toBe(true);
  });

  it("put review.seen, the Unattended review's watermark, on the settings stream (#131)", () => {
    expect(EVENT_TYPES.settings).toHaveProperty("review.seen");
    expect(isListEvent("settings", "review.seen")).toBe(false);
    expect(EVENT_TYPES.settings["review.seen"].payload.safeParse({ through: 42 }).success).toBe(true);
    expect(EVENT_TYPES.settings["review.seen"].payload.safeParse({ through: -1 }).success).toBe(false);
  });
});

describe("the Unattended review methods (#131)", () => {
  const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const sessionId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const runId = "3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b";
  const row = {
    sessionId,
    runId,
    ranAt: "2026-09-24T01:02:03.456Z",
    actor: { kind: "routine", name: "nightly-backup" },
    attended: false,
    mode: { requested: null, effective: "acceptEdits", ceiling: "bypassPermissions", clamped: false, clampReason: null },
    containment: { requested: null, effective: "off", mechanism: null, reason: null },
    counts: { toolCalls: 3, autoApproved: 1, denied: 2, answeredByPerson: 0, expired: 0 },
    denials: [{ toolCallId: "toolu_1", tool: "Bash", summary: "Bash: sudo apt install", decidedBy: "unattended", reason: "Denied." }],
  };

  it("list the qualifying runs since the watermark, each with its actor, mode, containment, counts and denials", () => {
    const { params, result } = registry["permissions.review.list"];
    expect(params.safeParse({}).success).toBe(true);
    expect(result.safeParse({ watermark: 0, head: 12, runs: [row] }).success).toBe(true);
    expect(result.safeParse({ watermark: 0, head: 12, runs: [{ ...row, actor: { kind: "client", name: null } }] }).success).toBe(true);
    expect(result.safeParse({ watermark: 0, head: 12, runs: [{ ...row, counts: { ...row.counts, expired: -1 } }] }).success).toBe(false);
    expect(result.safeParse({ watermark: 0, head: 12, runs: [{ ...row, denials: [{ ...row.denials[0], decidedBy: "person", reason: "" }] }] }).success).toBe(false);
  });

  it("move the watermark through a log position, the head when none is named", () => {
    const { params, result } = registry["permissions.review.seen"];
    expect(params.safeParse({ commandId }).success).toBe(true);
    expect(params.safeParse({ commandId, through: 12 }).success).toBe(true);
    expect(params.safeParse({ commandId, through: -1 }).success).toBe(false);
    expect(params.safeParse({ through: 12 }).success).toBe(false);
    expect(result.safeParse({ watermark: 12 }).success).toBe(true);
  });
});
