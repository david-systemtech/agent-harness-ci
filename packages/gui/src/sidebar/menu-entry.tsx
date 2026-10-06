import { usePhoneFrame } from "../frame/phone-frame.js";
import { useRef, type ReactNode, type KeyboardEvent } from "react";
import { Folder, type LucideIcon } from "lucide-react";
import type { Offer } from "../keys/key-dispatch.js";
import { ContextMenuItem, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, Tooltip } from "../ui/index.js";

/**
 * The sidebar's context menus' items (docs/specs/gui.md, "The window and
 * the sidebar"): each offered as the runtime answers for its command, dim
 * with the line saying why while it cannot be sent, never hidden.
 */

/** An item offered as the runtime answers for it: dim, with the line saying why under its name, while absent. */
export const Entry = ({ offer, detail, icon: Icon = Folder, letter, onSelect, children }: { readonly offer: Offer; readonly detail?: string; readonly icon?: LucideIcon; readonly letter?: string; onSelect(): void; readonly children: ReactNode }) => {
  const absent = offer.status === "absent" ? offer.message : undefined;
  return (
    <Tooltip content={absent ?? <span>{children}{letter !== undefined && ` · ${letter}`}</span>}>
      <ContextMenuItem data-menu-key={letter} disabled={absent !== undefined} onSelect={onSelect} className="flex-wrap">
        <Icon aria-hidden="true" className="size-3.5 shrink-0" />
        <span data-menu-label className="min-w-0 flex-1">{children}</span>
        {letter !== undefined && <kbd aria-hidden="true" className="ml-auto font-mono text-2xs text-ink-faint">{letter}</kbd>}
        {detail !== undefined && <span className="ml-auto pl-3 text-xs text-ink-muted">{detail}</span>}
        {absent !== undefined && <span className="block basis-full text-xs text-ink-faint">{absent}</span>}
      </ContextMenuItem>
    </Tooltip>
  );
};

/** A submenu retains the same unavailable reason as its ordinary command. */
export const SubEntry = ({ offer, name, icon: Icon = Folder, children }: { readonly offer: Offer; readonly name: string; readonly icon?: LucideIcon; readonly children: ReactNode }) => {
  const { narrow } = usePhoneFrame();
  return offer.status === "absent" ? (
    <Entry offer={offer} icon={Icon} onSelect={() => undefined}>{name}</Entry>
  ) : (
    <ContextMenuSub>
      <Tooltip content={name} keys="Right arrow"><ContextMenuSubTrigger><Icon aria-hidden="true" /><span data-menu-label>{name}</span></ContextMenuSubTrigger></Tooltip>
      <ContextMenuSubContent className={narrow ? "phone-frame-menu w-72" : "w-[176px]"}>{children}</ContextMenuSubContent>
    </ContextMenuSub>
  );
};

/** The renderer's context trigger supports pointer gestures; supply the standard keyboard gesture too. */
export const contextMenuKeys = (event: KeyboardEvent<HTMLElement>) => {
  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
  event.preventDefault();
  event.stopPropagation();
  const rect = event.currentTarget.getBoundingClientRect();
  event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + 8 }));
};

/** Letter accelerators act only in this menu, with disabled commands left alone. */
export const menuLetter = (event: KeyboardEvent<HTMLDivElement>) => {
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.key.length !== 1) return;
  if (!(event.target instanceof Element) || event.target.closest('[role="menu"]') !== event.currentTarget) return;
  const item = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-menu-key]")).find((candidate) => candidate.dataset["menuKey"]?.toLowerCase() === event.key.toLowerCase());
  if (item === undefined) return;
  event.preventDefault();
  event.stopPropagation();
  if (item.getAttribute("aria-disabled") !== "true") item.click();
};

/**
 * An item that hands the focus on (Rename's field, a dialog): what it does
 * waits for the menu to close (`handOn` wraps it), and runs from the menu's
 * `onCloseAutoFocus`, which then leaves the focus to it rather than handing
 * it back to the menu's trigger. So the field or the dialog comes once the
 * menu's hold on the focus has gone.
 */
export const useHandOn = () => {
  const next = useRef<(() => void) | null>(null);
  return {
    handOn:
      (then: () => void): (() => void) =>
      () => {
        next.current = then;
      },
    onCloseAutoFocus: (event: Event) => {
      const then = next.current;
      if (then === null) return;
      next.current = null;
      event.preventDefault();
      then();
    },
  };
};

/** A tap action opens the same context menu as the standard keyboard gesture. */
export const openContextActions = (target: HTMLElement | null) => {
  if (target === null) return;
  const rect = target.getBoundingClientRect();
  target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + 8 }));
};
