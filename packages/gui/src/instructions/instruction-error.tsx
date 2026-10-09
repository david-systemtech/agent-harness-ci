import type { ReactNode } from "react";

/** A refused change or a read that failed: text plus colour, announced as an error with a hidden "Error: " prefix. */
export const InstructionError = ({ children }: { readonly children: ReactNode }) => (
  <p role="alert" className="text-sm text-signal">
    <span className="sr-only">Error: </span>
    {children}
  </p>
);
