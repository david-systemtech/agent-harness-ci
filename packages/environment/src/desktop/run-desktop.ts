import type { ContainmentLevel, RunDesktopResolution, SessionDesktop } from "@agent-harness/contracts";

/**
 * A run's desktop, resolved once at its start (computer spec, "Session field
 * and run resolution"; ADR 0038; #2161) from the session's field, whether a
 * person is present, the run's containment, the operator's
 * `desktop.contained.allowRuns` and what this environment can drive, to be
 * recorded as `run.desktop.resolved` beside the run's policy. Fixed for the
 * run; availability, geometry and input safety are still checked at each
 * call. It never falls back from contained to live, or from one desktop to
 * another: what is not available resolves to none, with the reason.
 */

/** Whether this environment can drive a kind of desktop now: yes, or no with why (a clause the message follows a colon with). */
export type DesktopAvailability = { readonly available: true } | { readonly available: false; readonly reason: string };

/** What a run's desktop is resolved from: the session's field, and whether a person is present for the run. */
export interface DesktopRequest {
  /** The session's desktop; null where it has none (an older session, a completions request that asked for none). */
  readonly field: SessionDesktop | null;
  readonly attended: boolean;
}

export interface DesktopResolutionSettings {
  /** `desktop.contained.allowRuns`: off, no run on this environment drives its contained desktop, an explicit choice included. */
  readonly containedAllowRuns: boolean;
  /** The run's workspace containment: anything but off refuses a live desktop, which can reach outside any shell boundary. */
  readonly containment: ContainmentLevel;
  readonly contained: DesktopAvailability;
  readonly local: DesktopAvailability;
}

const NONE: SessionDesktop = { kind: "none" };

const none = (requested: SessionDesktop, reason: RunDesktopResolution["reason"], message: string): RunDesktopResolution => ({ requested, desktop: NONE, reason, message });

/**
 * A run's desktop: none unless the session chose one; a contained desktop
 * when the operator allows runs one and it is available here; this person's
 * live desktop only on an attended run with containment off, and available.
 */
export const resolveRunDesktop = ({ field, attended }: DesktopRequest, settings: DesktopResolutionSettings): RunDesktopResolution => {
  const requested = field ?? NONE;
  switch (requested.kind) {
    case "none":
      return none(requested, "none", "The session chose no desktop.");
    case "contained":
      if (!settings.containedAllowRuns) return none(requested, "operator-disabled", "The session chose the contained desktop, but desktop.contained.allowRuns is off, so no run on this environment drives it.");
      if (!settings.contained.available) return none(requested, "unavailable", `The session chose the contained desktop, but it is not available on this environment: ${settings.contained.reason}.`);
      return { requested, desktop: requested, reason: "selected", message: "The session chose the contained desktop." };
    case "local":
      if (!attended) return none(requested, "unattended", "The session chose this computer's desktop, but nobody is present for this run, and only an attended run drives a live desktop.");
      if (settings.containment !== "off") {
        return none(requested, "containment", `The session chose this computer's desktop, but the run's containment is ${settings.containment}: live input reaches applications outside any containment boundary, so a contained run never drives it.`);
      }
      if (!settings.local.available) return none(requested, "unavailable", `The session chose this computer's desktop, but it cannot be driven: ${settings.local.reason}.`);
      return { requested, desktop: requested, reason: "selected", message: "The session chose this computer's desktop." };
  }
};

/** What a run's start hands the desktop seam: the request, and the containment level its policy resolved. */
export interface RunDesktopRequest extends DesktopRequest {
  readonly containment: ContainmentLevel;
}

/** Resolves a run's desktop at its start; the environment's reads `desktop.contained.allowRuns` and what it can drive. */
export type DesktopSeam = (request: RunDesktopRequest) => RunDesktopResolution;

/** Why the contained desktop is unavailable while this environment has none configured (#2162 configures one). */
export const NO_CONTAINED_DESKTOP = "none is configured";
/** Why this person's live desktop is unavailable while the environment has no live helper (#2164 onwards). */
export const NO_LIVE_DESKTOP = "this environment has no live desktop helper yet";

/** The resolution on the settings' presets (`desktop.contained.allowRuns` off) and no desktop to drive: what the adapter host resolves with unless given its seam. */
export const presetDesktop: DesktopSeam = ({ containment, ...request }) =>
  resolveRunDesktop(request, {
    containedAllowRuns: false,
    containment,
    contained: { available: false, reason: NO_CONTAINED_DESKTOP },
    local: { available: false, reason: NO_LIVE_DESKTOP },
  });
