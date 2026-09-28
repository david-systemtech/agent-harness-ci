import type { ComponentProps } from "react";
import { classes } from "./classes.js";

/** A one-line text field; name it with a label or `aria-label`. */
export const Input = ({ className, ...props }: ComponentProps<"input">) => (
  <input
    className={classes(
      "h-8 w-full rounded-md border border-line bg-inset px-2 text-sm text-ink outline-none placeholder:text-ink-faint focus-visible:border-beam disabled:text-ink-faint",
      className,
    )}
    {...props}
  />
);
