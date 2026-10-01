import { focusedPane } from "../grid/layout.js";
import { useKeyAction } from "../keys/key-dispatch.js";
import type { PaneSession } from "../presentation.js";
import { hideColumn, showPane, useSideColumn } from "../side-column/column.js";
import { paneCapability } from "../side-column/panes.js";
import { Button, Tooltip } from "../ui/index.js";
import { usePresentation, useRuntime } from "../window-context.js";

/** The header and Mod+Shift+B toggle the focused session's browser without closing it. */
export const BrowserAction = () => {
  const [layout] = usePresentation("paneLayout");
  const { session } = focusedPane(layout);
  return session === null ? null : <ActionFor session={session} />;
};
const ActionFor = ({ session }: { readonly session: PaneSession }) => {
  const [column, change] = useSideColumn(session);
  const capability = paneCapability(useRuntime(), session.environmentId, "browser");
  const onScreen = column.shown === "browser" && !column.hidden;
  const toggle = () => {
    if (capability.status === "absent") return false;
    change((held) => (onScreen ? hideColumn(held, true) : showPane(held, "browser")));
  };
  useKeyAction("app.browser.toggle", toggle, capability);
  const button = (
    <Button aria-pressed={onScreen} disabled={capability.status === "absent"} className="h-7 px-2 text-xs" onClick={toggle}>
      Browser
    </Button>
  );
  return capability.status === "absent" ? <Tooltip content={capability.message}>{button}</Tooltip> : button;
};
