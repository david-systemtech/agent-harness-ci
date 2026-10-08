import { z } from "zod";
import { Timestamp } from "./primitives.js";
import { REGISTERED_STEP_IDS, STEP_ORDER, StepId } from "./steps.js";

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
 * myself, Start over and Revise for an authoring session (ADR 0019), and
 * How to set it up for the host-side updater a container needs (#1883). A
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
  "check-certificate",
  "how-to-set-up",
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
  "check-certificate": "opens the certificate check of each key-manager connection it targets, where a person reviews the certificate it presents and trusts it",
  "how-to-set-up": "shows how to set up what the step needs outside the environment: on Your machines, the host-side updater on the Docker host",
};

export const SetupAction = z.enum(SETUP_ACTIONS).meta({
  description: `A named action a step's result offers, from ADR 0031's fixed vocabulary and the verbs the step decisions added to it: ${SETUP_ACTIONS.map((action) => `${action} (${SETUP_ACTION_MEANINGS[action]})`).join("; ")}.`,
});
export type SetupAction = z.infer<typeof SetupAction>;

const isSetupAction = (action: string): action is SetupAction => (SETUP_ACTIONS as readonly string[]).includes(action);

/**
 * A name spelt as the `known` ones are, lowercase words joined by hyphens,
 * that is none of them: a newer environment's (#693). The pattern is zod's
 * half and the export's alike.
 */
const laterThan = (known: readonly string[]) => z.string().regex(new RegExp(`^(?!(?:${known.join("|")})$)[a-z][a-z0-9-]*$`));

/**
 * A verb a newer environment's vocabulary has and this build's lacks
 * (#693). No protocol version marks an added verb, so a result offering
 * one still reads, and a reader offers it as no action.
 */
const LaterSetupAction = laterThan(SETUP_ACTIONS).meta({ description: "A verb a newer environment offers that the reader's vocabulary lacks: lowercase words joined by hyphens, which the reader offers as no action." });

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

/** A verb as a result offers it: one of this build's vocabulary, or a newer environment's that it lacks. */
const OfferedAction = z.union([SetupAction, LaterSetupAction]);

/**
 * A kind of item a newer environment's actions apply to that this build's
 * list lacks (#693): a target of it still reads, and a reader leaves it out.
 */
const LaterSetupTargetKind = laterThan(SETUP_TARGET_KINDS).meta({ description: "A kind of item a newer environment names that the reader's list lacks: lowercase words joined by hyphens, whose target the reader leaves out." });

/** A target as a result names it: of an action and a kind this build knows, or of a newer environment's verb or kind. */
const OfferedTarget = z
  .object({ ...SetupTarget.shape, action: OfferedAction, kind: z.union([SetupTargetKind, LaterSetupTargetKind]) })
  .meta({
    description:
      "One item a result's action applies to: the action it serves, and the item's kind, id and label. One serving a verb, or of a kind, the reader does not know is a newer environment's, which the reader leaves out.",
  });

const isSetupTarget = (target: z.output<typeof OfferedTarget>): target is SetupTarget => isSetupAction(target.action) && (SETUP_TARGET_KINDS as readonly string[]).includes(target.kind);

/**
 * The states a step's check reports: pending while awaiting a scheduled read (#1326); done and skipped both
 * pass a re-run. Skipped is derived from state and never recorded (the Set
 * up specification, "Skipped"): a skippable step whose skip check fails is
 * skipped until something is set up there.
 */
