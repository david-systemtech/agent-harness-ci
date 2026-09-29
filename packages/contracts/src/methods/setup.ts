import { z } from "zod";
import { defineMethod } from "../method.js";
import { RegisteredStepId, StepResults } from "../setup.js";

/**
 * `setup.check` (ADR 0031): runs a step's health check on this environment
 * now, or every registered step's at once, and answers the results once
 * each has answered or its step's budget has run out (#308). A check reads
 * and never writes the state it checks, so this is a query under `read`.
 * Each result is kept in the environment's result cache before the answer
 * goes out, and one that changed is the notice `setup.result-changed` on
 * the environment stream, which Set up appends (#569).
 */
export const setupCheck = defineMethod({
  name: "setup.check",
  scope: "read",
  kind: "query",
  params: z.object({
    step: RegisteredStepId.optional().meta({ description: "The step to check; every registered step when absent." }),
  }),
  result: z.object({
    results: StepResults.meta({
      description:
        "The step's result, or every registered step's in the milestone-1 order. The reader passes over a result of a step past that order, a later milestone's, and reads the rest.",
    }),
  }),
  errors: [],
});
