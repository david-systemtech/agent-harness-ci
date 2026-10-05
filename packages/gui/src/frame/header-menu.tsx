import { ZoomActions } from "./zoom-actions.js";
import { useOpenPairing } from "../connections/pairing.js";
import { focusedPane } from "../grid/layout.js";
import { usePresentation, useRuntime, useShell } from "../window-context.js";
import { usePhoneFrame } from "./phone-frame.js";
import { ThemeToggle } from "./theme-toggle.js";
import { SetupLine } from "../setup/setup-line.js";
import { RestartToUpdate } from "../updates/restart-to-update.js";
import { MenuShortcut } from "../ui/menu.js";
import { useRef, useState } from "react";
import type { KeyActionId } from "@agent-harness/contracts";
import { Columns2, Ellipsis, Globe, Link, Rows2, Terminal, ZoomIn, ZoomOut, RotateCcw } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { BrowserAction } from "../browser/browser-action.js";
import { GridLine } from "../grid/grid.js";
import { SplitActions } from "../grid/split-actions.js";
import { useEveryWiredAction, useFirstKey } from "../keys/key-dispatch.js";
import { HeaderNewSession, HeaderNewSessionItems } from "../new-session/control.js";
import { ParkedAsksButton } from "../parked-asks/parked-asks.js";
import { SidePaneMenuItems } from "../side-column/side-panes-menu.js";
import { TerminalAction } from "../terminal/terminal-action.js";
import { Button, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Tooltip } from "../ui/index.js";

/** Invoke the same actions as the keys and palette, retaining unavailable actions and reasons. */
const ActionItem = ({ id, label, icon: Icon, select }: { readonly id: KeyActionId; readonly label: string; readonly icon: LucideIcon; readonly select: (run: () => void) => void }) => {
  const actions = useEveryWiredAction();
  const action = actions.find((action) => action.id === id);
  const keys = useFirstKey(id);
  const shell = useShell();
  const openPairing = useOpenPairing();
  const [layout] = usePresentation("paneLayout");
  const session = focusedPane(layout).session;
  const runtime = useRuntime();
  const authority = session ? runtime.capability(session.environmentId, "terminals.open") : undefined;
  const limited = shell === undefined && id === "app.terminal.toggle" && action?.offer.status === "absent" && authority?.status === "absent" && authority.reason === "scope";
  const reason = limited ? "Terminal unavailable · Give this phone full access" : action === undefined ? "Open a session first." : action.offer.status === "absent" ? action.offer.message : undefined;
  return <Tooltip content={[label, keys, reason].filter(Boolean).join(" · ")}>
    <MenuItem aria-label={label} disabled={reason !== undefined && !limited} onSelect={() => { if (limited && session) select(() => openPairing({ rePair: session.environmentId, fullAccess: true })); else if (action !== undefined) select(() => action.run()); }}>
      <Icon aria-hidden="true" /><span>{label}{reason !== undefined && <span className="block text-xs text-ink-faint">{reason}</span>}</span><MenuShortcut>{keys}</MenuShortcut>
    </MenuItem>
  </Tooltip>;
};

/** Bindings live outside the dropdown so keys and palette entries survive its dismissal. */
export const HeaderMenu = ({ onPair }: { readonly onPair?: () => void }) => {
  const { narrow } = usePhoneFrame();
  const shell = useShell();
  const [open, setOpen] = useState(false);
  const afterClose = useRef<(() => void) | undefined>(undefined);
  const select = (run: () => void) => { afterClose.current = run; };
  return <>
  <ZoomActions /><TerminalAction /><BrowserAction /><SplitActions /><HeaderNewSession />
  <Menu modal={false} open={open} onOpenChange={setOpen}>
    <Tooltip content="More"><MenuTrigger asChild><Button aria-label="More" size="icon-sm"><Ellipsis aria-hidden="true" /></Button></MenuTrigger></Tooltip>
    <MenuContent align="end" className={narrow ? "phone-frame-menu w-72" : "w-60"} onCloseAutoFocus={(event) => {
      const run = afterClose.current;
      afterClose.current = undefined;
      if (run === undefined) return;
      event.preventDefault();
      run();
    }}>
      <ActionItem select={select} id="app.terminal.toggle" label="Terminal" icon={Terminal} />
      <ActionItem select={select} id="app.browser.toggle" label="Browser" icon={Globe} />
      <SidePaneMenuItems />
      <MenuSeparator />
      <ActionItem select={select} id="app.pane.splitRight" label="Split right" icon={Columns2} />
      <ActionItem select={select} id="app.pane.splitDown" label="Split down" icon={Rows2} />
      <MenuSeparator />
      <HeaderNewSessionItems select={select} onDragStart={() => select(() => undefined)} onDragEnd={() => setOpen(false)} />
      {narrow && onPair && <MenuItem aria-label="Pair with an environment" onSelect={() => select(onPair)}><Link aria-hidden="true" />Pair with an environment</MenuItem>}
      <MenuSeparator />
      <ParkedAsksButton menu />
      {shell?.window?.zoom !== undefined && <>
        <MenuSeparator />
        <ActionItem select={select} id="app.zoom.in" label="Zoom in" icon={ZoomIn} />
        <ActionItem select={select} id="app.zoom.out" label="Zoom out" icon={ZoomOut} />
        <ActionItem select={select} id="app.zoom.reset" label="Actual size" icon={RotateCcw} />
      </>}
      {narrow && <><MenuSeparator /><div className="flex flex-wrap items-center gap-2 p-1"><SetupLine /><RestartToUpdate /><ThemeToggle /></div></>}
      <GridLine />
    </MenuContent>
  </Menu>
</>;
};
