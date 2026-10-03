import type { ComponentProps } from "react";
import { cn } from "./classes.js";

export const Card = ({ className, size = "default", ...props }: ComponentProps<"div"> & { readonly size?: "default" | "sm" }) => <div data-size={size} className={cn("group/card flex flex-col overflow-hidden rounded-lg border border-hairline bg-panel text-sm text-ink has-[>[data-slot=card-footer]]:pb-0", size === "sm" ? "gap-3 py-3" : "gap-4 py-4", className)} {...props} />;
export const CardHeader = ({ className, ...props }: ComponentProps<"div">) => <div className={cn("grid grid-cols-[1fr_auto] items-start gap-1 px-4 group-data-[size=sm]/card:px-3", className)} {...props} />;
export const CardTitle = ({ className, ...props }: ComponentProps<"h3">) => <h3 className={cn("col-start-1 text-base leading-snug font-medium group-data-[size=sm]/card:text-sm", className)} {...props} />;
export const CardDescription = ({ className, ...props }: ComponentProps<"p">) => <p className={cn("col-start-1 text-sm text-ink-muted", className)} {...props} />;
export const CardAction = ({ className, ...props }: ComponentProps<"div">) => <div className={cn("col-start-2 row-span-2 row-start-1 self-start", className)} {...props} />;
export const CardContent = ({ className, ...props }: ComponentProps<"div">) => <div className={cn("min-w-0 px-4 group-data-[size=sm]/card:px-3", className)} {...props} />;
export const CardFooter = ({ className, ...props }: ComponentProps<"div">) => <div data-slot="card-footer" className={cn("flex items-center gap-2 border-t border-hairline bg-raised/50 p-4 group-data-[size=sm]/card:p-3", className)} {...props} />;
