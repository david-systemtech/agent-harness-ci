import { z } from "zod";
import { commandParams, defineMethod } from "../method.js";
import { SessionId } from "../sessions.js";
import { RegisteredStepId, StepResults } from "../setup.js";
import { PromptVariant } from "../setup-prompts.js";

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

/**
 * `setup.mint` (ADR 0019; the Set up specification, "The LLM step and
 * minted sessions"; #584): mints a session for an LLM step, whose artefact
 * has to be authored, and answers its id. The session is created as
 * `sessions.create` creates one, in the workspace the step names (a
 * scratch workspace unless it names another), tagged `setup` and the
 * step's id and titled "Set up: <step> (<subject>)"; its account, model and
 * effort are the call's, else the environment's defaults. Its first run
 * starts with the step's prompt in the variant asked for, rendered from
 * live facts, under the caller's ceiling in the environment's default
 * mode; when no account or model resolves, the prompt is the session's
 * draft and no run starts. A subject the step does not have is
 * `not_found`; a step that names no prompt is `conflict` (reason
 * `no_llm_step`). The Memory bank step's session works in a worktree of
 * its bank on a branch `setup/describe-<date>`; a call naming no bank, or a
 * bank whose checkout is not there, is `conflict` (reason `bank_missing`,
 * #586). A prepared command: the workspace is made first, outside the
 * transaction. Every run end of the session checks the step again.
 */
export const setupMint = defineMethod({
  name: "setup.mint",
  scope: "admin",
  kind: "command",
  params: commandParams({
    step: RegisteredStepId.meta({ description: "The LLM step to mint a session for." }),
    subject: z.string().min(1).optional().meta({ description: "What the artefact is for, as the step names it: a bank's id for the Memory bank step; none when absent." }),
    variant: PromptVariant,
    account: z.string().min(1).optional().meta({ description: "The account the session's runs use; the environment's default account when absent." }),
    model: z.string().min(1).optional().meta({ description: "The model the session's runs use, one the account offers; the strongest of the default model family when absent." }),
    effort: z.string().min(1).optional().meta({ description: "The reasoning effort of the first run; the default effort when absent and the model takes it." }),
  }),
  result: z.object({ sessionId: SessionId.meta({ description: "The minted session: running its first run, or holding the prompt as its draft." }) }),
  errors: [],
});
