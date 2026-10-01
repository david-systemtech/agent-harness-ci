import { z } from "zod";

/**
 * The prompts of the LLM steps (ADR 0019; the Set up specification, "The
 * LLM step and minted sessions"; #584). An LLM step is a step whose
 * artefact has to be authored rather than filled in: it names its prompt
 * in the registry's `llm`, and `setup.mint` starts a minted session with
 * it. A prompt has two variants, `first`, which authors the artefact, and
 * `revise`, which revises the one there. The environment renders it from
 * live facts (a bank's name, kind, entities, scope folders and orientation
 * caps), which the prompt parses before it renders, and it carries the
 * name and version of the validator the artefact must satisfy, so the
 * prompt and the validator it was written for ship together, never fetched
 * apart from it.
 */

export const PROMPT_VARIANTS = ["first", "revise"] as const;
export const PromptVariant = z.enum(PROMPT_VARIANTS).meta({
  description: "Which of an LLM step's prompts a minted session starts with: first, which authors the step's artefact, or revise, which revises the one there.",
});
export type PromptVariant = z.infer<typeof PromptVariant>;

/** The validator an LLM step's artefact must satisfy, by name and version: a prompt is written for one version of it. */
export interface PromptValidator {
  readonly name: string;
  readonly version: number;
}

/** A prompt rendered for a minted session: which prompt and variant, its text, and the validator its artefact must satisfy. */
export interface RenderedPrompt {
  readonly prompt: string;
  readonly variant: PromptVariant;
  readonly text: string;
  readonly validator: PromptValidator;
}

/** One LLM step's prompt, as the environment renders it: by its id, from facts it parses itself. */
export interface StepPrompt {
  /** What a step's `llm` names it by. */
  readonly id: string;
  readonly validator: PromptValidator;
  /** Facts it renders from, for the contract test. */
  readonly example: unknown;
  /** Renders `variant` from `facts`; throws when the facts are not the ones it renders from. */
  render(variant: PromptVariant, facts: unknown): RenderedPrompt;
}

/** What a prompt is written as: its id and validator, the facts it renders from, each variant over them, and an example of them. */
export interface StepPromptDefinition<Facts> {
  readonly id: string;
  readonly validator: PromptValidator;
  readonly facts: z.ZodType<Facts>;
  readonly first: (facts: Facts) => string;
  readonly revise: (facts: Facts) => string;
  readonly example: NoInfer<Facts>;
}

/** A step's prompt from its definition: rendering parses the facts it is given before either variant reads them. */
export const stepPrompt = <Facts>(definition: StepPromptDefinition<Facts>): StepPrompt => ({
  id: definition.id,
  validator: definition.validator,
  example: definition.example,
  render: (variant, facts) => ({
    prompt: definition.id,
    variant,
    text: definition[variant](definition.facts.parse(facts)),
    validator: definition.validator,
  }),
});

/**
 * Every LLM step's prompt, by the id its entry's `llm` names. None yet: in
 * milestone 1 the only LLM step is the Memory bank's, whose describe
 * prompt arrives with its entry (#586).
 */
export const STEP_PROMPTS: readonly StepPrompt[] = [];
