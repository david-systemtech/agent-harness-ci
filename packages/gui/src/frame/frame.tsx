import { PaneGridProvider } from "../grid/grid.js";
import { useKeyAction } from "../keys/key-dispatch.js";
import { NewSessionSurfaces } from "../new-session/surfaces.js";
import { SettingsView } from "../settings/settings-view.js";
import { useSettings } from "../settings/settings-window.js";
import { ChecklistView } from "../setup/checklist-view.js";
import { useChecklist } from "../setup/checklist-window.js";
import { BrowserPanesProvider } from "../browser/browser-panes.js";
import { TerminalPanesProvider } from "../terminal/terminal-panes.js";
import { usePresentation } from "../window-context.js";
import { Header } from "./header.js";
import { SessionPaneRegion } from "./session-pane-region.js";
import { SidebarRegion } from "./sidebar-region.js";

/**
 * The window's frame (docs/specs/gui.md, "The window and the sidebar"): the
 * header across the top, and below it the sidebar region beside the session
 * pane region, parted by a divider that resizes the sidebar. Where the
 * divider is left is presentation (`sidebarWidth`), kept as the sidebar's
 * width in pixels; the sidebar keeps that width as the window
 * is resized. Whether the sidebar is shown is presentation too
 * (`sidebarShown`), and `app.sidebar.toggle` (Mod+B) hides and shows it,
 * the session pane region taking the window's width while it is hidden.
 * It holds the window's terminal panes, which the header and
 * every session pane ask (#409), the pane grid's line, which the header
 * draws and the grid's gestures say (#407), and what the new-session
 * surfaces keep beside the layout (#420). Settings overlays the mounted sidebar and session panes;
 * while the full checklist is open (Set up on first launch) it takes the
 * whole window.
 */
export const Frame = () => {
  const [sidebarShown, setSidebarShown] = usePresentation("sidebarShown");
  useKeyAction("app.sidebar.toggle", () => setSidebarShown((shown) => !shown));
  const { shown } = useSettings();
  const checklist = useChecklist();
  return (
    <BrowserPanesProvider>
      <TerminalPanesProvider>
        <PaneGridProvider>
          <NewSessionSurfaces>
            {checklist.shown ? (
              <ChecklistView />
            ) : (
              <div className="flex h-dvh flex-col bg-abyss text-ink">
                <Header />
                <div data-window-body className="flex min-h-0 min-w-0 flex-1 gap-[7px] p-[7px]">
                  {sidebarShown && <SidebarRegion />}
                  <div data-session-card className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border border-hairline bg-panel">
                    <SessionPaneRegion />
                  </div>
                </div>
                {shown && <SettingsView />}
              </div>
            )}
          </NewSessionSurfaces>
        </PaneGridProvider>
      </TerminalPanesProvider>
    </BrowserPanesProvider>
  );
};
