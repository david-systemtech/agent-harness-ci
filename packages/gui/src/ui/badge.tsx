import type { ComponentProps } from "react";
import type { ButtonVariant } from "./button.js";
import { cn } from "./classes.js";

const VARIANTS: Readonly<Record<ButtonVariant, string>> = {
  default: "bg-beam text-beam-ink", secondary: "bg-raised text-ink", destructive: "bg-signal/10 text-signal dark:bg-signal/20",
  outline: "border-hairline text-ink", ghost: "text-ink", link: "text-beam-text underline-offset-4",
};
export const Badge = ({ className, variant = "default", ...props }: ComponentProps<"span"> & { readonly variant?: ButtonVariant }) => <span className={cn("inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-4xl border border-transparent px-2 text-xs font-medium whitespace-nowrap [&_svg]:size-3", VARIANTS[variant], className)} {...props} />;
export type StatusTone = "neutral" | "info" | "thinking" | "success" | "warning" | "danger";
export const TONE_INK: Readonly<Record<StatusTone, string>> = { neutral: "text-ink-muted", info: "text-cyan", thinking: "text-sage", success: "text-mint", warning: "text-amber", danger: "text-signal" };
export const ToneBadge = ({ className, tone = "neutral", ...props }: ComponentProps<"span"> & { readonly tone?: StatusTone }) => <span className={cn("inline-flex h-[1.0625rem] items-center gap-1 rounded-sm border border-current/30 px-1 text-[0.6875rem] leading-none [&_svg]:size-3", TONE_INK[tone], className)} {...props} />;
