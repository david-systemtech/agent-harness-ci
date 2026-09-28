import * as RadixMenu from "@radix-ui/react-dropdown-menu";
import type { ComponentProps } from "react";
import { MENU_ITEM, OVERLAY, classes } from "./classes.js";

/** A menu opened from a button: `Menu` holds a `MenuTrigger` and a `MenuContent` of `MenuItem`s. */
export const Menu = RadixMenu.Root;
export const MenuTrigger = RadixMenu.Trigger;

export const MenuContent = ({ className, sideOffset = 4, ...props }: ComponentProps<typeof RadixMenu.Content>) => (
  <RadixMenu.Portal>
    <RadixMenu.Content sideOffset={sideOffset} className={classes(OVERLAY, "min-w-40 p-1", className)} {...props} />
  </RadixMenu.Portal>
);

export const MenuItem = ({ className, ...props }: ComponentProps<typeof RadixMenu.Item>) => <RadixMenu.Item className={classes(MENU_ITEM, className)} {...props} />;

export const MenuSeparator = ({ className, ...props }: ComponentProps<typeof RadixMenu.Separator>) => (
  <RadixMenu.Separator className={classes("my-1 h-px bg-line", className)} {...props} />
);
