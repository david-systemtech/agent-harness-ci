import { PRODUCT_NAME } from "@agent-harness/contracts";
import { EnvironmentBadge } from "../connections/environment-badge.js";
import { SetupLine } from "../setup/setup-line.js";
import { SidePanesMenu } from "../side-column/side-panes-menu.js";
import { TerminalAction } from "../terminal/terminal-action.js";
import { useObservable, usePresentation, useRuntime } from "../window-context.js";

/**
 * The focused pane's environment: its name, and its icon in its colour
 * (docs/specs/gui.md, "The window and the sidebar"); nothing while the pane
 * shows no session.
 */
const FocusedEnvironment = () => {
  const environments = useObservable(useRuntime().projections.environments);
  const [layout] = usePresentation("paneLayout");
  const environmentId = layout.session?.environmentId;
  if (environmentId === undefined) return null;
  return <EnvironmentBadge view={environments.find((view) => view.environmentId === environmentId)} />;
};

/**
 * The window's header, across its top (docs/specs/gui.md, "The window and
 * the sidebar"): the product, the focused pane's environment and its
 * actions, and the Set up line while a step on the home environment needs
 * attention.
 */
export const Header = () => (
  <header className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-panel px-3">
    <span className="pr-2 text-sm font-semibold text-ink">{PRODUCT_NAME}</span>
    <FocusedEnvironment />
    <TerminalAction />
    <SidePanesMenu />
    <span className="ml-auto">
      <SetupLine />
    </span>
  </header>
);
