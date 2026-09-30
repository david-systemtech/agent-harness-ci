import { useId, type ReactNode } from "react";

/** A part of a row's pane: a region named by its heading, such as the Permissions pane's settings, denylist and review. */
export const Part = ({ title, children }: { readonly title: string; readonly children: ReactNode }) => {
  const heading = useId();
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-3">
      <h3 id={heading} className="text-sm font-semibold text-ink">
        {title}
      </h3>
      {children}
    </section>
  );
};
