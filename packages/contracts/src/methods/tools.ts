import { z } from "zod";
import { ManagedToolRow } from "../managed-tools.js";
import { defineMethod } from "../method.js";
import { Timestamp } from "../primitives.js";

/**
 * The Managed tools methods (key-managers spec, "Wire methods"; ADR 0026).
 * `tools.list` reads the registry's rows, which the environment probes: at
 * its start, and on a `refresh` (Set up or About opening) at most every
 * fifteen minutes. A client never probes a tool itself.
 */

/**
 * The managed tools' rows, one per tool in the table's order, as the last
 * probe found them. With `refresh`, a probe runs first unless one began in
 * the last fifteen minutes; either way the answer waits for a probe under
 * way.
 */
export const toolsList = defineMethod({
  name: "tools.list",
  scope: "read",
  kind: "query",
  params: z.object({
    refresh: z.boolean().optional().meta({ description: "Probe first, unless a probe began in the last fifteen minutes: sent when Set up or About opens." }),
  }),
  result: z.object({
    tools: z.array(ManagedToolRow).meta({ description: "One row per managed tool, in the table's order." }),
    probedAt: Timestamp.meta({ description: "When the probe the rows come from began." }),
  }),
  errors: [],
});
