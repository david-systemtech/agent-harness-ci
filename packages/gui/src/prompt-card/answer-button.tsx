import type { KeyboardEvent, ReactNode } from "react";
import { Button } from "../ui/index.js";

export interface AnswerProps {
  /** The connection cannot answer now: drawn dim, and a press says why. */
  readonly dim: boolean;
  /** It approves: a bare Enter never presses it, even with the focus on it. */
  readonly approves?: boolean;
  /** A mode above the ceiling: greyed, and a press says why. */
  readonly greyed?: boolean;
  readonly describedBy?: string | undefined;
  readonly onClick: () => void;
  readonly children: ReactNode;
}

/** A bare Enter, which never approves. */
const bareEnter = (event: KeyboardEvent) => event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;

/**
 * One answer's button, on a parked prompt's card and in the Parked asks
 * view. Dim or greyed is `aria-disabled`, not `disabled`, so it still takes
 * the pointer and the focus, and a press says why nothing is sent. An
 * approving one refuses a bare Enter, which a button would otherwise take as
 * a click, so nothing is approved by reflex (story 10).
 */
export const Answer = ({ dim, approves = false, greyed = false, describedBy, onClick, children }: AnswerProps) => (
  <Button
    tone={approves && !greyed ? "primary" : "quiet"}
    aria-disabled={dim || greyed ? true : undefined}
    aria-describedby={describedBy}
    className="border border-line aria-disabled:cursor-default aria-disabled:border-hairline aria-disabled:bg-transparent aria-disabled:text-ink-faint"
    onKeyDown={(event) => {
      if (approves && bareEnter(event)) event.preventDefault();
    }}
    onClick={onClick}
  >
    {children}
  </Button>
);
