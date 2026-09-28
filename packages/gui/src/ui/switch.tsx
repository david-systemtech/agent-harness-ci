import * as RadixSwitch from "@radix-ui/react-switch";
import type { ComponentProps } from "react";
import { classes } from "./classes.js";

/** An on or off switch; name it with a label or `aria-label`. Controlled or not, as its props say. */
export const Switch = ({ className, ...props }: ComponentProps<typeof RadixSwitch.Root>) => (
  <RadixSwitch.Root
    className={classes(
      "inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-line-strong bg-inset focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-beam data-[state=checked]:bg-beam disabled:opacity-50",
      className,
    )}
    {...props}
  >
    <RadixSwitch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-ink transition-transform data-[state=checked]:translate-x-4 data-[state=checked]:bg-beam-ink" />
  </RadixSwitch.Root>
);
