import { ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "./classes.js";
import { FIELD_CONTROL } from "./input.js";

/** The trigger is drawn here; options, form submission and keyboard navigation remain native. */
export const Select = ({ className, ...props }: ComponentProps<"select">) => (
  <span className="relative inline-flex min-w-0 max-w-full items-center">
    <select className={cn(FIELD_CONTROL, "h-8 w-full appearance-none py-1 pr-8 pl-2.5", className)} {...props} />
    <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-2 size-4 text-ink-muted" />
  </span>
);
