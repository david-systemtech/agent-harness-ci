import { Copy, File, Folder, MoreHorizontal, Settings, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "../../src/ui/button.js";
import { Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuShortcut, MenuTrigger } from "../../src/ui/menu.js";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from "../../src/ui/context-menu.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../src/ui/popover.js";
import { Tooltip, TooltipProvider } from "../../src/ui/tooltip.js";
import { SelectMenu, SelectMenuContent, SelectMenuItem, SelectMenuTrigger, SelectMenuValue } from "../../src/ui/select-menu.js";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "../../src/ui/command.js";
import { Kbd } from "../../src/ui/kbd.js";

export const MenusScene = () => {
  const context = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const target = context.current;
    if (target === null) return;
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: rect.left, clientY: rect.bottom + 4 }));
  }, []);
  return <TooltipProvider><main data-scene="menus" className="min-h-screen bg-abyss p-6 text-sm text-ink">
    <h1 className="mb-8 text-lg font-medium">Menus, choices and hints</h1>
    <div className="grid grid-cols-3 gap-12">
      <section className="h-72"><h2 className="mb-3 text-xs text-ink-muted">Dropdown</h2><Menu defaultOpen modal={false}><Tooltip content="Session menu · Enter"><MenuTrigger asChild><Button variant="outline"><MoreHorizontal aria-hidden="true" />Session menu</Button></MenuTrigger></Tooltip><MenuContent align="start" className="w-48" data-geometry="dropdown" onInteractOutside={(event) => event.preventDefault()}><MenuLabel>Session</MenuLabel><MenuItem><File aria-hidden="true" />New session<MenuShortcut>Ctrl+N</MenuShortcut></MenuItem><MenuCheckboxItem checked>Pinned</MenuCheckboxItem><MenuSeparator /><MenuRadioGroup value="name"><MenuRadioItem value="name">By name</MenuRadioItem><MenuRadioItem value="date">By date</MenuRadioItem></MenuRadioGroup><MenuItem disabled>Unavailable</MenuItem><MenuItem variant="destructive"><Trash2 aria-hidden="true" />Delete session</MenuItem></MenuContent></Menu></section>
      <section className="h-72"><h2 className="mb-3 text-xs text-ink-muted">Context</h2><ContextMenu><Tooltip content="Session actions · Right click"><ContextMenuTrigger asChild><Button ref={context} variant="outline"><Folder aria-hidden="true" />Session row</Button></ContextMenuTrigger></Tooltip><ContextMenuContent className="w-48" data-geometry="context" onInteractOutside={(event) => event.preventDefault()}><ContextMenuLabel>Session actions</ContextMenuLabel><ContextMenuItem><Copy aria-hidden="true" />Copy link<ContextMenuShortcut>Ctrl+C</ContextMenuShortcut></ContextMenuItem><ContextMenuSeparator /><ContextMenuItem variant="destructive"><Trash2 aria-hidden="true" />Delete session</ContextMenuItem></ContextMenuContent></ContextMenu></section>
      <section className="h-72"><h2 className="mb-3 text-xs text-ink-muted">Select</h2><SelectMenu defaultOpen defaultValue="medium"><Tooltip content="Effort · Enter"><SelectMenuTrigger aria-label="Effort" className="w-48"><SelectMenuValue /></SelectMenuTrigger></Tooltip><SelectMenuContent data-geometry="select"><SelectMenuItem value="low">Low</SelectMenuItem><SelectMenuItem value="medium">Medium</SelectMenuItem><SelectMenuItem value="high">High</SelectMenuItem><SelectMenuItem value="off" disabled>Unavailable</SelectMenuItem></SelectMenuContent></SelectMenu></section>
      <section className="h-72"><h2 className="mb-3 text-xs text-ink-muted">Popover</h2><Popover defaultOpen><Tooltip content="Usage · Enter"><PopoverTrigger asChild><Button variant="outline"><Settings aria-hidden="true" />Usage</Button></PopoverTrigger></Tooltip><PopoverContent align="start" data-geometry="popover" onOpenAutoFocus={(event) => event.preventDefault()} onInteractOutside={(event) => event.preventDefault()}><h3 className="font-medium">Context usage</h3><p className="text-ink-muted">The current run uses 24% of its context window.</p></PopoverContent></Popover></section>
      <section className="h-72"><h2 className="mb-12 text-xs text-ink-muted">Tooltip with keys</h2><Tooltip open content={<>Copy link<Kbd>Ctrl+C</Kbd></>}><Button variant="outline"><Copy aria-hidden="true" />Copy link</Button></Tooltip></section>
      <section><h2 className="mb-3 text-xs text-ink-muted">Command shell</h2><Command className="ring-1 ring-ink/10"><CommandInput placeholder="Search commands" /><CommandList><CommandEmpty>No commands found</CommandEmpty><CommandGroup heading="Session"><CommandItem><File aria-hidden="true" />New session<CommandShortcut>Ctrl+N</CommandShortcut></CommandItem><CommandItem disabled><Folder aria-hidden="true" />Open workspace</CommandItem></CommandGroup></CommandList></Command></section>
    </div>
  </main></TooltipProvider>;
};
export const geometry = [
  { selector: '[data-geometry="dropdown"]', width: 192, tolerance: 0.1 },
  { selector: '[data-geometry="context"]', width: 192, tolerance: 0.1 },
  { selector: '[data-geometry="select"]', width: 192, tolerance: 0.1 },
  { selector: '[data-geometry="popover"]', width: 288, tolerance: 0.1 },
  { selector: '[data-command-input]', height: 32, tolerance: 0.1 },
];
export default MenusScene;
