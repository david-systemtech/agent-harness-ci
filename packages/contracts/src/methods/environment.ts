import { z } from "zod";
import { commandParams, defineMethod, subscriptionParams } from "../method.js";
import { Sequence, Timestamp } from "../primitives.js";

/**
 * Whether the environment is idle, busy or draining, and why. A run parked on
 * a prompt counts as busy until `parkedPromptBusyUntil`. In a container with
 * no launcher, updates are managed outside.
 */
const EnvironmentStatus = z.object({
  state: z.enum(["idle", "busy", "draining"]),
  reason: z.string().nullable(),
  parkedPromptBusyUntil: Timestamp.nullable(),
  updatesManagedOutside: z.boolean(),
});

export const environmentStatus = defineMethod({
  name: "environment.status",
  scope: "read",
  params: z.object({}),
  result: EnvironmentStatus,
  errors: [],
  stream: false,
  mutating: false,
});

/** Environment-level notices: updated-to, draining, account status. Its snapshot is the status. */
export const environmentSubscribe = defineMethod({
  name: "environment.subscribe",
  scope: "read",
  params: subscriptionParams({}),
  result: z.object({ status: EnvironmentStatus }),
  errors: [],
  stream: true,
  mutating: false,
});

/** Refuse new runs, let running ones finish up to the cap, then say `bye: draining` and exit. */
export const environmentDrain = defineMethod({
  name: "environment.drain",
  scope: "admin",
  params: commandParams({}),
  result: z.object({ drainingSince: Timestamp }),
  errors: [],
  stream: false,
  mutating: true,
});

/** Drop the projection tables and replay the log into them. */
export const environmentRebuildProjections = defineMethod({
  name: "environment.rebuildProjections",
  scope: "admin",
  params: commandParams({}),
  result: z.object({ projectors: z.array(z.string().min(1)), sequence: Sequence }),
  errors: [],
  stream: false,
  mutating: true,
});
