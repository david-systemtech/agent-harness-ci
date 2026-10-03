import { BookOpen, PanelsTopLeft, FileDiff, Files, ListTodo } from "lucide-react";
import { focusedPane } from "../grid/layout.js";
import type { PaneSession } from "../presentation.js";
import { MenuItem, Tooltip } from "../ui/index.js";
import { useObservable, usePresentation, useRuntime } from "../window-context.js";
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

const ItemsFor = ({ session }: { readonly session: PaneSession }) => {
  const runtime = useRuntime();
  useObservable(runtime.projections.environments);
  const [column, change] = useSideColumn(session);
  return <>
    {ITEMS.map(({ pane, Icon }) => {
      const capability = paneCapability(runtime, session.environmentId, pane);
      const absent = capability.status === "absent" ? capability.message : undefined;
      const label = PANES[pane].label;
      return <Tooltip key={pane} content={[label, absent].filter(Boolean).join(" · ")}>
        <MenuItem aria-label={label} disabled={absent !== undefined} onSelect={() => change((held) => showPane(held, pane))}>
          <Icon aria-hidden="true" /><span>{label}{absent !== undefined && <span className="block text-xs text-ink-faint">{absent}</span>}</span>
        </MenuItem>
      </Tooltip>;
    })}
    {column.open.length > 0 && <Tooltip content={column.hidden ? "Show the side column" : "Hide the side column"}>
      <MenuItem onSelect={() => change((held) => hideColumn(held, !held.hidden))}><Files aria-hidden="true" />{column.hidden ? "Show the side column" : "Hide the side column"}</MenuItem>
    </Tooltip>}
  </>;
};
