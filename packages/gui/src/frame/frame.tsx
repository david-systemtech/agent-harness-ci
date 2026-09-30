import type { Layout, LayoutChangedMeta } from "react-resizable-panels";
import { Group, Panel, Separator } from "react-resizable-panels";
import { PaneGridProvider } from "../grid/grid.js";
import { useKeyAction } from "../keys/key-dispatch.js";
import { NewSessionSurfaces } from "../new-session/surfaces.js";
import { SettingsView } from "../settings/settings-view.js";
import { useSettings } from "../settings/settings-window.js";
import { ChecklistView } from "../setup/checklist-view.js";
import { useChecklist } from "../setup/checklist-window.js";
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
 * is resized. Whether the sidebar is shown is presentation too
 * (`sidebarShown`), and `app.sidebar.toggle` (Mod+B) hides and shows it,
 * the session pane region taking the window's width while it is hidden.
 * It holds the window's terminal panes, which the header and
 * every session pane ask (#409), the pane grid's line, which the header
 * draws and the grid's gestures say (#407), and what the new-session
 * surfaces keep beside the layout (#420). While Settings is open it takes
 * the window below the header in place of the sidebar and the session panes;
 * while the full checklist is open (Set up on first launch) it takes the
 * whole window.
 */
export const Frame = () => {
  const [sidebarWidth, setSidebarWidth] = usePresentation("sidebarWidth");
  const [sidebarShown, setSidebarShown] = usePresentation("sidebarShown");
  useKeyAction("app.sidebar.toggle", () => setSidebarShown((shown) => !shown));
  const keep = (layout: Layout, { isUserInteraction }: LayoutChangedMeta) => {
    const share = layout[SIDEBAR];
    if (isUserInteraction && share !== undefined) setSidebarWidth(share);
  };
  const { shown } = useSettings();
  const checklist = useChecklist();
  return (
    <TerminalPanesProvider>
      <PaneGridProvider>
        <NewSessionSurfaces>
          {checklist.shown ? (
            <ChecklistView />
          ) : (
            <div className="flex h-dvh flex-col bg-abyss text-ink">
              <Header />
              {shown ? (
                <SettingsView />
              ) : (
                <Group className="min-h-0 flex-1" onLayoutChanged={keep}>
                  {sidebarShown && (
                    <>
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
                    </>
                  )}
                  <Panel id={SESSION_PANES}>
                    <SessionPaneRegion />
                  </Panel>
                </Group>
              )}
            </div>
          )}
        </NewSessionSurfaces>
      </PaneGridProvider>
    </TerminalPanesProvider>
  );
};
