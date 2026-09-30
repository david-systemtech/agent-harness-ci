import { focusedPane } from "../grid/layout.js";
import { useKeyAction } from "../keys/key-dispatch.js";
import type { PaneSession } from "../presentation.js";
import { hideColumn, showPane, useSideColumn } from "../side-column/column.js";
import { Button } from "../ui/index.js";
import { usePresentation } from "../window-context.js";
import { useTerminalPanes } from "./terminal-panes.js";

/**
 * The header's terminal action and `app.terminal.toggle` (Mod+J)
 * (docs/specs/gui.md, "The window and the sidebar": the header holds the
 * focused pane's terminal action; #409): shows the focused pane's Terminal
 * pane, opening it when it is not open, with the keys; pressed while it is on
 * screen, hides the side column, which leaves the terminal running. Not
 * drawn, and no key wired, while no session is open.
 */
export const TerminalAction = () => {
  const [layout] = usePresentation("paneLayout");
  const { session } = focusedPane(layout);
  return session === null ? null : <ActionFor session={session} />;
};

const ActionFor = ({ session }: { readonly session: PaneSession }) => {
  const [column, change] = useSideColumn(session);
  const terminals = useTerminalPanes();
  const onScreen = column.shown === "terminal" && !column.hidden;
  const toggle = () => {
    if (onScreen) return change((held) => hideColumn(held, true));
    change((held) => showPane(held, "terminal"));
    terminals.ask(session, { kind: "keys" });
  };
  useKeyAction("app.terminal.toggle", toggle);
  return (
    <Button aria-pressed={onScreen} className="ml-auto h-7 px-2 text-xs" onClick={toggle}>
      Terminal
    </Button>
  );
};
