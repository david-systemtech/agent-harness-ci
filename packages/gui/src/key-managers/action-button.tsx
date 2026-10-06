import { useEffect, useRef, useState } from "react";
import type { FieldProps } from "../ui/field.js";
import { Settings2, type LucideIcon } from "lucide-react";
import { Button, Field, Tooltip, type ButtonProps } from "../ui/index.js";

/** Compact pane verbs expose their activation keys even when unavailable. */
export const ActionButton = ({ icon: Icon, label, children, ...props }: ButtonProps & { readonly icon: LucideIcon; readonly label: string }) => (
  <Tooltip content={label} keys="Enter / Space">
    <span className="inline-flex max-w-full" tabIndex={props.disabled ? 0 : undefined}>
      <Button size="sm" {...props}>
        <Icon aria-hidden="true" data-icon="inline-start" />
        {children}
      </Button>
    </span>
  </Tooltip>
);

/** Field hints follow keyboard focus without replacing the native label. */
export const AccessField = (props: FieldProps) => (
  <Tooltip content={props.label} keys="Tab to focus; type or use arrow keys">
    <div className="relative min-w-0 max-w-full">
      <Settings2 aria-hidden="true" className="pointer-events-none absolute top-0.5 left-0 size-3.5 text-ink-faint" />
      <Field {...props} className={`max-w-full text-xs [&_label>span]:pl-5 ${props.className ?? ""}`} />
    </div>
  </Tooltip>
);

/** Closing inline Add returns keyboard focus to its remounted opener. */
export const useInlineAdd = () => {
  const [adding, setAdding] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const wasAdding = useRef(false);
  useEffect(() => {
    if (!adding && wasAdding.current) trigger.current?.focus();
    wasAdding.current = adding;
  }, [adding]);
  return { adding, setAdding, trigger };
};
