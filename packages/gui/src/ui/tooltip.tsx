import * as RadixTooltip from "@radix-ui/react-tooltip";
import type { ReactElement, ReactNode } from "react";
import { OVERLAY, classes } from "./classes.js";

/** How long the pointer rests on a control before its tooltip shows, in milliseconds (a chosen default); focus shows it at once. */
export const TOOLTIP_DELAY_MS = 500;

/** A tooltip for one control, `children`, which it wraps: shown on hover after a moment, and on focus. */
export const Tooltip = ({ content, children, className }: { readonly content: ReactNode; readonly children: ReactElement; readonly className?: string }) => (
  <RadixTooltip.Provider delayDuration={TOOLTIP_DELAY_MS}>
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content sideOffset={4} className={classes(OVERLAY, "px-2 py-1 text-xs", className)}>
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  </RadixTooltip.Provider>
);
