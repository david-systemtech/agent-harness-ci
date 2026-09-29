import { SIDE_PANES, type PaneSession } from "../presentation.js";
import { Button, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "../ui/index.js";
import { useObservable, usePresentation, useRuntime } from "../window-context.js";
import { hideColumn, showPane, useSideColumn } from "./column.js";
import { PANES, paneCapability } from "./panes.js";

/**
 * The header's side panes menu (docs/specs/gui.md, "The window and the
 * sidebar": the header holds the focused pane's actions): each pane, opened
 * and shown in the focused pane's side column when chosen, dim with the
 * capability's line where the connection cannot call its method; and the
 * column hidden or shown again while a pane is open in it. Not drawn while
 * no session is open.
 */
export const SidePanesMenu = () => {
  const [layout] = usePresentation("paneLayout");
  return layout.session === null ? null : <MenuFor session={layout.session} />;
};

const MenuFor = ({ session }: { readonly session: PaneSession }) => {
  const runtime = useRuntime();
  // The connections' phases: each pane's capability is asked again whenever one moves.
  useObservable(runtime.projections.environments);
  const [column, change] = useSideColumn(session);
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button className="ml-auto h-7 px-2 text-xs">Side panes</Button>
      </MenuTrigger>
      <MenuContent align="end">
        {SIDE_PANES.map((pane) => {
          const capability = paneCapability(runtime, session.environmentId, pane);
          const absent = capability.status === "absent" ? capability.message : undefined;
          return (
            <MenuItem key={pane} aria-disabled={absent === undefined ? undefined : true} onSelect={() => change((held) => showPane(held, pane))}>
              <span className="flex flex-col">
                <span className={absent === undefined ? undefined : "text-ink-faint"}>{PANES[pane].label}</span>
                {absent !== undefined && <span className="max-w-64 text-xs text-ink-faint">{absent}</span>}
              </span>
            </MenuItem>
          );
        })}
        {column.open.length > 0 && (
          <>
            <MenuSeparator />
            <MenuItem onSelect={() => change((held) => hideColumn(held, !held.hidden))}>{column.hidden ? "Show the side column" : "Hide the side column"}</MenuItem>
          </>
        )}
      </MenuContent>
    </Menu>
  );
};
