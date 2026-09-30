import type { ReactNode } from "react";

/** One fact of a card's list of terms: its name and what the card holds of it; nothing for a fact it holds none of (null). */
export const Fact = ({ name, children }: { readonly name: string; readonly children: ReactNode }) =>
  children === null ? null : (
    <>
      <dt className="text-ink-muted">{name}</dt>
      <dd className="min-w-0 break-words text-ink">{children}</dd>
    </>
  );
