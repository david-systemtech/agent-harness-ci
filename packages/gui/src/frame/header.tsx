import { PRODUCT_NAME } from "@agent-harness/contracts";
import { EnvironmentBadge } from "../connections/environment-badge.js";
import { GridLine } from "../grid/grid.js";
import { focusedPane } from "../grid/layout.js";
import { SplitActions } from "../grid/split-actions.js";
import { SetupLine } from "../setup/setup-line.js";
import { SidePanesMenu } from "../side-column/side-panes-menu.js";
import { TerminalAction } from "../terminal/terminal-action.js";
import { useObservable, usePresentation, useRuntime } from "../window-context.js";

/**
 * The focused pane's environment: its name, and its icon in its colour
 * (docs/specs/gui.md, "The window and the sidebar"); nothing while the pane
 * shows no session, or one of an environment no longer listed.
 */
const FocusedEnvironment = () => {
  const environments = useObservable(useRuntime().projections.environments);
  const [layout] = usePresentation("paneLayout");
  const view = environments.find((environment) => environment.environmentId === focusedPane(layout).session?.environmentId);
  return view === undefined ? null : <EnvironmentBadge view={view} />;
};

/**
 * The window's header, across its top (docs/specs/gui.md, "The window and
 * the sidebar"): the product, the focused pane's environment and its
 * actions, the split actions with the grid's line, and the Set up line
 * while a step on the home environment needs attention.
 */
export const Header = () => (
  <header className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-panel px-3">
    <span className="pr-2 text-sm font-semibold text-ink">{PRODUCT_NAME}</span>
    <FocusedEnvironment />
    <TerminalAction />
    <SidePanesMenu />
    <SplitActions />
    <GridLine />
    <span className="ml-auto">
      <SetupLine />
    </span>
  </header>
);
