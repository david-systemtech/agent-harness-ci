import type { StepId } from "@agent-harness/contracts";
import { createContext, use, useState, type ReactNode } from "react";
import { Fold } from "../ui/index.js";

/** Which steps' More options are open, for the window's life: a step's card unmounts when another is chosen. */
const openSteps = new Set<StepId>();

const InsideMoreOptions = createContext(false);

export interface MoreOptionsProps {
  readonly step: StepId;
  /** The fold's name, "More options" unless the step names it ("More safety settings"). */
  readonly label?: string;
  readonly children: ReactNode;
}

/**
 * A step's one fold for what most people never change (setup-copy.md §1 rule
 * 5): shut until chosen, then open whenever the step shows again in this
 * window. Never two levels deep: one inside another draws its contents in place.
 */
export const MoreOptions = ({ step, label = "More options", children }: MoreOptionsProps) => {
  const nested = use(InsideMoreOptions);
  const [open, setOpen] = useState(() => openSteps.has(step));
  if (nested) return children;
  const change = (next: boolean) => {
    if (next) openSteps.add(step); else openSteps.delete(step);
    setOpen(next);
  };
  return (
    <Fold summary={label} open={open} onOpenChange={change}>
      <InsideMoreOptions value={true}><div className="flex min-w-0 flex-col gap-3 pt-1">{children}</div></InsideMoreOptions>
    </Fold>
  );
};
