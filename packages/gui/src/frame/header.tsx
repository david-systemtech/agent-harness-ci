import { PRODUCT_NAME } from "@agent-harness/contracts";

/** The window's header, across its top (docs/specs/gui.md, "The window and the sidebar"). */
export const Header = () => (
  <header className="flex h-10 shrink-0 items-center border-b border-line bg-panel px-3">
    <span className="text-sm font-semibold text-ink">{PRODUCT_NAME}</span>
  </header>
);
