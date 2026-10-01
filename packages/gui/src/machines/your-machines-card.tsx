import type { StepCardProps } from "../setup/cards.js";
import { FallbackCard } from "../setup/step-card.js";
import { YourMachines } from "./your-machines.js";

/**
 * The Your machines step's card (the Set up specification, "3. Your
 * machines"; ADR 0025; #576): where the step stands, as the fallback card
 * says it (its line, last good result, named actions and home row), then
 * Your machines as its row draws it: a card per machine, this machine's
 * first, and Add a machine.
 */
export const YourMachinesCard = ({ environmentId, step }: StepCardProps) => (
  <>
    <FallbackCard environmentId={environmentId} step={step} />
    <YourMachines />
  </>
);
