import * as RadixToast from "@radix-ui/react-toast";
import type { ReactNode } from "react";
import { Button } from "./button.js";
import { OVERLAY, classes } from "./classes.js";

/** Where toasts show: wrap the window in it once, and render each `Toast` inside. */
export const Toasts = ({ children, label = "Notifications ({hotkey})" }: { readonly children: ReactNode; readonly label?: string }) => (
  <RadixToast.Provider label={label}>
    {children}
    <RadixToast.Viewport className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2 outline-none" />
  </RadixToast.Provider>
);

export interface ToastProps {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /** What the toast offers to do, as a button beside its text. */
  readonly action?: { readonly label: string; readonly run: () => void };
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** How long it shows before it closes itself, in milliseconds; `Infinity` keeps it until it is dismissed. Preset: Radix's five seconds. */
  readonly duration?: number;
}

/** A short notice in the corner of the window, with an optional action and a dismiss button; open as its props say. */
export const Toast = ({ title, description, action, open, onOpenChange, duration }: ToastProps) => (
  <RadixToast.Root open={open} onOpenChange={onOpenChange} {...(duration !== undefined && { duration })} className={classes(OVERLAY, "flex items-start gap-3 p-3")}>
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <RadixToast.Title className="font-medium">{title}</RadixToast.Title>
      {description !== undefined && <RadixToast.Description className="text-ink-muted">{description}</RadixToast.Description>}
    </div>
    {action !== undefined && (
      <RadixToast.Action altText={action.label} asChild>
        <Button tone="primary" onClick={action.run}>
          {action.label}
        </Button>
      </RadixToast.Action>
    )}
    <RadixToast.Close asChild>
      <Button aria-label="Dismiss">×</Button>
    </RadixToast.Close>
  </RadixToast.Root>
);
