import { z } from "zod";
import { Timestamp } from "./primitives.js";
import { REGISTERED_STEP_IDS } from "./steps.js";

/**
 * What a step's health check answers (ADR 0031): run on the environment
 * being checked through `setup.check`, it gives a state, one line naming
 * what failed, the named actions a client offers beside it, and when it
 * ran; a check that timed out or could not check carries the step's last
 * good result beneath it (#308). The environment keeps each step's latest
 * result in its result cache, which `environment.subscribe`'s snapshot
 * carries as `setup` and each change of which is the notice
 * `setup.result-changed`: ADR 0031's `setup` subscription (#569).
 */

/**
 * The fixed vocabulary of named actions a result may offer (ADR 0031): Sign
 * in again, Pull now, Check again, Unpair, Pair another, Install, Update,
 * Reload, Set up this machine, Restore, Move, and the verbs the step
 * decisions named beside them (the Set up specification, "Actions"): Start
 * the service (ADR 0025), Import again (ADR 0021), and Try again, Write it
 * myself, Start over and Revise for an authoring session (ADR 0019). A
 * step's state checks select their subset (`steps.ts`); a new verb is a
 * contracts change.
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
  "start-service",
  "import-again",
  "try-again",
  "write-it-myself",
  "start-over",
  "revise",
] as const;

/** What a client does for each action (the Set up specification, "Actions"), the items it applies to being the result's targets that name it. */
const SETUP_ACTION_MEANINGS: { readonly [Action in (typeof SETUP_ACTIONS)[number]]: string } = {
  "sign-in-again": "opens the sign-in of each account, forge account or key-manager connection it targets",
  "pull-now": "pulls the skill sources it targets now",
  "check-again": "runs the step's check again through setup.check",
  unpair: "unpairs the Chrome it targets",
  "pair-another": "pairs another Chrome",
  install: "installs the tool it targets",
  update: "updates the tool it targets, or this machine",
  reload: "shows how to reload the extension in the Chrome it targets",
  "set-up-this-machine": "switches the checklist to the environment it targets",
  restore:
    "runs the step's restore method: the Permissions step's puts the denylist's missing presets back, and the Appearance step's writes the preset theme back through settings.update",
  move: "opens the Move card, which moves stored tokens into a key manager",
  "start-service": "starts the local environment's service when it is down",
  "import-again": "runs the step's import again, for real rather than as a dry run, after one that failed part way",
  "try-again": "continues the authoring session it targets where its run stopped",
  "write-it-myself": "opens the step's artefact to write by hand: the bank's checkout, or the Instructions editor",
  "start-over": "starts a new authoring session for the step, the old one staying",
  revise: "starts an authoring session that revises the step's artefact",
};

export const SetupAction = z.enum(SETUP_ACTIONS).meta({
  description: `A named action a step's result offers, from ADR 0031's fixed vocabulary and the verbs the step decisions added to it: ${SETUP_ACTIONS.map((action) => `${action} (${SETUP_ACTION_MEANINGS[action]})`).join("; ")}.`,
});
export type SetupAction = z.infer<typeof SetupAction>;

/**
 * The kinds of item a result's actions apply to: Sign in again opens that
 * account's sign-in, Pull now pulls those sources, Try again continues that
 * session.
 */
export const SETUP_TARGET_KINDS = [
  "account",
  "forge-account",
  "key-manager-connection",
  "tool",
  "skill-source",
  "chrome",
  "session",
  "bank",
  "denylist-section",
  "environment",
] as const;
export const SetupTargetKind = z.enum(SETUP_TARGET_KINDS).meta({
  description:
    "The kind of item a result's action applies to: account (a provider account), forge-account, key-manager-connection, tool (a managed tool), skill-source, chrome (a paired Chrome), session (an authoring session), bank (a memory bank), denylist-section, or environment.",
});
export type SetupTargetKind = z.infer<typeof SetupTargetKind>;

/**
 * One item a result's action applies to, as a failing state check named it:
 * the action it serves, and the item's kind, id and label.
 */
export const SetupTarget = z
  .object({
    action: SetupAction,
    kind: SetupTargetKind,
    id: z.string().min(1).meta({ description: "The item's id, as the methods behind its action name it: an account's id, a forge account's origin, a denylist section's name, a session's id." }),
    label: z.string().min(1).meta({ description: "The item as a person reads it, for the client to name beside the action." }),
  })
  .meta({
    description:
      "One item a result's action applies to: the action it serves, and the item's kind, id and label (Sign in again opens that account's sign-in, Pull now pulls that source, Try again continues that session).",
  });
export type SetupTarget = z.infer<typeof SetupTarget>;

/**
 * The three states a step's check reports (ADR 0031): done and skipped both
 * pass a re-run. Skipped is derived from state and never recorded (the Set
 * up specification, "Skipped"): a skippable step whose skip check fails is
 * skipped until something is set up there.
 */
export const STEP_STATES = ["done", "needs-attention", "skipped"] as const;
export const StepState = z.enum(STEP_STATES).meta({
  description:
    "What a step's check found: done, needs-attention, or skipped (a skippable step whose skip check found nothing set up to check; never a preference step). Skipped is derived from the environment's state each time the step is checked, never recorded: nothing a person does skips a step.",
});
export type StepState = z.infer<typeof StepState>;

/**
 * The step's last good result (ADR 0031: a result that passes a re-run,
 * done or skipped), which a result that timed out or could not check
 * carries for the client to show beneath it, dated. The environment reads it
 * from its result cache (#571), so it survives a restart.
 */
const LastGood = z
  .object({
    state: StepState.extract(["done", "skipped"]).meta({ description: "What the step's last good result found: done, or skipped." }),
    reason: z.string().min(1).meta({ description: "That result's line." }),
    checkedAt: Timestamp.meta({ description: "When that check ran, on the environment's clock." }),
  })
  .meta({
    description:
      "The step's last result that passed, done or skipped, which the client shows beneath a result that timed out or could not check, dated: the step's cached result when that passed, else the last good result the cached one carried, so it survives a restart; absent when there is neither.",
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
    targets: z
      .array(SetupTarget)
      .optional()
      .meta({
        description:
          "The items the actions apply to, each with the action it serves, as the checks that failed named them, in the entry's order and each once; absent when no check that failed named one.",
      }),
    checkedAt: Timestamp.meta({ description: "When the check ran, on the environment's clock." }),
    lastGood: LastGood.optional(),
  })
  .meta({
    description:
      "A step's health check: its state, one line naming what failed, the checks that failed, the actions to offer and the items they apply to, when it ran and, when it timed out or could not check, the last good result beneath it (ADR 0031).",
  });
export type StepResult = z.infer<typeof StepResult>;
