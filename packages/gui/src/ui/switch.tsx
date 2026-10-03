import { Switch as RadixSwitch } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "./classes.js";

export const Switch = ({ className, size = "default", ...props }: ComponentProps<typeof RadixSwitch.Root> & { readonly size?: "default" | "sm" }) => (
  <RadixSwitch.Root data-size={size} className={cn("group inline-flex shrink-0 items-center rounded-full border border-transparent bg-wash-strong outline-none transition-colors focus-visible:ring-3 focus-visible:ring-beam/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-3 aria-invalid:ring-signal/20 data-[state=checked]:bg-beam", size === "sm" ? "h-3.5 w-6" : "h-[1.15rem] w-8", className)} {...props}>
    <RadixSwitch.Thumb className={cn("pointer-events-none block rounded-full bg-panel transition-transform data-[state=checked]:bg-beam-ink dark:data-[state=unchecked]:bg-ink", size === "sm" ? "size-3 data-[state=checked]:translate-x-2.5" : "size-4 data-[state=checked]:translate-x-3.5")} />
  </RadixSwitch.Root>
);
