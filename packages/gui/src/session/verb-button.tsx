import type { ReactNode } from "react";
import type { Offer } from "../keys/key-dispatch.js";
import { Button, Tooltip } from "../ui/index.js";

export interface VerbButtonProps {
  /** What the button says. */
  readonly children: ReactNode;
  /** What it does, in its tooltip. */
  readonly does: string;
  /** Whether the verb can be used now, as the runtime says (`projections.runs.session`'s verbs, or a capability's answer). */
  readonly availability: Offer;
  /** Runs the verb; asked while it is absent too, to say why it is not done. */
  readonly run: () => void;
}

/**
 * A session verb's button (ADR 0022: "a client draws an absent verb dim with
 * the adapter's reason, never hidden"): its tooltip says what it does, and
 * while the runtime says the verb cannot be used now the button is dim and
 * the tooltip says why under it. Dim is `aria-disabled` rather than
 * `disabled`, so the button still takes the pointer and the focus that show
 * the reason, and a press on it is handed to `run`, which says the reason
 * in one line and dispatches nothing.
 */
export const VerbButton = ({ children, does, availability, run }: VerbButtonProps) => {
  const absent = availability.status === "absent" ? availability.message : undefined;
  return (
    <Tooltip
      content={
        <>
          <span className="block">{does}</span>
          {absent !== undefined && <span className="block text-ink-muted">{absent}</span>}
        </>
      }
    >
      <Button aria-disabled={absent === undefined ? undefined : true} className="h-7 px-2 text-xs aria-disabled:cursor-default aria-disabled:text-ink-faint aria-disabled:hover:bg-transparent" onClick={run}>
        {children}
      </Button>
    </Tooltip>
  );
};
