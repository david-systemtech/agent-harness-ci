import type { ComponentProps } from "react";
import { cn } from "./classes.js";
export const Item = ({ className, variant = "default", size = "default", ...props }: ComponentProps<"div"> & { readonly variant?: "default" | "outline" | "muted"; readonly size?: "default" | "sm" | "xs" }) => <div data-size={size} className={cn("group/item flex flex-wrap items-center rounded-lg border border-transparent text-sm", size === "xs" ? "gap-2 px-2.5 py-2" : "gap-2.5 px-3 py-2.5", variant === "outline" && "border-hairline", variant === "muted" && "bg-raised/50", className)} {...props} />;
export const ItemContent = ({ className, ...props }: ComponentProps<"div">) => <div className={cn("flex min-w-0 flex-1 flex-col gap-1 group-data-[size=xs]/item:gap-0", className)} {...props} />;
export const ItemTitle = ({ className, ...props }: ComponentProps<"div">) => <div className={cn("line-clamp-1 leading-snug font-medium", className)} {...props} />;
export const ItemDescription = ({ className, ...props }: ComponentProps<"p">) => <p className={cn("line-clamp-2 text-sm text-ink-muted group-data-[size=xs]/item:text-xs", className)} {...props} />;
export const ItemActions = ({ className, ...props }: ComponentProps<"div">) => <div className={cn("flex items-center gap-2", className)} {...props} />;
