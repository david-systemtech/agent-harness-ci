import { z } from "zod";
import { EnvironmentReadiness } from "../discovery.js";
import { commandParams, defineMethod, subscriptionParams } from "../method.js";
import { Sequence, Timestamp } from "../primitives.js";

/**
 * The environment's state as `environment.status` answers it and
 * `environment.subscribe` snapshots it: for now its readiness. The lifecycle
 * ticket (#112) extends it with idle, busy or draining, the reason, when a
 * parked prompt stops counting as busy, and whether updates are managed
 * outside (a container with no launcher).
 */
const EnvironmentStatus = z.object({ readiness: EnvironmentReadiness });

export const environmentStatus = defineMethod({
  name: "environment.status",
  scope: "read",
  params: z.object({}),
  result: EnvironmentStatus,
  errors: [],
  kind: "query",
});

/**
 * The environment's notices (`EnvironmentNotice`, the `environment` stream):
 * started, updated-to and draining now, account status from a later ticket.
 * Its snapshot, sent when replay from the cursor is out of bounds, is the status.
 */
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
