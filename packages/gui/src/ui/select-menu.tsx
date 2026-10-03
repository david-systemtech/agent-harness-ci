import { Select as RadixSelect } from "radix-ui";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import type { ComponentProps } from "react";
import { classes } from "./classes.js";
import { MENU_ROW, MENU_SURFACE } from "./menu.js";

/** A menu-backed choice for callers that need it; the native Select keeps its own API. */
export const SelectMenu = RadixSelect.Root;
export const SelectMenuValue = RadixSelect.Value;
// eslint-disable-next-line agent-harness/no-client-organisation-state -- Radix groups organise controls, not session state.
export const SelectMenuGroup = RadixSelect.Group;
export const SelectMenuTrigger = ({ className, children, ...props }: ComponentProps<typeof RadixSelect.Trigger>) => <RadixSelect.Trigger className={classes("flex h-8 w-full items-center justify-between gap-2 rounded-lg border border-hairline-strong bg-hairline-strong/30 px-2.5 text-sm text-ink outline-none focus-visible:border-beam focus-visible:ring-3 focus-visible:ring-beam/50 disabled:opacity-50 [&_svg]:size-4", className)} {...props}>{children}<RadixSelect.Icon asChild><ChevronDown aria-hidden="true" className="shrink-0 text-ink-muted" /></RadixSelect.Icon></RadixSelect.Trigger>;
export const SelectMenuContent = ({ className, children, position = "popper", sideOffset = 4, collisionPadding = 8, ...props }: ComponentProps<typeof RadixSelect.Content>) => <RadixSelect.Portal><RadixSelect.Content position={position} sideOffset={sideOffset} collisionPadding={collisionPadding} className={classes(MENU_SURFACE, "min-w-[max(9rem,var(--radix-select-trigger-width))] max-h-[var(--radix-select-content-available-height)]", className)} {...props}>
  <RadixSelect.ScrollUpButton className="flex items-center justify-center py-1"><ChevronUp aria-hidden="true" className="size-4" /></RadixSelect.ScrollUpButton>
  <RadixSelect.Viewport>{children}</RadixSelect.Viewport>
  <RadixSelect.ScrollDownButton className="flex items-center justify-center py-1"><ChevronDown aria-hidden="true" className="size-4" /></RadixSelect.ScrollDownButton>
</RadixSelect.Content></RadixSelect.Portal>;
export const SelectMenuItem = ({ className, children, ...props }: ComponentProps<typeof RadixSelect.Item>) => <RadixSelect.Item className={classes(MENU_ROW, "pr-8", className)} {...props}><RadixSelect.ItemText>{children}</RadixSelect.ItemText><RadixSelect.ItemIndicator className="absolute right-2"><Check aria-hidden="true" className="size-4" /></RadixSelect.ItemIndicator></RadixSelect.Item>;
export const SelectMenuLabel = ({ className, ...props }: ComponentProps<typeof RadixSelect.Label>) => <RadixSelect.Label className={classes("px-1.5 py-1 text-xs font-medium text-ink-muted", className)} {...props} />;
export const SelectMenuSeparator = ({ className, ...props }: ComponentProps<typeof RadixSelect.Separator>) => <RadixSelect.Separator className={classes("-mx-1 my-1 h-px bg-hairline", className)} {...props} />;
