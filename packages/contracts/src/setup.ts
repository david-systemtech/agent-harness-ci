import { z } from "zod";
import { Timestamp } from "./primitives.js";
import { REGISTERED_STEP_IDS } from "./steps.js";

/**
 * What a step's health check answers (ADR 0031): run on the environment
 * being checked through `setup.check`, it gives a state, one line naming
 * what failed, the named actions a client offers beside it, and when it
 * ran; a check that timed out or could not check carries the step's last
 * good result beneath it (#308). The `setup` subscription that carries every
 * step's latest result, and the result cache, are the Set up
 * specification's (#88).
 */

/**
 * The fixed vocabulary of named actions a result may offer (ADR 0031): Sign
 * in again, Pull now, Check again, Unpair, Pair another, Install, Update,
 * Reload, Set up this machine, Restore, Move. A step's state checks select
 * their subset (`steps.ts`); a new verb is a contracts change.
 */
export const SETUP_ACTIONS = [
  "sign-in-again",
  "pull-now",
  "check-again",
  "unpair",
  "pair-another",
  "install",
  "update",
  "reload",
  "set-up-this-machine",
  "restore",
  "move",
] as const;
export const SetupAction = z.enum(SETUP_ACTIONS).meta({
  description:
    "A named action a step's result offers, from ADR 0031's fixed vocabulary: sign-in-again, pull-now, check-again, unpair, pair-another, install, update, reload, set-up-this-machine, restore (the Permissions step: the denylist's presets; the Appearance step: the preset theme, written through settings.update), move.",
});
export type SetupAction = z.infer<typeof SetupAction>;

/** The three states a step's check reports (ADR 0031): done and skipped both pass a re-run. */
export const STEP_STATES = ["done", "needs-attention", "skipped"] as const;
export const StepState = z.enum(STEP_STATES).meta({
  description:
    "What a step's check found: done, needs-attention, or skipped (a skippable step whose skip check found nothing set up to check; never a preference step).",
});
export type StepState = z.infer<typeof StepState>;

/**
 * The step's last good result (ADR 0031: a result that passes a re-run,
 * done or skipped), which a result that timed out or could not check
 * carries for the client to show beneath it, dated.
 */
const LastGood = z
  .object({
    state: StepState.extract(["done", "skipped"]).meta({ description: "What the step's last good result found: done, or skipped." }),
    reason: z.string().min(1).meta({ description: "That result's line." }),
    checkedAt: Timestamp.meta({ description: "When that check ran, on the environment's clock." }),
  })
  .meta({
    description:
      "The step's last result that passed, done or skipped, which the client shows beneath a result that timed out or could not check, dated; absent when there has been none since the environment started.",
  });
export type LastGood = z.infer<typeof LastGood>;

export const RegisteredStepId = z.enum(REGISTERED_STEP_IDS).meta({ description: `A step with an entry in the step registry: ${REGISTERED_STEP_IDS.join(", ")}.` });
export type RegisteredStepId = z.infer<typeof RegisteredStepId>;

/** One step's check, as `setup.check` answers it. */
export const StepResult = z
  .object({
    step: RegisteredStepId,
    state: StepState,
    reason: z.string().min(1).meta({
      description: "One line for the step's row: what needs attention, naming each check that failed; when the step is done, what its checks found to hold.",
    }),
    failing: z.array(z.string().min(1)).meta({
      description:
        "The checks that did not hold, in the entry's order: a settings key its value check refused, or a state check's id (permissions.containment, ...); on a result that timed out, the state checks that had not answered; empty when done or skipped.",
    }),
    actions: z.array(SetupAction).meta({
      description: "The actions to offer beside the reason: those of the checks that failed, each once, or check-again alone on a result that timed out; empty when done or skipped.",
    }),
    checkedAt: Timestamp.meta({ description: "When the check ran, on the environment's clock." }),
    lastGood: LastGood.optional(),
  })
  .meta({
    description:
      "A step's health check: its state, one line naming what failed, the checks that failed, the actions to offer, when it ran and, when it timed out or could not check, the last good result beneath it (ADR 0031).",
  });
export type StepResult = z.infer<typeof StepResult>;
