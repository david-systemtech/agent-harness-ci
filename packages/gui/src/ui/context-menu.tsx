import * as RadixContextMenu from "@radix-ui/react-context-menu";
import type { ComponentProps } from "react";
import { MENU_ITEM, OVERLAY, classes } from "./classes.js";

/** A menu opened by a right click, or the keyboard's menu key, on its trigger: `ContextMenu` holds a `ContextMenuTrigger` and a `ContextMenuContent`. */
export const ContextMenu = RadixContextMenu.Root;
export const ContextMenuTrigger = RadixContextMenu.Trigger;

export const ContextMenuContent = ({ className, ...props }: ComponentProps<typeof RadixContextMenu.Content>) => (
  <RadixContextMenu.Portal>
    <RadixContextMenu.Content className={classes(OVERLAY, "min-w-40 p-1", className)} {...props} />
  </RadixContextMenu.Portal>
);

export const ContextMenuItem = ({ className, ...props }: ComponentProps<typeof RadixContextMenu.Item>) => (
  <RadixContextMenu.Item className={classes(MENU_ITEM, className)} {...props} />
);

export const ContextMenuSeparator = ({ className, ...props }: ComponentProps<typeof RadixContextMenu.Separator>) => (
  <RadixContextMenu.Separator className={classes("my-1 h-px bg-line", className)} {...props} />
);
