import type { ComponentProps } from "react";
import { cn } from "./classes.js";

/** Shared border, focus, invalid and disabled states for native text controls. */
export const FIELD_CONTROL = "phone-field min-w-0 rounded-lg border border-hairline-strong bg-transparent text-base text-ink md:text-sm outline-none transition-colors placeholder:text-ink-muted focus-visible:border-beam focus-visible:ring-3 focus-visible:ring-beam/50 disabled:cursor-not-allowed disabled:bg-hairline-strong/50 disabled:opacity-50 aria-invalid:border-signal aria-invalid:ring-3 aria-invalid:ring-signal/20 dark:bg-hairline-strong/30 dark:disabled:bg-hairline-strong/80 dark:aria-invalid:ring-signal/40";

/** A one-line text field; name it with a label or aria-label. */
export const Input = ({ className, ...props }: ComponentProps<"input">) => (
  <input className={cn(FIELD_CONTROL, "h-8 w-full px-2.5 py-1 file:mr-2 file:border-0 file:bg-transparent file:text-ink", className)} {...props} />
);
