import * as RadixContextMenu from "@radix-ui/react-context-menu";
import type { ComponentProps } from "react";
import { MENU_ITEM, OVERLAY, classes } from "./classes.js";

/**
 * A menu opened by a right click, or the keyboard's menu key, on its trigger: `ContextMenu` holds a `ContextMenuTrigger`
 * and a `ContextMenuContent`, whose items may open a submenu (`ContextMenuSub`, a `ContextMenuSubTrigger` and a
 * `ContextMenuSubContent`) and sit under a `ContextMenuLabel`.
 */
export const ContextMenu = RadixContextMenu.Root;
export const ContextMenuTrigger = RadixContextMenu.Trigger;
export const ContextMenuSub = RadixContextMenu.Sub;

export const ContextMenuContent = ({ className, ...props }: ComponentProps<typeof RadixContextMenu.Content>) => (
  <RadixContextMenu.Portal>
    <RadixContextMenu.Content className={classes(OVERLAY, "min-w-40 p-1", className)} {...props} />
  </RadixContextMenu.Portal>
);

export const ContextMenuItem = ({ className, ...props }: ComponentProps<typeof RadixContextMenu.Item>) => (
  <RadixContextMenu.Item className={classes(MENU_ITEM, className)} {...props} />
);

/** An item that opens its submenu: on the pointer resting on it, a click, or the arrow toward it. */
export const ContextMenuSubTrigger = ({ className, children, ...props }: ComponentProps<typeof RadixContextMenu.SubTrigger>) => (
  <RadixContextMenu.SubTrigger className={classes(MENU_ITEM, "data-[state=open]:bg-wash", className)} {...props}>
    {children}
    <span aria-hidden="true" className="ml-auto pl-3 text-ink-muted">
      ▸
    </span>
  </RadixContextMenu.SubTrigger>
);

export const ContextMenuSubContent = ({ className, ...props }: ComponentProps<typeof RadixContextMenu.SubContent>) => (
  <RadixContextMenu.Portal>
    <RadixContextMenu.SubContent className={classes(OVERLAY, "min-w-40 p-1", className)} {...props} />
  </RadixContextMenu.Portal>
);

export const ContextMenuSeparator = ({ className, ...props }: ComponentProps<typeof RadixContextMenu.Separator>) => (
  <RadixContextMenu.Separator className={classes("my-1 h-px bg-line", className)} {...props} />
);

/** A heading over the items after it, which the highlight passes over. */
export const ContextMenuLabel = ({ className, ...props }: ComponentProps<typeof RadixContextMenu.Label>) => (
  <RadixContextMenu.Label className={classes("px-2 pt-2 pb-1 text-xs font-medium text-ink-muted", className)} {...props} />
);
