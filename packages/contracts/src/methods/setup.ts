import { z } from "zod";
import { defineMethod } from "../method.js";
import { RegisteredStepId, StepResult } from "../setup.js";

/**
 * `setup.check` (ADR 0031): runs a step's health check on this environment
 * now, or every registered step's, and answers the results. A check reads
 * and never writes the state it checks, so this is a query under `read`.
 * The `setup` subscription that carries the latest results, and the result
 * cache it reads, are the Set up specification's (#88).
 */
export const setupCheck = defineMethod({
  name: "setup.check",
  scope: "read",
  kind: "query",
  params: z.object({
    step: RegisteredStepId.optional().meta({ description: "The step to check; every registered step when absent." }),
  }),
  result: z.object({
    results: z.array(StepResult).meta({ description: "The step's result, or every registered step's in the milestone-1 order." }),
  }),
  errors: [],
});
