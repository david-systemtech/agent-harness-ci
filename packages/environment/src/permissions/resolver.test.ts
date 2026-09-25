import { MODES, type ContainmentReport, type Mode, type ModeAvailability } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { UNPROBED_REPORT } from "./containment.js";
import { resolvePolicy, type PolicyInput } from "./resolver.js";

/**
 * The policy resolver on its own (permissions spec, "Modules": the policy
 * resolver): pure, so every clamp rule is a table. The wire's tests
 * (`permissions.test.ts`) prove the same rules reach `run.policy.resolved`.
 */

const everyMode: readonly ModeAvailability[] = MODES.map((mode) => ({ mode, available: true, reason: null }));

const without = (...missing: Mode[]): ModeAvailability[] =>
  everyMode.map((entry) => (missing.includes(entry.mode) ? { mode: entry.mode, available: false, reason: `No ${entry.mode} on this account.` } : entry));

const input = (overrides: Partial<PolicyInput> = {}): PolicyInput => ({
  actor: { kind: "client" },
  requested: null,
  ceiling: "bypassPermissions",
  accountModes: everyMode,
  settings: { unattendedMode: "acceptEdits", containmentDefault: "off" },
  containment: null,
  enforceable: UNPROBED_REPORT,
  ...overrides,
});

const modeOf = (overrides: Partial<PolicyInput>) => {
  const resolved = resolvePolicy(input(overrides));
  if ("refused" in resolved) throw new Error(resolved.refused);
  return resolved.mode;
};

describe("the policy resolver", () => {
  it("gives a requested mode at or below the ceiling as it is, unclamped", () => {
    for (const mode of MODES) {
      expect(modeOf({ requested: mode }), mode).toEqual({ requested: mode, effective: mode, ceiling: "bypassPermissions", clamped: false, clampReason: null });
    }
  });

  it("resolves a requested mode above the ceiling to the ceiling, clamped by it, never refusing", () => {
    expect(modeOf({ requested: "bypassPermissions", ceiling: "acceptEdits" })).toEqual({
      requested: "bypassPermissions",
      effective: "acceptEdits",
      ceiling: "acceptEdits",
      clamped: true,
      clampReason: "ceiling",
    });
    expect(modeOf({ requested: "auto", ceiling: "plan" })).toMatchObject({ effective: "plan", clamped: true, clampReason: "ceiling" });
  });

  it("clamps a mode the account lists as unavailable to the next lower available one, reason unavailable", () => {
    expect(modeOf({ requested: "auto", accountModes: without("auto") })).toEqual({
      requested: "auto",
      effective: "acceptEdits",
      ceiling: "bypassPermissions",
      clamped: true,
      clampReason: "unavailable",
    });
    expect(modeOf({ requested: "auto", accountModes: without("auto", "acceptEdits") })).toMatchObject({ effective: "plan", clampReason: "unavailable" });
    // A mode the account does not list at all is unavailable too.
    expect(modeOf({ requested: "auto", accountModes: everyMode.filter((entry) => entry.mode !== "auto") })).toMatchObject({ effective: "acceptEdits", clampReason: "unavailable" });
  });

  it("names unavailable when the ceiling's own mode is unavailable, having lowered the request to it first", () => {
    expect(modeOf({ requested: "bypassPermissions", ceiling: "auto", accountModes: without("auto") })).toMatchObject({
      effective: "acceptEdits",
      ceiling: "auto",
      clamped: true,
      clampReason: "unavailable",
    });
  });

  it("refuses only when no mode at or below the ceiling is available: the ceiling is never exceeded", () => {
    expect(resolvePolicy(input({ requested: "plan", ceiling: "plan", accountModes: without("plan") }))).toEqual({
      refused: expect.stringContaining("plan") as unknown as string,
    });
  });

  it("starts an attended run that names no mode in acceptEdits, lowered to the ceiling but not reported clamped: a default applied", () => {
    expect(modeOf({})).toEqual({ requested: null, effective: "acceptEdits", ceiling: "bypassPermissions", clamped: false, clampReason: null });
    expect(modeOf({ ceiling: "plan" })).toEqual({ requested: null, effective: "plan", ceiling: "plan", clamped: false, clampReason: null });
    expect(modeOf({ accountModes: without("acceptEdits") })).toEqual({ requested: null, effective: "plan", ceiling: "bypassPermissions", clamped: false, clampReason: null });
  });

  it("gives an unattended run that names no mode the unattended default, within its ceiling, and says so", () => {
    const unattended = { actor: { kind: "routine" } } as const;
    const bypass = { unattendedMode: "bypassPermissions", containmentDefault: "off" } as const;
    expect(resolvePolicy(input({ ...unattended, settings: bypass }))).toEqual({
      actorKind: "routine",
      attended: false,
      mode: { requested: null, effective: "bypassPermissions", ceiling: "bypassPermissions", clamped: false, clampReason: null },
      containment: { requested: null, effective: "off", mechanism: null, reason: null },
      unattendedDefaultApplied: true,
    });
    expect(resolvePolicy(input({ ...unattended, settings: bypass, ceiling: "acceptEdits" }))).toMatchObject({
      mode: { requested: null, effective: "acceptEdits", clamped: false, clampReason: null },
      unattendedDefaultApplied: true,
    });
    // A routine that names its mode overrides the default.
    expect(resolvePolicy(input({ ...unattended, settings: bypass, requested: "plan" }))).toMatchObject({
      mode: { requested: "plan", effective: "plan" },
      unattendedDefaultApplied: false,
    });
  });

  it("never applies the unattended default to an attended run", () => {
    const resolved = resolvePolicy(input({ actor: { kind: "completions", attended: true }, settings: { unattendedMode: "bypassPermissions", containmentDefault: "off" } }));
    expect(resolved).toMatchObject({ actorKind: "completions", attended: true, mode: { effective: "acceptEdits" }, unattendedDefaultApplied: false });
  });

  it("derives attendance from who started the run: a client is attended, a routine or a bot never, the completions surface when it says so", () => {
    expect(resolvePolicy(input({ actor: { kind: "client" } }))).toMatchObject({ attended: true });
    expect(resolvePolicy(input({ actor: { kind: "routine" } }))).toMatchObject({ attended: false });
    expect(resolvePolicy(input({ actor: { kind: "bot" } }))).toMatchObject({ attended: false });
    expect(resolvePolicy(input({ actor: { kind: "completions", attended: false } }))).toMatchObject({ attended: false, unattendedDefaultApplied: true });
  });
});

