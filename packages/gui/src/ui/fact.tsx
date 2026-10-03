import type { ReactNode } from "react";

/** One fact of a card's list of terms: its name and what the card holds of it; nothing for a fact it holds none of (null). */
export const Fact = ({ name, children }: { readonly name: string; readonly children: ReactNode }) =>
  children === null ? null : (
    <>
      <dt className="py-[3px] text-[0.6875rem] leading-4 font-medium text-ink-faint">{name}</dt>
      <dd className="min-w-0 py-[3px] font-mono break-words text-ink">{children}</dd>
    </>
  );
