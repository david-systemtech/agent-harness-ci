import type { ContainmentAvailability } from "@agent-harness/contracts";

/**
 * Containment's placeholder (permissions spec, "Containment"), until #133's
 * prober replaces this module: only `off` can be enforced, so a run's
 * containment is the default, which `permissions.settings.set` refuses to be
 * anything else, and every workspace level is unavailable with the reason.
 */

const NOT_PROBED = "The containment prober is not built yet (#133), so no workspace level can be enforced.";

/** Each containment level and whether this environment can enforce it. */
export const containmentAvailability = (): ContainmentAvailability[] => [
  { level: "off", available: true, reason: null },
  { level: "workspace", available: false, reason: NOT_PROBED },
  { level: "workspace-no-network", available: false, reason: NOT_PROBED },
];
