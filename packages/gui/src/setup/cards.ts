import type { SetupStepView } from "@agent-harness/client-runtime";
import type { StepId } from "@agent-harness/contracts";
import { createContext, use, type ComponentType } from "react";
import { AccountStepCard } from "../accounts/account-step-card.js";
import { MemoryBankCard } from "../banks/memory-bank-card.js";
import { BrowserCard } from "../browser/browser-card.js";
import { AppearanceCard } from "../appearance/appearance-card.js";
import { CarryOverCard } from "../carry-over/carry-over-card.js";
import { ForgesCard } from "../forges/forges-card.js";
import { KeyManagerCard } from "../key-managers/key-manager-card.js";
import { YourMachinesCard } from "../machines/your-machines-card.js";
import { InstructionsCard } from "../instructions/instructions-card.js";
import { SkillsCard } from "../skills/skills-card.js";
import { PermissionsCard } from "../permissions/permissions-card.js";

/**
 * The step cards of the full checklist, registered by step id (the Set up
 * specification, "Cards"; docs/specs/gui.md, "Set up in the window"; #573):
 * each card ticket adds its step's here, and a step with none keeps the
 * fallback card (`step-card.tsx`), its line, named actions, Check now and
 * home row. A card is drawn under the step's head (`StepIntro`), above the
 * checklist's Continue, Skip for now and Finish, which are the checklist's;
 * the verbs a result offers that are the card's to carry out (`CardAction`:
 * the authoring and import verbs) are bound by the card, and until a step
 * has one they open its home row.
 */

/** What a registered card is given: the environment the checklist checks, and the step as `projections.setup` has it there. */
export interface StepCardProps {
  readonly environmentId: string;
  readonly step: SetupStepView;
}

export type StepCards = Readonly<Partial<Record<StepId, ComponentType<StepCardProps>>>>;

/** The cards this build registers, each step's arriving with its card ticket: Your machines (#576), Permissions and Appearance (#594). */
export const STEP_CARDS: StepCards = {
  account: AccountStepCard,
  "carry-over": CarryOverCard,
  "your-machines": YourMachinesCard,
  forges: ForgesCard,
  "key-manager": KeyManagerCard,
  "memory-bank": MemoryBankCard,
  instructions: InstructionsCard,
  skills: SkillsCard,
  browser: BrowserCard,
  permissions: PermissionsCard,
  appearance: AppearanceCard,
};

/** The cards the window draws: this build's, or a test's (`renderApp`'s `stepCards`). */
export const StepCardsContext = createContext<StepCards>(STEP_CARDS);

/** The card registered for `step`; undefined for a step that keeps the fallback. */
export const useRegisteredCard = (step: StepId): ComponentType<StepCardProps> | undefined => use(StepCardsContext)[step];
