import { ArrowRight, type LucideIcon } from "lucide-react";
import { Button, type ButtonProps } from "./button.js";
import { Tooltip, useKeyLegend } from "./tooltip.js";

/** Labelled dialog actions share icons and keyboard hints without changing their button semantics. */
export const DialogAction = ({ icon: Icon = ArrowRight, keys = "Enter / Space", children, ...props }: ButtonProps & { readonly icon?: LucideIcon; readonly keys?: string }) => {
  const label = props["aria-label"] ?? children;
  const action = <Button {...props}><Icon aria-hidden="true" data-icon="inline-start" />{children}</Button>;
  const disabledLabel = [typeof label === "string" ? label : undefined, props.title].filter(Boolean).join(" · ");
  const legend = useKeyLegend(keys);
  return <Tooltip content={<>{label}{legend !== undefined && ` · ${legend}`}{props.disabled && props.title ? ` · ${props.title}` : ""}</>}>
    {props.disabled && props.title ? <span role="group" tabIndex={0} aria-label={disabledLabel} className="inline-flex rounded-lg focus-visible:outline-2 focus-visible:outline-beam">{action}</span> : action}
  </Tooltip>;
};
