import { STEP_STATE_WORDS } from "@agent-harness/client-runtime";
import type { StepState } from "@agent-harness/contracts";
import { classes } from "../ui/classes.js";

/** Each state's fill, a token (ADR 0023): the success colour done, the warning colour needing attention, faint skipped and pending scheduled reads. */
const TONES: { readonly [State in StepState]: string } = { done: "bg-mint", "needs-attention": "bg-amber", skipped: "bg-ink-faint", pending: "bg-ink-faint" };

/**
 * A health dot (ADR 0031; docs/specs/gui.md, "Health dots"): a step's or a
 * row's state as a dot in its colour, named for assistive technology by what
 * it stands for and the state ("Permissions: needs attention"); nothing
 * while there is no state to show.
 */
export const HealthDot = ({ state, of }: { readonly state: StepState | null; readonly of: string }) =>
  state === null ? null : <span role="img" aria-label={`${of}: ${STEP_STATE_WORDS[state]}`} className={classes("size-2 shrink-0 rounded-full", TONES[state])} />;
