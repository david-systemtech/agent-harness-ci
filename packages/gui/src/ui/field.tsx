import { Fragment, cloneElement, isValidElement, useId, type ReactNode } from "react";
import { cn } from "./classes.js";

export interface FieldProps {
  readonly label: string;
  readonly children: ReactNode;
  readonly description?: string;
  readonly error?: string;
  readonly className?: string;
}

/** Help and errors describe the field group even when a composite child cannot forward props. */
export const Field = ({ label, children, description, error, className }: FieldProps) => {
  const id = useId();
  const control = isValidElement<{ id?: string; "aria-describedby"?: string }>(children) && children.type !== Fragment ? children : undefined;
  const controlId = control?.props.id ?? id;
  const feedback = [description !== undefined && `${id}-help`, error !== undefined && `${id}-error`].filter(Boolean).join(" ");
  const describedBy = [control?.props["aria-describedby"], feedback].filter(Boolean).join(" ");
  return <div role={feedback === "" ? undefined : "group"} aria-labelledby={feedback === "" ? undefined : `${id}-label`} aria-describedby={feedback || undefined} className={cn("flex flex-col gap-2 text-sm text-ink", className)}>
    <label className="flex flex-col gap-2">
      <span id={`${id}-label`} className="font-medium">{label}</span>
      {control === undefined ? children : cloneElement(control, { id: controlId, ...(describedBy === "" ? {} : { "aria-describedby": describedBy }) })}
    </label>
    {description !== undefined && <p id={`${id}-help`} className="text-sm text-ink-muted">{description}</p>}
    {error !== undefined && <p id={`${id}-error`} className="text-sm text-signal">{error}</p>}
  </div>;
};
