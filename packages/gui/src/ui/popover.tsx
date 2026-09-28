import * as RadixPopover from "@radix-ui/react-popover";
import type { ComponentProps } from "react";
import { OVERLAY, classes } from "./classes.js";

/** Content floated beside its trigger: `Popover` holds a `PopoverTrigger` and a `PopoverContent`. */
export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverClose = RadixPopover.Close;

export const PopoverContent = ({ className, sideOffset = 4, ...props }: ComponentProps<typeof RadixPopover.Content>) => (
  <RadixPopover.Portal>
    <RadixPopover.Content sideOffset={sideOffset} className={classes(OVERLAY, "w-72 p-3 outline-none", className)} {...props} />
  </RadixPopover.Portal>
);
