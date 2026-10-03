import type { ComponentProps } from "react";
import { cn } from "./classes.js";
export const Alert = ({ className, variant = "default", ...props }: ComponentProps<"div"> & { readonly variant?: "default" | "destructive" | "warning" }) => <div role="alert" className={cn("grid gap-0.5 rounded-lg border border-hairline bg-panel px-2.5 py-2 text-sm text-ink [&_svg]:size-4", variant === "destructive" && "border-signal/30 text-signal", variant === "warning" && "border-amber/30 bg-amber/10 text-amber", className)} {...props} />;
export const AlertTitle = ({ className, ...props }: ComponentProps<"h3">) => <h3 className={cn("font-medium", className)} {...props} />;
export const AlertDescription = ({ className, ...props }: ComponentProps<"div">) => <div className={cn("text-sm text-ink-muted", className)} {...props} />;
