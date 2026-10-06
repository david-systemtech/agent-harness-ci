import { Check, Minus } from "lucide-react";
import { Checkbox as RadixCheckbox } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "./classes.js";

export const Checkbox = ({ className, checked, defaultChecked, ...props }: ComponentProps<typeof RadixCheckbox.Root>) => (
  <RadixCheckbox.Root {...(checked === undefined ? {} : { checked })} {...(defaultChecked === undefined ? {} : { defaultChecked })} className={cn("group/checkbox relative inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-hairline-strong bg-transparent dark:bg-hairline-strong/30 text-beam-ink outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:ring-3 focus-visible:ring-beam/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-signal aria-checked:border-beam aria-checked:bg-beam aria-[checked=mixed]:border-beam aria-[checked=mixed]:bg-beam", className)} {...props}>
    <RadixCheckbox.Indicator><Check aria-hidden="true" className="size-3.5 group-aria-[checked=mixed]/checkbox:hidden" /><Minus aria-hidden="true" className="hidden size-3.5 group-aria-[checked=mixed]/checkbox:block" /></RadixCheckbox.Indicator>
  </RadixCheckbox.Root>
);
