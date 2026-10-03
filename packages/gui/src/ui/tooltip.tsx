import { Tooltip as RadixTooltip } from "radix-ui";
import { createContext, useContext, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { classes } from "./classes.js";

export const TOOLTIP_DELAY_MS = 250;
export const TOOLTIP_SKIP_MS = 400;
const HasTooltipProvider = createContext(false);

/** One provider per window makes moving between nearby controls skip the first delay. */
export const TooltipProvider = ({ children, delayDuration = TOOLTIP_DELAY_MS, skipDelayDuration = TOOLTIP_SKIP_MS, ...props }: ComponentProps<typeof RadixTooltip.Provider>) => (
  <HasTooltipProvider value><RadixTooltip.Provider delayDuration={delayDuration} skipDelayDuration={skipDelayDuration} {...props}>{children}</RadixTooltip.Provider></HasTooltipProvider>
);

/** Focus reveals the hint immediately; isolated controls get the same default timing. */
export const Tooltip = ({ content, children, className, ...props }: ComponentProps<typeof RadixTooltip.Root> & { readonly content: ReactNode; readonly children: ReactElement; readonly className?: string }) => {
  const shared = useContext(HasTooltipProvider);
  const hint = <RadixTooltip.Root {...props}>
    <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
    <RadixTooltip.Portal>
      <RadixTooltip.Content sideOffset={6} collisionPadding={8} className={classes("z-50 flex max-w-72 gap-1.5 rounded-md border border-hairline-strong bg-float px-2.5 py-1.5 text-xs leading-snug text-ink [overflow-wrap:anywhere] shadow-lg shadow-scrim/40 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 duration-100 motion-reduce:animate-none", className)}>{content}</RadixTooltip.Content>
    </RadixTooltip.Portal>
  </RadixTooltip.Root>;
  return shared ? hint : <TooltipProvider>{hint}</TooltipProvider>;
};
