import { STEP_ORDER, type StepId } from "@agent-harness/contracts";
import { useState } from "react";
import { Fold } from "../ui/index.js";

export interface StepIntroProps {
  readonly step: StepId;
  /** The step's question or purpose, the card's heading. */
  readonly title: string;
  /** One line saying why. */
  readonly why: string;
  /** The "What is this?" sentence of setup-copy.md §2 for the step, where it has one. */
  readonly what?: string;
  /** The heading's id, for the card that is labelled by it. */
  readonly headingId?: string;
}

/**
 * The head of a step page (setup-copy.md §1 rule 4, §3; look.md §13): "Step
 * {n} of 11", small and muted, above the title; the why line; and the "What is
 * this?" fold.
 */
export const StepIntro = ({ step, title, why, what, headingId }: StepIntroProps) => {
  const [open, setOpen] = useState(false);
  return (
    <header data-step-intro className="flex min-w-0 flex-col gap-1">
      <p className="text-[11px] leading-4 text-ink-muted">Step {STEP_ORDER.indexOf(step) + 1} of {STEP_ORDER.length}</p>
      <h2 id={headingId} className="text-xl leading-7 font-semibold text-ink">{title}</h2>
      <p className="max-w-[56ch] text-sm text-ink-muted">{why}</p>
      {what !== undefined && <Fold summary="What is this?" open={open} onOpenChange={setOpen}><p className="max-w-[56ch] text-sm text-ink">{what}</p></Fold>}
    </header>
  );
};
