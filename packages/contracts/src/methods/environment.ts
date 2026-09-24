import { z } from "zod";
import { commandParams, defineMethod, subscriptionParams } from "../method.js";
import { Sequence, Timestamp } from "../primitives.js";

/**
 * Whether the environment is idle, busy or draining, and why. A run parked on
 * a prompt counts as busy until `parkedPromptBusyUntil`. In a container with
 * no launcher, updates are managed outside.
 */
const EnvironmentStatus = z.object({
  state: z.enum(["idle", "busy", "draining"]).meta({
    description:
      "idle: no run starting or running and none started or ended in the last ten minutes; busy otherwise; draining: refusing new runs before a restart.",
  }),
  reason: z.string().nullable().meta({ description: "Why the environment is busy or draining; null when idle." }),
  parkedPromptBusyUntil: Timestamp.nullable().meta({
    description: "When a run parked on a prompt stops counting as busy (ten minutes after it parked); null when none is.",
  }),
  updatesManagedOutside: z.boolean().meta({
    description: "True in a container with no launcher: the environment does not update itself.",
  }),
});

export const environmentStatus = defineMethod({
  name: "environment.status",
  scope: "read",
  params: z.object({}),
  result: EnvironmentStatus,
  errors: [],
  kind: "query",
});

/** Environment-level notices: updated-to, draining, account status. Its snapshot is the status. */
export const environmentSubscribe = defineMethod({
  name: "environment.subscribe",
  scope: "read",
  params: subscriptionParams({}),
  result: z.object({ status: EnvironmentStatus }),
  errors: [],
  kind: "stream",
});

/** Refuse new runs, let running ones finish up to the cap, then say `bye: draining` and exit. */
export const environmentDrain = defineMethod({
  name: "environment.drain",
  scope: "admin",
  params: commandParams({}),
  result: z.object({ drainingSince: Timestamp }),
  errors: [],
  kind: "command",
});

/** Drop the projection tables and replay the log into them. */
export const environmentRebuildProjections = defineMethod({
  name: "environment.rebuildProjections",
  scope: "admin",
  params: commandParams({}),
  result: z.object({ projectors: z.array(z.string().min(1)), sequence: Sequence }),
  errors: [],
  kind: "command",
});
