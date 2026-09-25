import {
  CONTAINMENT_LEVELS,
  compareContainment,
  type CapabilityFlag,
  type ContainmentAvailability,
  type ContainmentLevel,
  type ContainmentReport,
  type ContainmentResolution,
} from "@agent-harness/contracts";
import type { ContainmentProbe } from "./containment-probe.js";

/**
 * What this environment can enforce, as the rest of the environment reads
 * it (permissions spec, "Containment"; ADR 0006): the probe's findings
 * (`containment-probe.ts`) turned into the report `permissions.settings.get`
 * answers, the capability flags on the discovery URL and in `hello`, the
 * environment's preset for `permissions.containment.default`, and the clamp
 * a run's level goes through at its start. `off` is always enforceable,
 * since it applies nothing.
 */

/** The report of what the probe found: every level, off first, with the reason one cannot be enforced; the mechanism; the container. */
export const containmentReport = (probe: ContainmentProbe): ContainmentReport => ({
  levels: CONTAINMENT_LEVELS.map((level): ContainmentAvailability => {
    if (level === "off") return { level, available: true, reason: null };
    const found = probe.levels[level];
    return found.available ? { level, available: true, reason: null } : { level, available: false, reason: found.reason };
  }),
  mechanism: probe.mechanism,
  container: probe.container,
});

/** Why `level` cannot be enforced here; null when it can. */
export const unenforceableReason = (report: ContainmentReport, level: ContainmentLevel): string | null => {
  const entry = report.levels.find((candidate) => candidate.level === level);
  if (entry === undefined) return `The containment probe did not report ${level}, so it cannot be enforced.`;
  return entry.available ? null : entry.reason;
};

export const isEnforceable = (report: ContainmentReport, level: ContainmentLevel): boolean => unenforceableReason(report, level) === null;

/** The capability flags the report allows: `containment:workspace` and `containment:no-network`, each when its level can be enforced. */
export const containmentFlags = (report: ContainmentReport): CapabilityFlag[] => [
  ...(isEnforceable(report, "workspace") ? ["containment:workspace"] : []),
  ...(isEnforceable(report, "workspace-no-network") ? ["containment:no-network"] : []),
];

/**
 * The environment's preset for `permissions.containment.default`: `workspace`
 * where it can be enforced, else `off` (permissions spec, "Containment").
 * A default that was set keeps its value; only a key never set follows the
 * probe, at each start.
 */
export const presetContainmentDefault = (report: ContainmentReport): ContainmentLevel => (isEnforceable(report, "workspace") ? "workspace" : "off");

/**
 * A run's containment (permissions spec, "Containment"): the level asked
 * for (the session's own, or the default when it names none), lowered to the
 * highest level at or below it this environment can enforce, with the reason
 * when it was lowered, never refused: `off` can always be enforced. A level
 * the probe cannot enforce is never resolved for a run. Only a level the
 * probe could enforce when it was chosen and cannot now (a restart found
 * bubblewrap gone) is lowered, since choosing an unenforceable one is
 * refused (`containment_unavailable`). The mechanism is the probe's at a
 * workspace level, null at `off`.
 */
export const resolveContainment = (requested: ContainmentLevel | null, fallback: ContainmentLevel, report: ContainmentReport): ContainmentResolution => {
  const asked = requested ?? fallback;
  const effective = [...CONTAINMENT_LEVELS].reverse().find((level) => compareContainment(level, asked) <= 0 && isEnforceable(report, level)) ?? "off";
  const reason =
    effective === asked
      ? null
      : `${asked} cannot be enforced on this environment, so the run has ${effective}: ${unenforceableReason(report, asked) ?? "the probe no longer offers it."}`;
  return { requested, effective, mechanism: effective === "off" ? null : report.mechanism, reason };
};

/**
 * The report of an environment that has not probed: no workspace level, for
 * the adapter host's presets and anything run with no environment around it.
 */
export const UNPROBED_REPORT: ContainmentReport = {
  levels: CONTAINMENT_LEVELS.map((level): ContainmentAvailability =>
    level === "off"
      ? { level, available: true, reason: null }
      : { level, available: false, reason: "Containment was not probed here, so no workspace level can be enforced." },
  ),
  mechanism: null,
  container: { declared: false, detected: false },
};
