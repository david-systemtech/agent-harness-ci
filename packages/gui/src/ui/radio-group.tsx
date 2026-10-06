import { RadioGroup as RadixRadio } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "./classes.js";

export const RadioGroup = ({ className, ...props }: ComponentProps<typeof RadixRadio.Root>) => <RadixRadio.Root className={cn("grid gap-2", className)} {...props} />;
export const RadioGroupItem = ({ className, ...props }: ComponentProps<typeof RadixRadio.Item>) => (
  <RadixRadio.Item className={cn("relative inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-line-strong bg-transparent dark:bg-hairline-strong/30 outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:ring-3 focus-visible:ring-beam/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-signal aria-checked:border-beam aria-checked:bg-beam", className)} {...props}>
    <RadixRadio.Indicator className="size-2 rounded-full bg-beam-ink" />
  </RadixRadio.Item>
);
