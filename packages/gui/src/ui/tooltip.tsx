import { Tooltip as RadixTooltip } from "radix-ui";
import { createContext, useContext, useEffect, useState, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { classes } from "./classes.js";

export const TOOLTIP_DELAY_MS = 250;
export const TOOLTIP_SKIP_MS = 400;
const HasTooltipProvider = createContext(false);

// Focus may move through a portal or into a newly mounted, isolated tooltip provider.
// All providers in the document therefore read the same last input modality.
// Like `:focus-visible`, only focus that follows the keyboard (or no input yet) reveals a hint:
// a dialog opened by a click focuses its first control, and its hint would cover the dialog's text.
type Modality = "keyboard" | "pointer" | "touch";
interface TooltipInput { by: Modality; users: number; pointer: (event: PointerEvent) => void; keyboard: (event: KeyboardEvent) => void }
const pointerModality = (event: PointerEvent): Modality => event.pointerType === "touch" ? "touch" : "pointer";
const inputs = new WeakMap<Document, TooltipInput>();
const inputFor = (page: Document): TooltipInput => {
  let input = inputs.get(page);
  if (!input) {
    const next: TooltipInput = { by: "keyboard", users: 0,
      pointer: event => { next.by = pointerModality(event); },
      // A chord or a window switch (Alt+Tab, Cmd+Tab) is not focus navigation, as for `:focus-visible`.
      keyboard: event => { if (!event.altKey && !event.ctrlKey && !event.metaKey) next.by = "keyboard"; },
    };
    inputs.set(page, next);
    input = next;
  }
  return input;
};

/** One provider per window makes moving between nearby controls skip the first delay. */
export const TooltipProvider = ({ children, delayDuration = TOOLTIP_DELAY_MS, skipDelayDuration = TOOLTIP_SKIP_MS, ...props }: ComponentProps<typeof RadixTooltip.Provider>) => {
  useEffect(() => {
    const page = document;
    const input = inputFor(page);
    if (input.users++ === 0) {
      page.addEventListener("pointerdown", input.pointer, true);
      page.addEventListener("keydown", input.keyboard, true);
    }
    return () => {
      if (--input.users === 0) {
        page.removeEventListener("pointerdown", input.pointer, true);
        page.removeEventListener("keydown", input.keyboard, true);
        input.by = "keyboard";
      }
    };
  }, []);
  return <HasTooltipProvider value><RadixTooltip.Provider delayDuration={delayDuration} skipDelayDuration={skipDelayDuration} {...props}>{children}</RadixTooltip.Provider></HasTooltipProvider>;
};

/** Keyboard focus reveals the hint immediately; isolated controls get the same default timing. */
export const Tooltip = ({ content, children, className, onEscapeKeyDown, open, defaultOpen = false, onOpenChange, ...props }: ComponentProps<typeof RadixTooltip.Root> & { readonly content: ReactNode; readonly children: ReactElement; readonly className?: string; readonly onEscapeKeyDown?: ComponentProps<typeof RadixTooltip.Content>["onEscapeKeyDown"] }) => {
  const shared = useContext(HasTooltipProvider);
  const input = inputFor(document);
  const [shown, setShown] = useState(defaultOpen);
  const change = (next: boolean) => {
    if (next && input.by === "touch") return;
    setShown(next);
    onOpenChange?.(next);
  };
  const hint = <RadixTooltip.Root {...props} open={open ?? shown} onOpenChange={change}>
    <RadixTooltip.Trigger asChild
      onPointerDown={event => { input.by = pointerModality(event.nativeEvent); if (input.by === "touch") change(false); }}
      onPointerMove={event => {
        if (window.matchMedia("(hover: none)").matches) event.preventDefault();
        else if (event.pointerType === "mouse" && input.by === "touch") input.by = "pointer";
      }}
      onFocus={event => { if (input.by !== "keyboard") event.preventDefault(); }}
    >{children}</RadixTooltip.Trigger>
    <RadixTooltip.Portal>
      <RadixTooltip.Content data-ui-tooltip onEscapeKeyDown={onEscapeKeyDown} sideOffset={6} collisionPadding={8} className={classes("z-50 flex max-w-72 gap-1.5 rounded-md border border-hairline-strong bg-float px-2.5 py-1.5 text-xs leading-snug text-ink [overflow-wrap:anywhere] shadow-lg shadow-scrim/40 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1 data-[side=left]:slide-in-from-left-1 data-[side=right]:slide-in-from-left-1 duration-100 motion-reduce:animate-none", className)}>{content}</RadixTooltip.Content>
    </RadixTooltip.Portal>
  </RadixTooltip.Root>;
  return shared ? hint : <TooltipProvider>{hint}</TooltipProvider>;
};
