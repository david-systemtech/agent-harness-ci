import { RadioGroup as RadixRadio } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "./classes.js";

export const RadioGroup = ({ className, ...props }: ComponentProps<typeof RadixRadio.Root>) => <RadixRadio.Root className={cn("grid gap-2", className)} {...props} />;
export const RadioGroupItem = ({ className, ...props }: ComponentProps<typeof RadixRadio.Item>) => (
  <RadixRadio.Item className={cn("inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-hairline-strong bg-wash/30 outline-none focus-visible:ring-3 focus-visible:ring-beam/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-signal data-[state=checked]:border-beam data-[state=checked]:bg-beam", className)} {...props}>
    <RadixRadio.Indicator className="size-2 rounded-full bg-beam-ink" />
  </RadixRadio.Item>
);
