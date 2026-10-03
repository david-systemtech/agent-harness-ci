import type { ComponentProps } from "react";
import { cn } from "./classes.js";
import { FIELD_CONTROL } from "./input.js";

export const Textarea = ({ className, ...props }: ComponentProps<"textarea">) => (
  <textarea className={cn(FIELD_CONTROL, "flex field-sizing-content min-h-16 w-full px-2.5 py-2", className)} {...props} />
);
