import { z } from "zod";
import { PromptVariant } from "./setup-prompts.js";
import { SetupTarget } from "./setup.js";
import { StepId } from "./steps.js";

/** A minted session's subject, named as the step's action targets name it. */
export const MintedSubject = SetupTarget.omit({ action: true });

/**
 * The session stream's authoring provenance (#891). Kept in its own event
 * so older clients can read session.created and treat this type as opaque
 * (ADR 0001), without extending SessionOrigin's closed union.
 */
export const SetupMintedPayload = z.object({
  step: StepId,
  subject: MintedSubject.nullable().meta({ description: "The subject chosen when minting, or null when the call named none." }),
  variant: PromptVariant,
}).meta({ description: "The LLM step, subject and prompt variant that minted this session." });
export type SetupMintedPayload = z.infer<typeof SetupMintedPayload>;

export const SETUP_SESSION_EVENT_TYPES = {
  "setup.minted": { list: false, payload: SetupMintedPayload },
} as const;