/** What a probe that found bubblewrap reports: both workspace levels, or only `workspace` when no network cannot be enforced. */
const bubblewrap = (noNetwork = true): ContainmentReport => ({
  levels: [
    { level: "off", available: true, reason: null, cause: null },
    { level: "workspace", available: true, reason: null, cause: null },
    noNetwork
      ? { level: "workspace-no-network", available: true, reason: null, cause: null }
      : { level: "workspace-no-network", available: false, reason: "bubblewrap cannot give a run a network namespace of its own here.", cause: "failed" },
  ],
  mechanism: "bubblewrap",
  container: { declared: false, detected: false },
});

const containmentOf = (overrides: Partial<PolicyInput>) => {
  const resolved = resolvePolicy(input(overrides));
  if ("refused" in resolved) throw new Error(resolved.refused);
  return resolved.containment;
};

describe("the policy resolver's containment", () => {
  const settings = (containmentDefault: PolicyInput["settings"]["containmentDefault"]) => ({ unattendedMode: "acceptEdits", containmentDefault }) as const;

  it("gives a run the default when its session names no level, with the mechanism the probe found at a workspace level", () => {
    expect(containmentOf({ settings: settings("workspace"), enforceable: bubblewrap() })).toEqual({
      requested: null,
      effective: "workspace",
      mechanism: "bubblewrap",
      reason: null,
    });
    expect(containmentOf({ settings: settings("off"), enforceable: bubblewrap() })).toEqual({ requested: null, effective: "off", mechanism: null, reason: null });
  });

  it("gives a run its session's own level over the default, lower or higher", () => {
    expect(containmentOf({ settings: settings("workspace"), containment: "off", enforceable: bubblewrap() })).toEqual({
      requested: "off",
      effective: "off",
      mechanism: null,
      reason: null,
    });
    expect(containmentOf({ settings: settings("off"), containment: "workspace-no-network", enforceable: bubblewrap() })).toEqual({
      requested: "workspace-no-network",
      effective: "workspace-no-network",
      mechanism: "bubblewrap",
      reason: null,
    });
  });

  it("lowers a level the probe cannot enforce to the highest one below it that it can, with the reason, never refusing", () => {
    const lowered = containmentOf({ containment: "workspace-no-network", enforceable: bubblewrap(false) });
    expect(lowered).toMatchObject({ requested: "workspace-no-network", effective: "workspace", mechanism: "bubblewrap" });
    expect(lowered.reason).toMatch(/workspace-no-network cannot be enforced/);
    expect(lowered.reason).toMatch(/network namespace/);
    const off = containmentOf({ containment: "workspace", enforceable: UNPROBED_REPORT });
    expect(off).toMatchObject({ requested: "workspace", effective: "off", mechanism: null });
    expect(off.reason).toMatch(/not probed/);
    // A default the probe can no longer enforce is lowered the same way, and says why.
    expect(containmentOf({ settings: settings("workspace"), enforceable: UNPROBED_REPORT })).toMatchObject({
      requested: null,
      effective: "off",
      reason: expect.stringMatching(/workspace cannot be enforced/) as unknown as string,
    });
  });

  it("asks for the preset's workspace when no default was set, and says why when it cannot be enforced", () => {
    expect(containmentOf({ settings: settings(null), enforceable: bubblewrap() })).toEqual({ requested: null, effective: "workspace", mechanism: "bubblewrap", reason: null });
    const lowered = containmentOf({ settings: settings(null), enforceable: UNPROBED_REPORT });
    expect(lowered).toMatchObject({ requested: null, effective: "off", mechanism: null });
    expect(lowered.reason).toMatch(/preset default is workspace/);
    expect(lowered.reason).toMatch(/not probed/);
  });

  it("lets a routine or a bot inherit the default unless it names its own level, as any run does", () => {
    for (const kind of ["routine", "bot"] as const) {
      expect(containmentOf({ actor: { kind }, settings: settings("workspace"), enforceable: bubblewrap() }), kind).toMatchObject({ requested: null, effective: "workspace" });
      expect(containmentOf({ actor: { kind }, settings: settings("workspace"), containment: "workspace-no-network", enforceable: bubblewrap() }), kind).toMatchObject({
        requested: "workspace-no-network",
        effective: "workspace-no-network",
      });
    }
  });
});
