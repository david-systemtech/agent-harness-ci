import type { ComponentProps } from "react";
import { cn } from "./classes.js";
import { Tooltip, useKeyLegend } from "./tooltip.js";
import "./phone-overlays.css";

export type ButtonVariant = "default" | "outline" | "secondary" | "ghost" | "destructive" | "link";
export type ButtonSize = "default" | "xs" | "sm" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg";

const VARIANTS: Readonly<Record<ButtonVariant, string>> = {
  default: "bg-beam text-beam-ink hover:bg-beam-dim",
  outline: "border-hairline bg-abyss text-ink hover:bg-raised aria-expanded:bg-raised dark:border-hairline-strong dark:bg-hairline-strong/30 dark:hover:bg-hairline-strong/50",
  secondary: "bg-raised text-ink hover:bg-[color-mix(in_oklch,var(--raised),var(--ink)_5%)] aria-expanded:bg-raised",
  ghost: "text-ink-muted hover:bg-raised hover:text-ink aria-expanded:bg-raised aria-expanded:text-ink dark:hover:bg-raised/50",
  destructive: "bg-signal/10 text-signal hover:bg-signal/20 dark:bg-signal/20 dark:hover:bg-signal/30 focus-visible:ring-signal/20",
  link: "text-beam-text underline-offset-4 hover:underline",
};
const SIZES: Readonly<Record<ButtonSize, string>> = {
  default: "h-8 gap-1.5 px-2.5 has-data-[icon=inline-start]:pl-2 has-data-[icon=inline-end]:pr-2",
  xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs has-data-[icon=inline-start]:pl-1.5 has-data-[icon=inline-end]:pr-1.5 [&_svg]:size-3",
  sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] has-data-[icon=inline-start]:pl-1.5 has-data-[icon=inline-end]:pr-1.5 [&_svg]:size-3.5",
  lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-start]:pl-2 has-data-[icon=inline-end]:pr-2",
  icon: "size-8",
  "icon-xs": "size-6 rounded-md [&_svg]:size-3",
  "icon-sm": "size-7 rounded-md [&_svg]:size-3.5",
  "icon-lg": "size-9",
};

export type ButtonProps = ComponentProps<"button"> & { readonly variant?: ButtonVariant; readonly size?: ButtonSize };

/** Buttons are safe inside forms; callers choose one of the window's six variants. */
export const Button = ({ variant = "ghost", size = "default", type = "button", className, ...props }: ButtonProps) => (
  <button
    type={type}
    data-variant={variant}
    data-size={size}
    className={cn(
      "inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent text-sm font-medium whitespace-nowrap outline-none transition-colors select-none active:not-aria-[haspopup]:translate-y-px focus-visible:border-beam focus-visible:ring-3 focus-visible:ring-beam/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-signal aria-invalid:ring-3 aria-invalid:ring-signal/20 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
      VARIANTS[variant], SIZES[size], className,
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
export const IconButton = ({ label, keys, disabledReason, disabled, size = "icon-sm", className, ...props }: IconButtonProps) => {
  const off = disabled === true || disabledReason !== undefined;
  const legend = useKeyLegend(keys);
  const description = [label, legend, disabledReason].filter(Boolean).join(" · ");
  const action = <Button {...props} size={size} aria-label={label} disabled={off} className={cn(size === "icon-sm" && "[&_svg]:size-4", className)} />;
  return <Tooltip content={description}>{disabledReason !== undefined ? <span role="group" tabIndex={0} aria-label={description} className="inline-flex rounded-lg focus-visible:outline-2 focus-visible:outline-beam">{action}</span> : action}</Tooltip>;
};
