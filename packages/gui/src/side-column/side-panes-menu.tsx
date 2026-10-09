import { useOpenPairing } from "../connections/pairing.js";
import { BookOpen, PanelRightClose, PanelRightOpen, PanelsTopLeft, FileDiff, Files, ListTodo } from "lucide-react";
import { focusedPane } from "../grid/layout.js";
import type { PaneSession } from "../presentation.js";
import { IconButton, MenuItem, Tooltip } from "../ui/index.js";
import { useObservable, usePresentation, useRuntime, useShell } from "../window-context.js";
import { hideColumn, showPane, useSideColumn } from "./column.js";
import { PANES, paneCapability } from "./panes.js";

const ITEMS = [
  { pane: "files", Icon: Files }, { pane: "diff", Icon: FileDiff },
  { pane: "documents", Icon: BookOpen }, { pane: "tasks", Icon: ListTodo },
  { pane: "preview", Icon: PanelsTopLeft },
] as const;

/** The focused session's dock entries in More, with unsupported actions kept discoverable. */
export const SidePaneMenuItems = () => {
  const [layout] = usePresentation("paneLayout");
  const { session } = focusedPane(layout);
  return session === null ? ITEMS.map(({ pane, Icon }) => <Tooltip key={pane} content={`${PANES[pane].label} · Open a session first.`}><MenuItem aria-label={PANES[pane].label} disabled><Icon aria-hidden="true" /><span>{PANES[pane].label}<span className="block text-xs text-ink-faint">Open a session first.</span></span></MenuItem></Tooltip>) : <ItemsFor session={session} />;
};

/**
 * A phone header's one-tap way back to the focused session's hidden sheet (#1960): it sits in the header's row
 * of controls, so it never covers the transcript as the pane's edge handle did. Drawn only while there is a pane to bring back.
 */
export const ShowSideColumn = ({ session }: { readonly session: PaneSession }) => {
  const [column, change] = useSideColumn(session);
  if (!column.hidden || column.shown === null) return null;
  return <IconButton data-dock-reopen label="Show the side column" keys="Enter / Space" onClick={() => change((held) => hideColumn(held, false))}><PanelRightOpen aria-hidden="true" /></IconButton>;
};

const ItemsFor =({ session }: { readonly session: PaneSession }) => {
  const runtime = useRuntime();
  const shell = useShell();
  const openPairing = useOpenPairing();
  useObservable(runtime.projections.environments);
  const [column, change] = useSideColumn(session);
  return <>
    {ITEMS.map(({ pane, Icon }) => {
      const capability = paneCapability(runtime, session.environmentId, pane);
      const limited = shell === undefined && capability.status === "absent" && capability.reason === "scope";
      const absent = limited ? "Unavailable · Give this phone full access" : capability.status === "absent" ? capability.message : undefined;
      const label = PANES[pane].label;
      return <Tooltip key={pane} content={[label, absent].filter(Boolean).join(" · ")}>
        <MenuItem aria-label={label} disabled={absent !== undefined && !limited} onSelect={() => limited ? openPairing({ rePair: session.environmentId, fullAccess: true }) : change((held) => showPane(held, pane))}>
          <Icon aria-hidden="true" /><span>{label}{absent !== undefined && <span className="block text-xs text-ink-faint">{absent}</span>}</span>
        </MenuItem>
      </Tooltip>;
    })}
    {column.open.length > 0 && <Tooltip content={column.hidden ? "Show the side column" : "Hide the side column"}>
      <MenuItem onSelect={() => change((held) => hideColumn(held, !held.hidden))}>{column.hidden ? <PanelRightOpen aria-hidden="true" /> : <PanelRightClose aria-hidden="true" />}{column.hidden ? "Show the side column" : "Hide the side column"}</MenuItem>
    </Tooltip>}
  </>;
};
