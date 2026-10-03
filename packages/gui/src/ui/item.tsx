import type { ComponentProps } from "react";
import { cn } from "./classes.js";
export const Item = ({ className, variant = "default", size = "default", ...props }: ComponentProps<"div"> & { readonly variant?: "default" | "outline" | "muted"; readonly size?: "default" | "sm" | "xs" }) => <div className={cn("flex flex-wrap items-center rounded-lg border border-transparent text-sm", size === "xs" ? "gap-2 px-2.5 py-2" : "gap-2.5 px-3 py-2.5", variant === "outline" && "border-hairline", variant === "muted" && "bg-wash/50", className)} {...props} />;
export const ItemContent = ({ className, ...props }: ComponentProps<"div">) => <div className={cn("flex min-w-0 flex-1 flex-col gap-1", className)} {...props} />;
export const ItemTitle = ({ className, ...props }: ComponentProps<"div">) => <div className={cn("flex items-center gap-2 font-medium", className)} {...props} />;
export const ItemDescription = ({ className, ...props }: ComponentProps<"p">) => <p className={cn("text-xs text-ink-muted", className)} {...props} />;
export const ItemActions = ({ className, ...props }: ComponentProps<"div">) => <div className={cn("flex items-center gap-2", className)} {...props} />;
