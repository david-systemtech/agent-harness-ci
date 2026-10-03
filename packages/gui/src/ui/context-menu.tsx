import { ContextMenu as RadixContextMenu } from "radix-ui";
import { Check, ChevronRight, Circle } from "lucide-react";
import type { ComponentProps } from "react";
import { classes } from "./classes.js";
import { MENU_SURFACE, MENU_ROW, MENU_DANGER } from "./menu.js";

/** A context menu and its submenus; every choice keeps Radix keyboard and pointer semantics. */
export const ContextMenu = RadixContextMenu.Root;
export const ContextMenuTrigger = RadixContextMenu.Trigger;
// eslint-disable-next-line agent-harness/no-client-organisation-state -- Radix groups organise controls, not session state.
export const ContextMenuGroup = RadixContextMenu.Group;
// eslint-disable-next-line agent-harness/no-client-organisation-state -- Radix groups organise controls, not session state.
export const ContextMenuRadioGroup = RadixContextMenu.RadioGroup;
export const ContextMenuSub = RadixContextMenu.Sub;
export const ContextMenuContent = ({ className, collisionPadding = 8, ...props }: ComponentProps<typeof RadixContextMenu.Content>) => (
  <RadixContextMenu.Portal><RadixContextMenu.Content collisionPadding={collisionPadding} className={classes(MENU_SURFACE, "min-w-36 max-h-[var(--radix-context-menu-content-available-height)]", className)} {...props} /></RadixContextMenu.Portal>
);
export const ContextMenuItem = ({ className, inset, variant = "default", ...props }: ComponentProps<typeof RadixContextMenu.Item> & { readonly inset?: boolean; readonly variant?: "default" | "destructive" }) => <RadixContextMenu.Item className={classes(MENU_ROW, inset && "pl-7", variant === "destructive" && MENU_DANGER, className)} {...props} />;
export const ContextMenuCheckboxItem = ({ className, children, ...props }: ComponentProps<typeof RadixContextMenu.CheckboxItem>) => <RadixContextMenu.CheckboxItem className={classes(MENU_ROW, "pr-8", className)} {...props}>{children}<span className="absolute right-2 flex size-4 items-center justify-center"><RadixContextMenu.ItemIndicator><Check aria-hidden="true" /></RadixContextMenu.ItemIndicator></span></RadixContextMenu.CheckboxItem>;
export const ContextMenuRadioItem = ({ className, children, ...props }: ComponentProps<typeof RadixContextMenu.RadioItem>) => <RadixContextMenu.RadioItem className={classes(MENU_ROW, "pr-8", className)} {...props}>{children}<span className="absolute right-2 flex size-4 items-center justify-center"><RadixContextMenu.ItemIndicator><Circle aria-hidden="true" className="fill-current" /></RadixContextMenu.ItemIndicator></span></RadixContextMenu.RadioItem>;
export const ContextMenuLabel = ({ className, inset, ...props }: ComponentProps<typeof RadixContextMenu.Label> & { readonly inset?: boolean }) => <RadixContextMenu.Label className={classes("px-1.5 py-1 text-xs font-medium text-ink-muted", inset && "pl-7", className)} {...props} />;
export const ContextMenuSeparator = ({ className, ...props }: ComponentProps<typeof RadixContextMenu.Separator>) => <RadixContextMenu.Separator className={classes("-mx-1 my-1 h-px bg-hairline", className)} {...props} />;
export const ContextMenuShortcut = ({ className, ...props }: ComponentProps<"kbd">) => <kbd className={classes("ml-auto pl-3 text-xs tracking-[0.1em] text-ink-muted", className)} {...props} />;
export const ContextMenuSubTrigger = ({ className, children, ...props }: ComponentProps<typeof RadixContextMenu.SubTrigger>) => <RadixContextMenu.SubTrigger className={classes(MENU_ROW, "data-[state=open]:bg-wash-strong", className)} {...props}>{children}<ChevronRight aria-hidden="true" className="ml-auto" /></RadixContextMenu.SubTrigger>;
export const ContextMenuSubContent = ({ className, sideOffset = 2, collisionPadding = 8, ...props }: ComponentProps<typeof RadixContextMenu.SubContent>) => <RadixContextMenu.Portal><RadixContextMenu.SubContent sideOffset={sideOffset} collisionPadding={collisionPadding} className={classes(MENU_SURFACE, "min-w-32 max-h-[var(--radix-context-menu-content-available-height)] shadow-lg", className)} {...props} /></RadixContextMenu.Portal>;
