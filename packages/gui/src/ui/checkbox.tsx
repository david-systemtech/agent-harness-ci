import { Check, Minus } from "lucide-react";
import { Checkbox as RadixCheckbox } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "./classes.js";

export const Checkbox = ({ className, checked, defaultChecked, ...props }: ComponentProps<typeof RadixCheckbox.Root>) => (
  <RadixCheckbox.Root {...(checked === undefined ? {} : { checked })} {...(defaultChecked === undefined ? {} : { defaultChecked })} className={cn("group inline-flex size-4 shrink-0 items-center justify-center rounded-sm border border-hairline-strong bg-wash/30 text-beam-ink outline-none focus-visible:ring-3 focus-visible:ring-beam/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-signal data-[state=checked]:border-beam data-[state=checked]:bg-beam data-[state=indeterminate]:border-beam data-[state=indeterminate]:bg-beam", className)} {...props}>
    <RadixCheckbox.Indicator><Check aria-hidden="true" className="size-3.5 group-data-[state=indeterminate]:hidden" /><Minus aria-hidden="true" className="hidden size-3.5 group-data-[state=indeterminate]:block" /></RadixCheckbox.Indicator>
  </RadixCheckbox.Root>
);
