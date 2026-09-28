import { useId, type ReactNode } from "react";
import { classes } from "./classes.js";

export interface FoldProps {
  /** What the fold says while shut, and heads it while open: the button's name. */
  readonly summary: ReactNode;
  readonly open: boolean;
  onOpenChange(open: boolean): void;
  /** What it holds, drawn only while it is open. */
  readonly children: ReactNode;
  readonly className?: string;
}

/**
 * A fold: a button saying what it holds, expanded or not, and what it holds
 * under it while open. It holds no state of its own; its owner says whether
 * it is open.
 */
export const Fold = ({ summary, open, onOpenChange, children, className }: FoldProps) => {
  const id = useId();
  return (
    <div className={classes("flex min-w-0 flex-col gap-1", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => onOpenChange(!open)}
        className="flex min-w-0 items-center gap-1.5 self-start rounded-sm text-left text-xs text-ink-muted outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-beam"
      >
        <span aria-hidden="true" className={classes("inline-block transition-transform", open && "rotate-90")}>
          ›
        </span>
        {summary}
      </button>
      {open && <div id={id}>{children}</div>}
    </div>
  );
};
