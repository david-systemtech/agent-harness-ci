import { DropdownMenu as RadixMenu } from "radix-ui";
import { Check, ChevronRight, Circle } from "lucide-react";
import type { ComponentProps } from "react";
import { classes } from "./classes.js";

export const MENU_SURFACE = "z-50 overflow-y-auto rounded-lg bg-float p-1 text-sm text-ink ring-1 ring-ink/10 shadow-md shadow-scrim/10 outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 duration-100 motion-reduce:animate-none";
export const MENU_ROW = "relative flex cursor-default select-none items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-none data-[highlighted]:bg-wash-strong data-[highlighted]:text-ink data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0";
export const MENU_DANGER = "text-signal data-[highlighted]:bg-signal/10 data-[highlighted]:text-signal dark:data-[highlighted]:bg-signal/20";

/** A dropdown of store-free items; Radix owns focus, dismissal and disabled selection. */
export const Menu = RadixMenu.Root;
export const MenuTrigger = RadixMenu.Trigger;
// eslint-disable-next-line agent-harness/no-client-organisation-state -- Radix groups organise controls, not session state.
export const MenuGroup = RadixMenu.Group;
// eslint-disable-next-line agent-harness/no-client-organisation-state -- Radix groups organise controls, not session state.
export const MenuRadioGroup = RadixMenu.RadioGroup;
export const MenuSub = RadixMenu.Sub;
export const MenuContent = ({ className, sideOffset = 4, collisionPadding = 8, ...props }: ComponentProps<typeof RadixMenu.Content>) => (
  <RadixMenu.Portal><RadixMenu.Content sideOffset={sideOffset} collisionPadding={collisionPadding} className={classes(MENU_SURFACE, "min-w-32 max-h-[var(--radix-dropdown-menu-content-available-height)]", className)} {...props} /></RadixMenu.Portal>
);
export const MenuItem = ({ className, inset, variant = "default", ...props }: ComponentProps<typeof RadixMenu.Item> & { readonly inset?: boolean; readonly variant?: "default" | "destructive" }) => <RadixMenu.Item className={classes(MENU_ROW, inset && "pl-7", variant === "destructive" && MENU_DANGER, className)} {...props} />;
export const MenuCheckboxItem = ({ className, children, ...props }: ComponentProps<typeof RadixMenu.CheckboxItem>) => <RadixMenu.CheckboxItem className={classes(MENU_ROW, "pr-8", className)} {...props}>{children}<span className="absolute right-2 flex size-4 items-center justify-center"><RadixMenu.ItemIndicator><Check aria-hidden="true" /></RadixMenu.ItemIndicator></span></RadixMenu.CheckboxItem>;
export const MenuRadioItem = ({ className, children, ...props }: ComponentProps<typeof RadixMenu.RadioItem>) => <RadixMenu.RadioItem className={classes(MENU_ROW, "pr-8", className)} {...props}>{children}<span className="absolute right-2 flex size-4 items-center justify-center"><RadixMenu.ItemIndicator><Circle aria-hidden="true" className="fill-current" /></RadixMenu.ItemIndicator></span></RadixMenu.RadioItem>;
export const MenuLabel = ({ className, inset, ...props }: ComponentProps<typeof RadixMenu.Label> & { readonly inset?: boolean }) => <RadixMenu.Label className={classes("px-1.5 py-1 text-xs font-medium text-ink-muted", inset && "pl-7", className)} {...props} />;
export const MenuSeparator = ({ className, ...props }: ComponentProps<typeof RadixMenu.Separator>) => <RadixMenu.Separator className={classes("-mx-1 my-1 h-px bg-hairline", className)} {...props} />;
export const MenuShortcut = ({ className, ...props }: ComponentProps<"kbd">) => <kbd className={classes("ml-auto pl-3 text-xs tracking-[0.1em] text-ink-muted", className)} {...props} />;
export const MenuSubTrigger = ({ className, children, ...props }: ComponentProps<typeof RadixMenu.SubTrigger>) => <RadixMenu.SubTrigger className={classes(MENU_ROW, "data-[state=open]:bg-wash-strong", className)} {...props}>{children}<ChevronRight aria-hidden="true" className="ml-auto" /></RadixMenu.SubTrigger>;
export const MenuSubContent = ({ className, sideOffset = 2, collisionPadding = 8, ...props }: ComponentProps<typeof RadixMenu.SubContent>) => <RadixMenu.Portal><RadixMenu.SubContent sideOffset={sideOffset} collisionPadding={collisionPadding} className={classes(MENU_SURFACE, "min-w-24 max-h-[var(--radix-dropdown-menu-content-available-height)] shadow-lg", className)} {...props} /></RadixMenu.Portal>;
