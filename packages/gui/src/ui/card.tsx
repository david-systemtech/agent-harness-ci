import type { ComponentProps } from "react";
import { cn } from "./classes.js";

export const Card = ({ className, size = "default", ...props }: ComponentProps<"div"> & { readonly size?: "default" | "sm" }) => <div data-size={size} className={cn("flex flex-col overflow-hidden rounded-lg border border-hairline bg-panel text-sm text-ink", size === "sm" ? "gap-3 p-3" : "gap-4 p-4", className)} {...props} />;
export const CardHeader = ({ className, ...props }: ComponentProps<"div">) => <div className={cn("flex items-start justify-between gap-3", className)} {...props} />;
export const CardTitle = ({ className, ...props }: ComponentProps<"h3">) => <h3 className={cn("text-base font-medium", className)} {...props} />;
export const CardDescription = ({ className, ...props }: ComponentProps<"p">) => <p className={cn("text-sm text-ink-muted", className)} {...props} />;
export const CardContent = ({ className, ...props }: ComponentProps<"div">) => <div className={cn("min-w-0", className)} {...props} />;
export const CardFooter = ({ className, ...props }: ComponentProps<"div">) => <div className={cn("flex items-center gap-2 border-t border-hairline pt-3", className)} {...props} />;
