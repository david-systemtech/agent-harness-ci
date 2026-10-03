import { Popover as RadixPopover } from "radix-ui";
import type { ComponentProps } from "react";
import { classes } from "./classes.js";
import { MENU_SURFACE } from "./menu.js";

/** Content floated beside its trigger: `Popover` holds a `PopoverTrigger` and a `PopoverContent`. */
export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverClose = RadixPopover.Close;

export const PopoverContent = ({ className, sideOffset = 4, collisionPadding = 8, ...props }: ComponentProps<typeof RadixPopover.Content>) => (
  <RadixPopover.Portal>
    <RadixPopover.Content sideOffset={sideOffset} collisionPadding={collisionPadding} className={classes(MENU_SURFACE, "flex w-72 max-w-[calc(100vw-2rem)] max-h-[var(--radix-popover-content-available-height)] flex-col gap-2.5 p-2.5", className)} {...props} />
  </RadixPopover.Portal>
);
