import type { ComponentProps } from "react";
import { classes } from "./classes.js";

/** A native choice among options; name it with a label or `aria-label`, and give it its `option`s. */
export const Select = ({ className, ...props }: ComponentProps<"select">) => (
  <select
    className={classes("h-8 rounded-md border border-line bg-inset px-2 text-sm text-ink outline-none focus-visible:border-beam disabled:text-ink-faint", className)}
    {...props}
  />
);
