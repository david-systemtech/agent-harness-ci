import { PRODUCT_NAME } from "@agent-harness/contracts";
import { SetupLine } from "../setup/setup-line.js";
import { SidePanesMenu } from "../side-column/side-panes-menu.js";
import { TerminalAction } from "../terminal/terminal-action.js";

/**
 * The window's header, across its top (docs/specs/gui.md, "The window and
 * the sidebar"): the product, the focused pane's actions, and the Set up
 * line while a step on the home environment needs attention.
 */
export const Header = () => (
  <header className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-panel px-3">
    <span className="text-sm font-semibold text-ink">{PRODUCT_NAME}</span>
    <TerminalAction />
    <SidePanesMenu />
    <span className="ml-auto">
      <SetupLine />
    </span>
  </header>
);
