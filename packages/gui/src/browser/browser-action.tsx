import { focusedPane } from "../grid/layout.js";
import { useKeyAction } from "../keys/key-dispatch.js";
import type { PaneSession } from "../presentation.js";
import { hideColumn, showPane, useSideColumn } from "../side-column/column.js";
import { paneCapability } from "../side-column/panes.js";
import { useObservable, usePresentation, useRuntime, useShell } from "../window-context.js";

/** The header and Mod+Shift+B toggle the focused session's browser without closing it. */
export const BrowserAction = () => {
  const [layout] = usePresentation("paneLayout");
  const { session } = focusedPane(layout);
  return session === null ? null : <ActionFor session={session} />;
};
const ActionFor = ({ session }: { readonly session: PaneSession }) => {
  const [column, change] = useSideColumn(session);
  const runtime = useRuntime();
  useObservable(runtime.projections.environments);
  const shell = useShell();
  const answer = paneCapability(runtime, session.environmentId, "browser");
  const capability = answer.status === "absent" && answer.reason === "no-shell" && shell === undefined
    ? { ...answer, message: "The embedded browser requires the desktop app. Use Environment browser in the session status line to choose a browser or Open page." }
    : answer;
  const onScreen = column.shown === "browser" && !column.hidden;
  const toggle = () => {
    if (capability.status === "absent") return false;
    change((held) => (onScreen ? hideColumn(held, true) : showPane(held, "browser")));
  };
  useKeyAction("app.browser.toggle", toggle, capability);
  return null;
};
