import { Toggle as RadixToggle } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "./classes.js";

export const Toggle = ({ className, variant = "default", size = "default", ...props }: ComponentProps<typeof RadixToggle.Root> & { readonly variant?: "default" | "outline"; readonly size?: "default" | "sm" | "lg" }) => (
  <RadixToggle.Root className={cn("inline-flex items-center justify-center gap-1 rounded-lg px-2.5 text-sm font-medium text-ink outline-none hover:bg-raised focus-visible:ring-3 focus-visible:ring-beam/50 disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-raised [&_svg]:size-4", variant === "outline" && "border border-hairline-strong", size === "sm" ? "h-7 min-w-7 rounded-md text-[0.8rem]" : size === "lg" ? "h-9 min-w-9" : "h-8 min-w-8", className)} {...props} />
);
