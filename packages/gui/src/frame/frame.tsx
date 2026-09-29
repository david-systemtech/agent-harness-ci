import type { Layout, LayoutChangedMeta } from "react-resizable-panels";
import { Group, Panel, Separator } from "react-resizable-panels";
import { SettingsView } from "../settings/settings-view.js";
import { useSettings } from "../settings/settings-window.js";
import { TerminalPanesProvider } from "../terminal/terminal-panes.js";
import { usePresentation } from "../window-context.js";
import { Header } from "./header.js";
import { SessionPaneRegion } from "./session-pane-region.js";
import { SidebarRegion } from "./sidebar-region.js";

/** The sidebar's width before it is first moved, and the least and most it takes, in pixels (chosen defaults). */
const SIDEBAR_PRESET = 280;
const SIDEBAR_LEAST = 200;
const SIDEBAR_MOST = 560;

/** The layout's names for the two regions a divider parts. */
const SIDEBAR = "sidebar";
const SESSION_PANES = "session-panes";

/**
 * The window's frame (docs/specs/gui.md, "The window and the sidebar"): the
 * header across the top, and below it the sidebar region beside the session
 * pane region, parted by a divider that resizes the sidebar. Where the
 * divider is left is presentation (`sidebarWidth`), kept as the sidebar's
 * share of the window; the sidebar keeps its width in pixels as the window
 * is resized. It holds the window's terminal panes, which the header and
 * every session pane ask (#409). While Settings is open it takes the window
 * below the header in place of the sidebar and the session panes.
 */
export const Frame = () => {
  const [sidebarWidth, setSidebarWidth] = usePresentation("sidebarWidth");
  const keep = (layout: Layout, { isUserInteraction }: LayoutChangedMeta) => {
    const share = layout[SIDEBAR];
    if (isUserInteraction && share !== undefined) setSidebarWidth(share);
  };
  const { shown } = useSettings();
  return (
    <TerminalPanesProvider>
      <div className="flex h-dvh flex-col bg-abyss text-ink">
        <Header />
        {shown ? (
          <SettingsView />
        ) : (
          <Group className="min-h-0 flex-1" onLayoutChanged={keep}>
            <Panel
              id={SIDEBAR}
              defaultSize={sidebarWidth === null ? SIDEBAR_PRESET : `${sidebarWidth}%`}
              minSize={SIDEBAR_LEAST}
              maxSize={SIDEBAR_MOST}
              groupResizeBehavior="preserve-pixel-size"
            >
              <SidebarRegion />
            </Panel>
            <Separator aria-label="Resize the sidebar" className="w-px bg-line outline-none hover:bg-beam focus-visible:bg-beam" />
            <Panel id={SESSION_PANES}>
              <SessionPaneRegion />
            </Panel>
          </Group>
        )}
      </div>
    </TerminalPanesProvider>
  );
};
