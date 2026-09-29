import { createContext, use, useState, type ReactNode } from "react";

/** The pane's line, and the setter that says another (undefined clears it). */
type Line = readonly [string | undefined, (line: string | undefined) => void];

const LineContext = createContext<Line | null>(null);

/**
 * A session pane's one line under its composer (docs/specs/gui.md, "A
 * session pane"): what was refused or could not be done, said once, the
 * latest over the one before. The composer draws it; whatever acts on the
 * session from the pane (a send, a Stop, a queued message's Read now or
 * Edit) says through it, so a refusal is one line wherever it was asked.
 */
export const PaneLine = ({ children }: { readonly children: ReactNode }) => {
  const line = useState<string | undefined>(undefined);
  return <LineContext value={line}>{children}</LineContext>;
};

/** The pane's line and the setter that says another. */
export const usePaneLine = (): Line => {
  const line = use(LineContext);
  if (line === null) throw new Error("The pane's line is said inside a session pane, which holds it.");
  return line;
};
