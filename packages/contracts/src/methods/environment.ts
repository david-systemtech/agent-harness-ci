import { z } from "zod";
import { EnvironmentColour } from "../environment-colours.js";
import { EnvironmentIcon, EnvironmentLook, EnvironmentName } from "../environment-look.js";
import { KNOWN_ENVIRONMENTS_MAX, KnownEnvironment } from "../known-environments.js";
import { DrainStarted, EnvironmentStatus } from "../lifecycle.js";
import { commandParams, defineMethod, subscriptionParams } from "../method.js";
import { Sequence } from "../primitives.js";
import { StateImportFailure } from "../state-import.js";
import { StepResults } from "../setup.js";

/** Readiness, idle or busy with the reason or draining, whether updates are managed outside, and what the environment binds and could bind. */
export const environmentStatus = defineMethod({
  name: "environment.status",
  scope: "read",
  params: z.object({}),
  result: EnvironmentStatus,
  errors: [],
  kind: "query",
});

/**
 * The environment's notices (`EnvironmentNotice`, the `environment` stream).
 * Its snapshot, sent when replay from the cursor is out of bounds, is the
 * status, the environment's name, icon and colour (#323), the last completed
 * import's failed items (#1935), and every Set up
 * step's cached result (#569: ADR 0031's `setup` subscription, whose changes
 * are the `setup.result-changed` notices); an environment from before the
 * look leaves the look out, and one without the `setup` flag the results.
 */
export const environmentSubscribe = defineMethod({
  name: "environment.subscribe",
  scope: "read",
  params: subscriptionParams({}),
  result: z.object({
    status: EnvironmentStatus,
    environment: EnvironmentLook.optional().meta({
      description: "The environment's name, icon and colour as of the snapshot; absent from an environment that predates them.",
    }),
    stateImportFailures: z.array(StateImportFailure).optional().meta({
      description: "The last completed state import's failed items, each with its fix; empty before any import or after a successful one. Absent from an environment that predates this field. A preview leaves them unchanged.",
    }),
    setup: StepResults.optional().meta({
      description:
        "Every registered Set up step's latest result, as the environment's result cache holds it, in the step registry's order, each with when it was checked; a step never checked is absent. Absent from an environment without the setup flag. The reader passes over a result of a step past the milestone-1 order, a later milestone's, and reads the rest.",
    }),
  }),
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

/**
 * The three commands that set what every client draws an environment's
 * badge from (workspace-picker spec, "Name, icon and colour"), one per field
 * as for sessions (ADR 0003), each appending its notice on the environment
 * stream and answering the look as it now is. A value already held appends
 * nothing: accepted, `changed: false`.
 */
export const environmentRename = defineMethod({
  name: "environment.rename",
  scope: "admin",
  params: commandParams({ name: EnvironmentName }),
  result: EnvironmentLook,
  errors: [],
  kind: "command",
});

export const environmentSetIcon = defineMethod({
  name: "environment.setIcon",
  scope: "admin",
  params: commandParams({ icon: EnvironmentIcon }),
  result: EnvironmentLook,
  errors: [],
  kind: "command",
});

export const environmentSetColour = defineMethod({
  name: "environment.setColour",
  scope: "admin",
  params: commandParams({ colour: EnvironmentColour }),
  result: EnvironmentLook,
  errors: [],
  kind: "command",
});

/**
 * A desktop's or terminal UI's other connections, each its environment's id,
 * name and the address the client uses (key-managers spec, "The orientation
 * block"; #382). The report is whole: it replaces this client session's last,
 * and is dropped when the client session is revoked or expires. The union of
 * the reports, this environment left out, is the orientation block's other
 * environments section; a change to it raises
 * `environment.known-environments-updated`, and a report that changes nothing
 * raises none. A program client session is refused `forbidden` with the
 * reason `program`, so no program puts text into every run.
 */
export const environmentKnownEnvironmentsReport = defineMethod({
  name: "environment.knownEnvironments.report",
  scope: "read",
  params: z.object({
    environments: z.array(KnownEnvironment).max(KNOWN_ENVIRONMENTS_MAX).meta({
      description: `The client's other connections, at most ${KNOWN_ENVIRONMENTS_MAX}: every one it holds but this environment's, in any order.`,
    }),
  }),
  result: z.object({}),
  errors: [],
  kind: "query",
});