export const STEP_STATES = ["done", "needs-attention", "skipped", "pending"] as const;
export const StepState = z.enum(STEP_STATES).meta({
  description:
    "What a step's check found: pending (waiting for a scheduled read, neutral and needing no action), done, needs-attention, or skipped (a skippable step whose skip check found nothing set up to check; never a preference step). Skipped is derived from the environment's state each time the step is checked, never recorded: nothing a person does skips a step.",
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

/**
 * A time a result's reason names (#1742): the words of the reason that say
 * when, in the environment's own terms (to the minute, in UTC), and the
 * instant, which a client words as it words every past time, where it is,
 * in place of those words.
 */
const ReasonTime = z
  .object({
    text: z.string().min(1).meta({ description: "The words of the reason that say when, which a client replaces with its own words for the time." }),
    at: Timestamp.meta({ description: "The instant those words name." }),
  })
  .meta({ description: "A past time the reason names: the words that say it and the instant, which a client words where it is, its age and its clock time, in place of those words." });
export type ReasonTime = z.infer<typeof ReasonTime>;

/** How many lines of details a result carries at most (setup-copy.md §3, "Details and Copy details"). */
export const STEP_RESULT_DETAILS_MAX = 20;

export const RegisteredStepId = z.enum(REGISTERED_STEP_IDS).meta({ description: `A step with an entry in the step registry: ${REGISTERED_STEP_IDS.join(", ")}.` });
export type RegisteredStepId = z.infer<typeof RegisteredStepId>;

/**
 * One step's check as an environment gives it. It names any step of the
 * milestone-1 order, not only the ones this build registers (#672): each
 * entry that lands grows the registry, so an environment built after one
 * answers for a step an older client's registry lacks, and that client
 * reads the answer, the snapshot and the notice whole, the step drawn with
 * the label and home row every client knows it by. Asking about a step
 * (`setup.check`'s `step`) stays limited to the registered ones. Its
 * actions and targets may be in a newer environment's vocabulary (#693),
 * which `readable` narrows to this build's.
 */
const GivenResult = z.object({
  step: StepId.meta({
    description:
      "The step checked: any step of the milestone-1 order, so a client reads a result of a step a newer environment registers and its own build does not.",
  }),
  state: StepState,
  reason: z.string().min(1).meta({
    description:
      "One plain line for the step's row: what needs attention, each check that failed in its own sentence; when the step is done, what its checks found to hold. It holds no check id, settings key, error code or exact time: those are in failing and details.",
  }),
  failing: z.array(z.string().min(1)).meta({
    description:
      "The checks that did not hold, in the entry's order: a settings key its value check refused, or a state check's id (permissions.containment, ...); on a result that timed out, the state checks that had not answered; empty when pending, done or skipped.",
  }),
  actions: z.array(OfferedAction).meta({
    description:
      "The actions to offer beside the reason: those of the checks that failed, each once (check-again for a check that could not finish, and only those a failure offers of the ones its check declares), after try-again, write-it-myself and start-over when an LLM step's latest minted session last ended with an error or was stopped, or check-again alone on a result that timed out; revise alone on a done LLM step; empty when pending, skipped or done otherwise. The reader leaves out a verb it does not know, and one whose every target it leaves out.",
  }),
  targets: z
    .array(OfferedTarget)
    .optional()
    .meta({
      description:
        "The items the actions apply to, each with the action it serves, as the checks that failed named them, in the entry's order and each once, after the session try-again continues when an LLM step's minted session stopped; on a done LLM step, each of its subjects for revise; absent when none is named. The reader leaves out one of a verb or a kind it does not know.",
    }),
  times: z
    .array(ReasonTime)
    .optional()
    .meta({
      description:
        "The past times the reason names, each with the words that say it, which a client replaces with its own words for that time; absent when it names none. A client that reads none shows the reason as it is.",
    }),
  details: z
    .array(z.string().min(1).regex(/^[^\r\n]*$/))
    .max(STEP_RESULT_DETAILS_MAX)
    .optional()
    .meta({
      description: `The raw facts behind the reason, which a client shows under Details and copies with Copy details, never in the line itself (setup-copy.md §3): check ids with the errors they threw, settings keys, addresses, versions and exact times, each one line, at most ${STEP_RESULT_DETAILS_MAX}; absent when there are none. A reader built before details passes over them and shows the reason as it is.`,
    }),
  checkedAt: Timestamp.meta({ description: "When the check ran, on the environment's clock." }),
  lastGood: LastGood.optional(),
});

/**
 * A result as this build reads it (#693): no protocol version marks a verb
 * or a kind added to the vocabulary, so a newer environment's result is
 * read, never refused, and what this build cannot act on is left out. That
 * is a verb it does not know, a target of such a verb or of a kind it does
 * not know, and a verb it knows whose every target it left out: carried out
 * on no item, it would act on another (Update naming no tool updates this
 * machine). The targets are absent once none is left, as when no check
 * named one.
 */
const readable = ({ targets: given, ...result }: z.output<typeof GivenResult>) => {
  const targets = given?.filter(isSetupTarget) ?? [];
  const placed = (action: SetupAction) => targets.some((target) => target.action === action) || !given?.some((target) => target.action === action);
  return { ...result, actions: result.actions.filter(isSetupAction).filter(placed), ...(targets.length > 0 && { targets }) };
};

/** One step's check, as `setup.check` answers it and this build reads it. */
export const StepResult = GivenResult.transform(readable).meta({
  description:
    "A step's health check: its state, one plain line saying what failed, the raw facts behind it as details, the checks that failed, the actions to offer and the items they apply to, when it ran and, when it timed out or could not check, the last good result beneath it (ADR 0031). A verb or a kind of item the reader does not know is a newer environment's: the reader leaves out that action or target, and an action whose every target it leaves out, and reads the rest.",
});
export type StepResult = z.infer<typeof StepResult>;

/**
 * A step past the milestone-1 order (#693): a later milestone adds steps
 * with no protocol bump, and a result of one has no row in this build's
 * checklist.
 */
const LaterStepId = laterThan(STEP_ORDER).meta({ description: "A step past the milestone-1 order, a later milestone's: lowercase words joined by hyphens, which the reader has no row for." });

/** A result of a step past the order: passed over whatever else it holds, since this build has no row to show it on. */
const LaterStepResult = z
  .looseObject({ step: LaterStepId })
  .transform(() => null)
  .meta({ description: "A result of a step past the milestone-1 order, a later milestone's: the reader has no row for it and passes over it." });

/**
 * The results `setup.check` answers and the snapshot carries, as this build
 * reads them (#693): one of a step past the milestone-1 order is passed
 * over and the rest read, so a later milestone's step costs an older client
 * that step alone. A notice carries one result, so a notice of such a step
 * is one this build does not know.
 */
export const StepResults = z.array(z.union([StepResult, LaterStepResult])).transform((results) => results.filter((result) => result !== null));
