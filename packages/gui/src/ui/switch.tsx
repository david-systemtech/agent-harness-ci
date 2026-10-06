import { Switch as RadixSwitch } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "./classes.js";

export const Switch = ({ className, size = "default", ...props }: ComponentProps<typeof RadixSwitch.Root> & { readonly size?: "default" | "sm" }) => (
  <RadixSwitch.Root data-size={size} className={cn("group/switch inline-flex shrink-0 items-center rounded-full border border-transparent bg-hairline-strong dark:bg-hairline-strong/80 outline-none transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-beam/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-3 aria-invalid:ring-signal/20 aria-checked:bg-beam", size === "sm" ? "h-[14px] w-[24px]" : "h-[18.4px] w-[32px]", className)} {...props}>
    <RadixSwitch.Thumb className={cn("pointer-events-none block rounded-full bg-abyss transition-transform duration-150 group-aria-checked/switch:bg-beam-ink dark:group-aria-[checked=false]/switch:bg-ink", size === "sm" ? "size-[12px] group-aria-checked/switch:translate-x-[10px]" : "size-[16px] group-aria-checked/switch:translate-x-[14px]")} />
  </RadixSwitch.Root>
);
