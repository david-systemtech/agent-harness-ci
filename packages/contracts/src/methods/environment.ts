import { z } from "zod";
import { DrainStarted, EnvironmentStatus } from "../lifecycle.js";
import { commandParams, defineMethod, subscriptionParams } from "../method.js";
import { Sequence } from "../primitives.js";

/** Readiness, idle or busy with the reason or draining, and whether updates are managed outside. */
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

/**
 * Refuse new runs, let running ones finish up to the cap, then say `bye:
 * draining` and exit. A drain already under way is joined: the answer names
 * when it began and what started it.
 */
export const environmentDrain = defineMethod({
  name: "environment.drain",
  scope: "admin",
  params: commandParams({}),
  result: DrainStarted,
  errors: [],
  kind: "command",
});

/** Drop the projection tables and replay the log into them: which projectors were rebuilt, up to which sequence. */
export const environmentRebuildProjections = defineMethod({
  name: "environment.rebuildProjections",
  scope: "admin",
  params: commandParams({}),
  result: z.object({ projectors: z.array(z.string().min(1)), sequence: Sequence }),
  errors: [],
  kind: "command",
});
