import { Check, Circle } from "lucide-react";
import type { ReactNode } from "react";

/**
 * One numbered step of the Browser card (setup-copy.md §5.11), ticking itself:
 * its sentence as a heading, then what the step holds. The tick is status, not
 * an editable checkbox (look.md §12.3), named by its step's number and a word.
 */
export const BrowserSubstep = ({ number, label, complete, aside, children }: {
  readonly number: number;
  readonly label: string;
  readonly complete: boolean;
  /** A word beside the heading, outside its name ("Optional"). */
  readonly aside?: string;
  readonly children?: ReactNode;
}) => <li data-browser-step={number} className="flex min-w-0 flex-col gap-2">
  <div className="flex items-center gap-2">
    <h3 data-browser-substep className="flex min-w-0 flex-1 items-center gap-2 text-xs font-medium text-ink">
      <span aria-hidden="true" className="w-[18px] shrink-0 font-mono text-2xs text-ink-faint">{number}.</span>
      {label}
    </h3>
    {aside !== undefined && <span className="text-2xs text-ink-muted">{aside}</span>}
    <span role="img" aria-label={`Step ${number}: ${complete ? "done" : "not done yet"}`} className="shrink-0">
      {complete ? <Check aria-hidden="true" className="size-4 text-mint" /> : <Circle aria-hidden="true" className="size-4 text-ink-faint" />}
    </span>
  </div>
  {children !== undefined && <div className="flex min-w-0 flex-col gap-2 pl-[26px]">{children}</div>}
</li>;
