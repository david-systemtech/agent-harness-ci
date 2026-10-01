import { createContext, use, useEffect } from "react";

/** Holds the checklist's Continue with the line saying why, or lets it go (undefined). */
type Hold = (why: string | undefined) => void;

/**
 * How a step's card holds the checklist's Continue (the Set up
 * specification, "The checklist in the GUI": Continue past Account waits on
 * a signed-in account, which is the Account card's to say; ADR 0018): the
 * step card (`step-card.tsx`) provides it and draws Continue disabled, the
 * line beside it, while a card holds it. Outside a step card nothing holds.
 */
export const ContinueHoldContext = createContext<Hold>(() => undefined);

/** Holds Continue past the card's step while `why` is given, and lets it go once it is not or the card goes. */
export const useHoldContinue = (why: string | undefined): void => {
  const hold = use(ContinueHoldContext);
  useEffect(() => {
    hold(why);
    return () => hold(undefined);
  }, [hold, why]);
};
