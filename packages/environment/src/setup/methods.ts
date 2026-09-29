import type { MethodHandlers } from "../serve/methods.js";
import type { SetupService } from "./service.js";

/**
 * `setup.check` (ADR 0031; #141, #308, #569): the SetupService's check of
 * one registered step, or of every one, answered in the registry's order
 * once each has answered or run out of its budget, each result kept in the
 * result cache before the answer goes out. A `read` query: it writes
 * nothing a check checks, and appends nothing but the `setup.result-changed`
 * of a result that changed, which Set up appends (`service.ts`).
 */
export const setupMethods = (setup: SetupService): Required<Pick<MethodHandlers, "setup.check">> => ({
  "setup.check": async ({ step }) => ({ results: await setup.check(step) }),
});
