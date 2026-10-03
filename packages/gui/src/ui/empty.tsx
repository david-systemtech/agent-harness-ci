import type { ComponentProps } from "react";
import { cn } from "./classes.js";
export const Empty = ({ className, ...props }: ComponentProps<"div">) => <div className={cn("flex min-w-0 flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-hairline p-6 text-center", className)} {...props} />;
export const EmptyMedia = ({ className, ...props }: ComponentProps<"div">) => <div className={cn("flex size-8 items-center justify-center rounded-lg bg-raised [&_svg]:size-4", className)} {...props} />;
export const EmptyTitle = ({ className, ...props }: ComponentProps<"h3">) => <h3 className={cn("text-sm font-medium tracking-tight", className)} {...props} />;
export const EmptyDescription = ({ className, ...props }: ComponentProps<"p">) => <p className={cn("max-w-sm text-sm leading-relaxed text-ink-muted", className)} {...props} />;
