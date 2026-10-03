import type { ComponentProps } from "react";
import type { ButtonVariant } from "./button.js";
import { cn } from "./classes.js";

const VARIANTS: Readonly<Record<ButtonVariant, string>> = {
  default: "bg-beam text-beam-ink", secondary: "bg-raised text-ink", destructive: "bg-signal/10 text-signal dark:bg-signal/20",
  outline: "border-hairline text-ink", ghost: "text-ink-muted hover:bg-raised hover:text-ink", link: "text-beam-text underline-offset-4 hover:underline",
};
export const Badge = ({ className, variant = "default", ...props }: ComponentProps<"span"> & { readonly variant?: ButtonVariant }) => <span className={cn("inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3", VARIANTS[variant], className)} {...props} />;
export type StatusTone = "neutral" | "info" | "thinking" | "success" | "warning" | "danger";
export const TONE_INK: Readonly<Record<StatusTone, string>> = { neutral: "text-ink-muted", info: "text-cyan", thinking: "text-sage", success: "text-mint", warning: "text-amber", danger: "text-signal" };
const TONE_FILL: Readonly<Record<StatusTone, string>> = { neutral: "bg-ink-muted/10", info: "bg-cyan/10", thinking: "bg-sage/10", success: "bg-mint/10", warning: "bg-amber/10", danger: "bg-signal/10" };
export const ToneBadge = ({ className, tone = "neutral", ...props }: ComponentProps<"span"> & { readonly tone?: StatusTone }) => <span className={cn("inline-flex h-[17px] items-center gap-1 rounded-sm border border-current/40 px-1 font-mono text-[11px] leading-none [&_svg]:size-3", TONE_INK[tone], TONE_FILL[tone], className)} {...props} />;
