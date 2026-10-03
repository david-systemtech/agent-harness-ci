import type { ComponentProps } from "react";
import { cn } from "./classes.js";
export const Kbd = ({ className, ...props }: ComponentProps<"kbd">) => <kbd className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-hairline bg-inset px-1 font-sans text-[0.6875rem] font-medium text-ink-faint", className)} {...props} />;
export const KbdGroup = ({ className, ...props }: ComponentProps<"span">) => <span className={cn("inline-flex items-center gap-1", className)} {...props} />;
