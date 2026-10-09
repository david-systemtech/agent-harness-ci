import {
  CONTAINMENT_LEVELS,
  compareContainment,
  type CapabilityFlag,
  type ContainmentAvailability,
  type ContainmentCause,
  type ContainmentLevel,
  type ContainmentReport,
  type ContainmentResolution,
} from "@agent-harness/contracts";
import type { ContainmentProbe } from "./containment-probe.js";

/**
 * What this environment can enforce, as the rest of the environment reads
 * it (permissions spec, "Containment"; ADR 0006): the probe's findings
 * (`containment-probe.ts`) and the adapters' `containment` flag turned into
 * the report `permissions.settings.get` answers, the capability flags on the
 * discovery URL and in `hello`, the environment's preset for
 * `permissions.containment.default`, and the lowering a run's level goes
 * through at its start. `off` is always enforceable, since it applies
 * nothing. A workspace level needs both the machine (the probe) and the
 * adapter (its descriptor's `containment` flag): a mechanism no adapter
 * hands its provider's sandbox enforces nothing, so recording it would be
 * false.
 */

const OFF: ContainmentAvailability = { level: "off", available: true, reason: null, cause: null };

/** Every level, `off` available and each workspace level as `workspace` says. */
const levelsOf = (workspace: (level: Exclude<ContainmentLevel, "off">) => ContainmentAvailability): ContainmentAvailability[] =>
  CONTAINMENT_LEVELS.map((level) => (level === "off" ? OFF : workspace(level)));

/** The report of what the probe found: every level, off first, with the reason, cause and detail one cannot be enforced; the mechanism; the container. */
export const containmentReport = (probe: ContainmentProbe): ContainmentReport => ({
  levels: levelsOf((level) => {
    const found = probe.levels[level];
    if (found.available) return { level, available: true, reason: null, cause: null };
    return { level, available: false, reason: found.reason, cause: found.cause, ...(found.detail === null ? {} : { detail: found.detail }) };
  }),
  ...(probe.platform !== undefined && { platform: probe.platform }),
  mechanism: probe.mechanism,
  container: probe.container,
});

/** A report with no workspace level, for `cause` and `reason`, keeping the container. */
const nothingAbove = (cause: ContainmentCause, reason: string, container: ContainmentReport["container"] = { declared: false, detected: false }): ContainmentReport => ({
  levels: levelsOf((level) => ({ level, available: false, reason, cause })),
  mechanism: null,
  container,
});

/** The report of an environment that has not probed: no workspace level, for the adapter host's presets and anything run with no environment around it. */
export const UNPROBED_REPORT: ContainmentReport = nothingAbove("not_probed", "Containment was not probed here, so no workspace level can be enforced.");

/** The report when the probe itself failed: no workspace level, the error as the reason. */
export const failedProbeReport = (error: unknown): ContainmentReport =>
  nothingAbove("probe_failed", `The containment probe failed, so no workspace level can be enforced: ${error instanceof Error ? error.message : String(error)}`);

/** Why a workspace level is not offered when the adapter does not enforce containment. */
export const ADAPTER_REASON = "The adapter does not enforce containment yet (its descriptor lacks the containment flag), so no workspace level can be enforced for its runs.";

/**
 * The report as the adapters allow it: unchanged when every adapter the
 * environment holds declares `containment`, else no workspace level, cause
 * `adapter`. A level the probe already refused keeps the probe's cause,
 * which is the one a person can act on.
 */
export const withAdapters = (report: ContainmentReport, adapters: readonly { readonly containment: boolean }[]): ContainmentReport => {
  if (adapters.length > 0 && adapters.every((adapter) => adapter.containment)) return report;
  return {
    ...report,
    levels: report.levels.map((entry) => (entry.available && entry.level !== "off" ? { level: entry.level, available: false, reason: ADAPTER_REASON, cause: "adapter" } : entry)),
    mechanism: null,
  };
};

/** Why `level` cannot be enforced here, with its cause and what the failing command printed; null when it can. */
export const unenforceable = (report: ContainmentReport, level: ContainmentLevel): { readonly reason: string; readonly cause: ContainmentCause; readonly detail?: string } | null => {
  const entry = report.levels.find((candidate) => candidate.level === level);
  if (entry === undefined) return { reason: `The containment probe did not report ${level}, so it cannot be enforced.`, cause: "not_probed" };
  if (entry.available) return null;
  return { reason: entry.reason, cause: entry.cause, ...(entry.detail !== undefined && { detail: entry.detail }) };
};

export const isEnforceable = (report: ContainmentReport, level: ContainmentLevel): boolean => unenforceable(report, level) === null;

/** The capability flags the report allows: `containment:workspace` and `containment:no-network`, each when its level can be enforced. */
export const containmentFlags = (report: ContainmentReport): CapabilityFlag[] => [
  ...(isEnforceable(report, "workspace") ? ["containment:workspace"] : []),
  ...(isEnforceable(report, "workspace-no-network") ? ["containment:no-network"] : []),
];

/** The level the preset asks for: `workspace`, where it can be enforced (permissions spec, "Containment"). */
export const PRESET_CONTAINMENT: ContainmentLevel = "workspace";

/**
 * The environment's preset for `permissions.containment.default`, as the
 * settings reads show it: `workspace` where it can be enforced, else `off`.
 * A default that was set keeps its value; only a key never set follows the
 * probe, at each start.
 */
export const presetContainmentDefault = (report: ContainmentReport): ContainmentLevel => (isEnforceable(report, PRESET_CONTAINMENT) ? PRESET_CONTAINMENT : "off");

/**
 * A run's containment (permissions spec, "Containment"): the level asked
 * for is the session's own, else the default that was set, else the preset's
 * `workspace`; it is lowered to the highest level at or below it this
 * environment can enforce, never refused, since `off` can always be
 * enforced. A level the probe cannot enforce is never resolved for a run.
 *
 * Unlike the mode, whose lowered default is not a clamp, a lowered level
 * always says why, the preset's included: a run that gets less containment
 * than the rules ask for (a session's level or a default that a restart
 * found unenforceable, or the preset's `workspace` on a machine that cannot
 * give it) is never silent about it. The mechanism is the probe's at a
 * workspace level, null at `off`.
 */
export const resolveContainment = (requested: ContainmentLevel | null, storedDefault: ContainmentLevel | null, report: ContainmentReport): ContainmentResolution => {
  const asked = requested ?? storedDefault ?? PRESET_CONTAINMENT;
  const effective = [...CONTAINMENT_LEVELS].reverse().find((level) => compareContainment(level, asked) <= 0 && isEnforceable(report, level)) ?? "off";
  if (effective === asked) return { requested, effective, mechanism: effective === "off" ? null : report.mechanism, reason: null };
  const why = unenforceable(report, asked)?.reason ?? "the probe no longer offers it.";
  const what = requested === null && storedDefault === null ? `The preset default is ${asked} where it can be enforced, and it` : `${asked}`;
  return {
    requested,
    effective,
    mechanism: effective === "off" ? null : report.mechanism,
    reason: `${what} cannot be enforced on this environment, so the run has ${effective}: ${why}`,
  };
};
