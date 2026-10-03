import type { ComponentProps } from "react";
import { cn } from "./classes.js";
import { Tooltip } from "./tooltip.js";

/** Compatibility for surfaces migrating to the window's six button variants. */
export type ButtonTone = "primary" | "quiet" | "warning" | "danger";
export type ButtonVariant = "default" | "outline" | "secondary" | "ghost" | "destructive" | "link";
export type ButtonSize = "default" | "xs" | "sm" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg";

const VARIANTS: Readonly<Record<ButtonVariant, string>> = {
  default: "bg-beam text-beam-ink hover:bg-beam-dim",
  outline: "border-hairline-strong bg-panel text-ink hover:bg-wash aria-expanded:bg-wash",
  secondary: "bg-raised text-ink hover:bg-wash-strong aria-expanded:bg-wash-strong",
  ghost: "text-ink hover:bg-wash aria-expanded:bg-wash",
  destructive: "bg-signal/10 text-signal hover:bg-signal/20 dark:bg-signal/20 dark:hover:bg-signal/30 focus-visible:ring-signal/20",
  link: "text-beam-text underline-offset-4 hover:underline",
};
const SIZES: Readonly<Record<ButtonSize, string>> = {
  default: "h-8 gap-1.5 px-2.5",
  xs: "h-6 gap-1 rounded-md px-2 text-xs [&_svg]:size-3",
  sm: "h-7 gap-1 rounded-md px-2.5 [&_svg]:size-3.5",
  lg: "h-9 gap-1.5 px-2.5",
  icon: "size-8",
  "icon-xs": "size-6 rounded-md [&_svg]:size-3",
  "icon-sm": "size-7 rounded-md [&_svg]:size-3.5",
  "icon-lg": "size-9",
};
const TONES: Readonly<Record<ButtonTone, ButtonVariant>> = { primary: "default", quiet: "ghost", warning: "ghost", danger: "destructive" };

export type ButtonProps = ComponentProps<"button"> & { readonly tone?: ButtonTone; readonly variant?: ButtonVariant; readonly size?: ButtonSize };

/** Buttons are safe inside forms; an explicit variant takes precedence over the tone alias. */
export const Button = ({ tone = "quiet", variant = TONES[tone], size = "default", type = "button", className, ...props }: ButtonProps) => (
  <button
    type={type}
    data-variant={variant}
    data-size={size}
    className={cn(
      "inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent text-sm font-medium whitespace-nowrap outline-none transition-colors select-none focus-visible:border-beam focus-visible:ring-3 focus-visible:ring-beam/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-signal aria-invalid:ring-3 aria-invalid:ring-signal/20 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
      VARIANTS[variant], SIZES[size], tone === "warning" && variant === "ghost" && "text-amber", className,
    )}
    {...props}
  />
);

export type IconButtonProps = Omit<ButtonProps, "aria-label"> & {
  readonly label: string;
  readonly keys?: string;
  readonly disabledReason?: string;
};

/** The disabled action's focusable wrapper keeps its explanation reachable by keyboard. */
export const IconButton = ({ label, keys, disabledReason, disabled, size = "icon", ...props }: IconButtonProps) => {
  const off = disabled === true || disabledReason !== undefined;
  const description = [label, keys, disabledReason].filter(Boolean).join(" · ");
  const action = <Button {...props} size={size} aria-label={label} disabled={off} />;
  return <Tooltip content={description}>{off ? <span tabIndex={0} aria-label={description} className="inline-flex rounded-lg focus-visible:outline-2 focus-visible:outline-beam">{action}</span> : action}</Tooltip>;
};
