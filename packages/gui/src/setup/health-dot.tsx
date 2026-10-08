import type { StepState } from "@agent-harness/contracts";
import { classes } from "../ui/classes.js";

/**
 * What Set up draws a step as: its state on the wire, or one a client sees
 * for itself, "unchecked" with no result yet and "unavailable" for a step the
 * computer's version does not have (look.md §13).
 */
export type SetupState = StepState | "unchecked" | "unavailable";

/** Every state as a word (setup-copy.md §1 rule 15 and §3), the same on the dot, the badge and Copy details. */
export const STATE_WORDS: { readonly [State in SetupState]: string } = {
  done: "Done", "needs-attention": "Needs a fix", skipped: "Not set up", pending: "Checking", unchecked: "Not checked yet", unavailable: "Not available",
};

/** Each state's fill, a token (ADR 0023): the success colour done, the warning colour needing a fix, faint otherwise. */
const TONES: { readonly [State in SetupState]: string } = {
  done: "bg-mint", "needs-attention": "bg-amber", skipped: "bg-ink-faint", pending: "bg-ink-faint", unchecked: "bg-ink-faint", unavailable: "bg-ink-faint",
};

/**
 * A health dot (ADR 0031; docs/specs/gui.md, "Health dots"): a step's or a
 * row's state as a dot in its colour, named for assistive technology by what
 * it stands for and the state's word ("Permissions: Needs a fix"); with no
 * `of` it is decoration beside words that say the state; nothing while there
 * is no state to show.
 */
export const HealthDot = ({ state, of }: { readonly state: SetupState | null; readonly of?: string }) =>
  state === null ? null : <span data-health-dot {...(of === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": `${of}: ${STATE_WORDS[state]}` })} className={classes("size-1.5 shrink-0 rounded-full", TONES[state])} />;
