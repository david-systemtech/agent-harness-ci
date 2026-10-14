import type { SessionDesktop } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { resolveRunDesktop, type DesktopResolutionSettings } from "./run-desktop.js";

/**
 * A run's desktop at its start (computer spec, "Session field and run
 * resolution"; #2161): attended, unattended and completions requests, the
 * operator's switch, containment and availability, never a fallback.
 */

const ON: DesktopResolutionSettings = { containedAllowRuns: true, containment: "off", contained: { available: true }, local: { available: true } };
const CONTAINED: SessionDesktop = { kind: "contained" };
const LOCAL: SessionDesktop = { kind: "local" };

describe("a run's desktop", () => {
  it("is none when the session chose none, or has no field (an older session, a completions request that asked for none)", () => {
    expect(resolveRunDesktop({ field: null, attended: true }, ON)).toMatchObject({ requested: { kind: "none" }, desktop: { kind: "none" }, reason: "none" });
    expect(resolveRunDesktop({ field: { kind: "none" }, attended: false }, ON).reason).toBe("none");
  });

  it("is the contained desktop on an attended or unattended run, an explicit completions choice included, when the operator allows it", () => {
    expect(resolveRunDesktop({ field: CONTAINED, attended: true }, ON)).toEqual({ requested: CONTAINED, desktop: CONTAINED, reason: "selected", message: "The session chose the contained desktop." });
    expect(resolveRunDesktop({ field: CONTAINED, attended: false }, ON).desktop).toEqual(CONTAINED);
  });

  it("is none, with why, when the operator's switch is off or the contained desktop is not available", () => {
    expect(resolveRunDesktop({ field: CONTAINED, attended: true }, { ...ON, containedAllowRuns: false })).toMatchObject({ desktop: { kind: "none" }, reason: "operator-disabled" });
    const unavailable = resolveRunDesktop({ field: CONTAINED, attended: true }, { ...ON, contained: { available: false, reason: "none is configured" } });
    expect(unavailable).toMatchObject({ desktop: { kind: "none" }, reason: "unavailable" });
    expect(unavailable.message).toContain("not available on this environment: none is configured.");
  });

  it("is this computer's desktop only on an attended run with containment off, never falling back to the contained one", () => {
    expect(resolveRunDesktop({ field: LOCAL, attended: true }, ON)).toMatchObject({ desktop: LOCAL, reason: "selected" });
    expect(resolveRunDesktop({ field: LOCAL, attended: false }, ON)).toMatchObject({ requested: LOCAL, desktop: { kind: "none" }, reason: "unattended" });
    expect(resolveRunDesktop({ field: LOCAL, attended: true }, { ...ON, containment: "workspace" })).toMatchObject({ desktop: { kind: "none" }, reason: "containment" });
    expect(resolveRunDesktop({ field: LOCAL, attended: true }, { ...ON, containment: "workspace-no-network" }).reason).toBe("containment");
    expect(resolveRunDesktop({ field: LOCAL, attended: true }, { ...ON, local: { available: false, reason: "Wayland is not supported yet" } })).toMatchObject({ desktop: { kind: "none" }, reason: "unavailable" });
  });
});
