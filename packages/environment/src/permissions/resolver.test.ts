import { MODES, type Mode, type ModeAvailability } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
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
