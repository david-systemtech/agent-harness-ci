import type { ReactNode } from "react";

/** A field of a form: its name over its control, which the label names. */
export const Field = ({ label, children }: { readonly label: string; readonly children: ReactNode }) => (
  <label className="flex flex-col gap-1 text-sm text-ink">
    {label}
    {children}
  </label>
);
