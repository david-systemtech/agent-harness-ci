import { Check, Circle } from "lucide-react";

/** Installation progress is status, not an editable checkbox (look.md §12.3). */
export const BrowserSubstep = ({ number, label, complete }: { readonly number: number; readonly label: string; readonly complete: boolean }) => <h3 aria-label={label} data-browser-substep className="flex items-center gap-2 text-xs font-medium text-ink">
  <span className="w-[18px] shrink-0 font-mono text-2xs text-ink-faint">{number}.</span>
  {label}
  <span role="img" aria-label={`${number}. ${label}: ${complete ? "complete" : "pending"}`} className="ml-auto">
    {complete ? <Check aria-hidden="true" className="size-4 text-mint" /> : <Circle aria-hidden="true" className="size-4 text-ink-faint" />}
  </span>
</h3>;
