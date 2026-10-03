import type { CapabilityAnswer } from "@agent-harness/client-runtime";
import { focusedPane } from "../grid/layout.js";
import { useKeyAction } from "../keys/key-dispatch.js";
import type { PaneSession } from "../presentation.js";
import { paneCapability } from "../side-column/panes.js";
import { hideColumn, showPane, useSideColumn } from "../side-column/column.js";
import { useObservable, usePresentation, useRuntime } from "../window-context.js";
import { useTerminalPanes } from "./terminal-panes.js";

const PRESENT: CapabilityAnswer = { status: "present" };

/**
 * The header's terminal action and `app.terminal.toggle` (Mod+J)
 * (docs/specs/gui.md, "The window and the sidebar": the header holds the
 * focused pane's terminal action; #409): shows the focused pane's Terminal
 * pane, opening it when it is not open, with the keys; pressed while it is on
 * screen, hides the side column, which leaves the terminal running. Not
 * wired while no session is open. The More menu draws the action; a retained
 * terminal can be hidden and shown while its environment is unreachable.
 */
export const TerminalAction = () => {
  const [layout] = usePresentation("paneLayout");
  const { session } = focusedPane(layout);
  return session === null ? null : <ActionFor session={session} />;
};

const ActionFor = ({ session }: { readonly session: PaneSession }) => {
  const [column, change] = useSideColumn(session);
  const terminals = useTerminalPanes();
  const runtime = useRuntime();
  useObservable(runtime.projections.environments);
  const capability = column.open.includes("terminal") ? PRESENT : paneCapability(runtime, session.environmentId, "terminal");
  const onScreen = column.shown === "terminal" && !column.hidden;
  const toggle = () => {
    if (capability.status === "absent") return false;
    if (onScreen) return change((held) => hideColumn(held, true));
    change((held) => showPane(held, "terminal"));
    terminals.ask(session, { kind: "keys" });
  };
  useKeyAction("app.terminal.toggle", toggle, capability);
  return null;
};
