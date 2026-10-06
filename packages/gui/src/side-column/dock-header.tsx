import { ChevronRight, CirclePlus, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CapabilityAnswer } from "@agent-harness/client-runtime";
import type { SideColumn, SidePane } from "../presentation.js";
import { Button, IconButton, Menu, MenuContent, MenuItem, MenuTrigger, Tooltip } from "../ui/index.js";
import { classes } from "../ui/classes.js";
import { DOCK_PANES, PANES } from "./panes.js";

interface DockProps {
  readonly dockId: string;
  readonly column: SideColumn;
  capability(pane: SidePane): CapabilityAnswer;
  show(pane: SidePane): void;
  close(pane: SidePane): void;
  newTerminal(): void;
}

/** Icon tabs keep focus independent of selection; Enter chooses the focused pane. */
export const DockRail = ({ dockId, column, capability, show, close, newTerminal }: DockProps) => {
  const [focused, focus] = useState<SidePane | null>(null);
  const tabs = useRef(new Map<SidePane, HTMLButtonElement>());
  const open = DOCK_PANES.filter((pane) => column.open.includes(pane));
  const terminalCapability = capability("terminal");
  useEffect(() => {
    if (focused !== null && !column.open.includes(focused)) {
      focus(column.shown);
      if (column.shown !== null) tabs.current.get(column.shown)?.focus();
    }
  }, [column.open, column.shown, focused]);
  const stop = focused !== null && open.includes(focused) ? focused : column.shown;
  return <div data-dock-rail className="flex w-[40px] shrink-0 flex-col items-center gap-[4px] border-r border-hairline py-[6px]">
    <div role="tablist" aria-label="Open panes" aria-orientation="vertical" className="flex min-h-0 flex-1 flex-col gap-[4px] overflow-y-auto">
      {open.map((pane, index) => {
        const { label, icon: Icon } = PANES[pane];
        const answer = capability(pane);
        return <div key={pane} className="group relative size-[28px] shrink-0">
          <Tooltip content={`${label}${answer.status === "absent" ? ` · ${answer.message}` : ""}`} keys="↑/↓, Home/End; Enter to show; middle-click to close">
            <Button role="tab" aria-label={label} aria-selected={pane === column.shown} aria-controls={`${dockId}-${pane}`} aria-disabled={answer.status === "absent" ? true : undefined} tabIndex={pane === stop ? 0 : -1}
              ref={(element) => { if (element) tabs.current.set(pane, element); else tabs.current.delete(pane); }}
              className={classes("size-[28px] rounded-md p-0 text-ink-faint hover:bg-wash [&_svg]:size-[24px]", pane === column.shown && "bg-wash-strong text-ink", answer.status === "absent" && "opacity-50")}
              onFocus={() => focus(pane)} onClick={() => show(pane)}
              onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); close(pane); } }}
              onKeyDown={(event) => {
                const next = event.key === "Home" ? 0 : event.key === "End" ? open.length - 1
                  : ["ArrowDown", "ArrowRight"].includes(event.key) ? (index + 1) % open.length
                  : ["ArrowUp", "ArrowLeft"].includes(event.key) ? (index + open.length - 1) % open.length : null;
                if (next !== null) { event.preventDefault(); tabs.current.get(open[next]!)?.focus(); }
              }}>
              <Icon aria-hidden="true" />
            </Button>
          </Tooltip>
          <IconButton label={`Close ${label}`} keys="Enter / Space; middle click" tabIndex={pane === stop ? 0 : -1} onClick={() => close(pane)}
            className="absolute right-0 top-0 size-[14px] rounded-sm bg-panel p-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [&_svg]:size-[10px]">
            <X aria-hidden="true" />
          </IconButton>
        </div>;
      })}
    </div>
    <Menu>
      <Tooltip content="Open a side pane" keys="Enter / Space; arrows to choose">
        <MenuTrigger asChild><Button aria-label="Open a side pane" className="size-[28px] rounded-md p-0"><CirclePlus aria-hidden="true" /></Button></MenuTrigger>
      </Tooltip>
      <MenuContent side="left">
        {DOCK_PANES.map((pane) => {
          const { label, icon: Icon } = PANES[pane];
          const answer = capability(pane);
          return <MenuItem key={pane} onSelect={() => show(pane)}>
            <Icon aria-hidden="true" className="size-4" /><span>{label}</span>
            {answer.status === "absent" && <span className="max-w-56 text-xs text-ink-faint">{answer.message}</span>}
          </MenuItem>;
        })}
      </MenuContent>
    </Menu>
    <IconButton label="New terminal" keys="Enter / Space" {...(terminalCapability.status === "absent" && { disabledReason: terminalCapability.message })} onClick={newTerminal} className="size-[28px] rounded-md p-0"><Plus aria-hidden="true" /></IconButton>
  </div>;
};

/** Every pane has the same fixed-height chrome, including capability explanations. */
export const DockHeader = ({ pane, hide, close }: { readonly pane: SidePane; hide(): void; close?(): void }) => {
  const { label, icon: Icon } = PANES[pane];
  return <div role="group" aria-label={`${label} pane header`} data-dock-header className="flex h-[30px] shrink-0 items-center gap-1.5 border-b border-hairline px-2 text-xs text-ink-muted">
    <Icon aria-hidden="true" className="size-4" /><span className="min-w-0 flex-1 truncate">{label}</span>
    {close !== undefined && <IconButton label={`Close ${label} pane`} keys="Enter / Space" onClick={close} className="dock-close-pane rounded-md p-0"><X aria-hidden="true" /></IconButton>}
    <IconButton label="Hide the side column" keys="Enter / Space" onClick={hide} className="size-[24px] rounded-md p-0"><ChevronRight aria-hidden="true" /></IconButton>
  </div>;
};
