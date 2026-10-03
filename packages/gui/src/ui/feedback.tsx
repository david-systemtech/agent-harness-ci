import { LoaderCircle } from "lucide-react";
import type { ComponentProps } from "react";
import { TONE_INK, type StatusTone } from "./badge.js";
import { cn } from "./classes.js";

/** Loading shapes are decorative; the surrounding view owns its loading announcement. */
export const Skeleton = ({ className, ...props }: ComponentProps<"div">) => <div aria-hidden="true" className={cn("rounded-md bg-raised motion-safe:animate-pulse", className)} {...props} />;
export const Spinner = ({ label = "Loading", className }: { readonly label?: string; readonly className?: string }) => <span role="status" aria-label={label} className="inline-flex"><LoaderCircle aria-hidden="true" className={cn("size-4 motion-safe:animate-spin", className)} /></span>;
export const StatusDot = ({ label, tone = "neutral", className }: { readonly label?: string; readonly tone?: StatusTone; readonly className?: string }) => <span {...(label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label })} className={cn("inline-block size-[6px] shrink-0 rounded-full bg-current", TONE_INK[tone], className)} />;
export const Separator = ({ className, ...props }: ComponentProps<"hr">) => <hr className={cn("border-hairline", className)} {...props} />;
