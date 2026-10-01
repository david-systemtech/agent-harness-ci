import type { StepCardProps } from "../setup/cards.js";
import { StepStatus } from "../setup/step-status.js";
import { YourMachines } from "./your-machines.js";

/**
 * The Your machines step's card (the Set up specification, "3. Your
 * machines"; ADR 0025; #576): where the step stands (`StepStatus`: its line,
 * last good result, named actions and home row), then Your machines as its
 * row draws it: a card per machine, this machine's first, and Add a machine.
 */
export const YourMachinesCard = ({ environmentId, step }: StepCardProps) => (
  <>
    <StepStatus environmentId={environmentId} step={step} />
    <YourMachines />
  </>
);
