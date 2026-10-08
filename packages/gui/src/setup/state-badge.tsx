import { CircleAlert, CircleCheck, CircleDashed, CircleMinus, CircleSlash, LoaderCircle, type LucideIcon } from "lucide-react";
import { classes } from "../ui/classes.js";
import { HealthDot, STATE_WORDS, type SetupState } from "./health-dot.js";

const ICONS: { readonly [State in SetupState]: readonly [LucideIcon, string] } = {
  done: [CircleCheck, "text-mint"], "needs-attention": [CircleAlert, "text-amber"], skipped: [CircleMinus, "text-ink-faint"],
  pending: [LoaderCircle, "text-ink-faint"], unchecked: [CircleDashed, "text-ink-faint"], unavailable: [CircleSlash, "text-ink-faint"],
};

/**
 * A step's state as a word as well as a colour (setup-copy.md §1 rule 15, §3):
 * the health dot, an icon and the word, which is what assistive technology reads.
 */
export const StateBadge = ({ state, className }: { readonly state: SetupState; readonly className?: string }) => {
  const [Icon, ink] = ICONS[state];
  return (
    <span data-state-badge={state} className={classes("inline-flex shrink-0 items-center gap-1 text-xs whitespace-nowrap text-ink-muted", className)}>
      <HealthDot state={state} />
      <Icon aria-hidden="true" className={classes("size-3.5 shrink-0", ink)} />
      <span data-state-word>{STATE_WORDS[state]}</span>
    </span>
  );
};
