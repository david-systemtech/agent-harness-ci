import type { ComponentProps } from "react";
import { classes } from "./classes.js";

/** How a button reads: the one action that acts, a quiet one, or one that removes or stops. */
export type ButtonTone = "primary" | "quiet" | "danger";

const TONES: Readonly<Record<ButtonTone, string>> = {
  primary: "bg-beam text-beam-ink hover:bg-beam-dim",
  quiet: "text-ink hover:bg-wash",
  danger: "bg-signal text-signal-ink",
};

export type ButtonProps = ComponentProps<"button"> & { readonly tone?: ButtonTone };

/** A button: `type="button"` unless told otherwise, so it never submits a form by accident. */
export const Button = ({ tone = "quiet", type = "button", className, ...props }: ButtonProps) => (
  <button
    type={type}
    className={classes(
      "inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-beam disabled:pointer-events-none disabled:text-ink-faint",
      TONES[tone],
      className,
    )}
    {...props}
  />
);
