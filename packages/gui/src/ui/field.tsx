import { cloneElement, isValidElement, useId, type ReactNode } from "react";
import { cn } from "./classes.js";

export interface FieldProps {
  readonly label: string;
  readonly children: ReactNode;
  readonly description?: string;
  readonly error?: string;
  readonly className?: string;
}

/** The label names its control; help and errors describe it without lengthening its name. */
export const Field = ({ label, children, description, error, className }: FieldProps) => {
  const id = useId();
  const control = isValidElement<{ id?: string; "aria-describedby"?: string }>(children) ? children : undefined;
  const controlId = control?.props.id ?? id;
  const describedBy = [control?.props["aria-describedby"], description !== undefined && `${id}-help`, error !== undefined && `${id}-error`].filter(Boolean).join(" ");
  return <div className={cn("flex flex-col gap-2 text-sm text-ink", className)}>
    <label htmlFor={controlId} className="font-medium">{label}</label>
    {control === undefined ? children : cloneElement(control, { id: controlId, ...(describedBy === "" ? {} : { "aria-describedby": describedBy }) })}
    {description !== undefined && <p id={`${id}-help`} className="text-xs text-ink-muted">{description}</p>}
    {error !== undefined && <p id={`${id}-error`} className="text-xs text-signal">{error}</p>}
  </div>;
};
