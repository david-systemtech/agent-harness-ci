import { useRef, type ReactNode } from "react";
import type { Offer } from "../keys/key-dispatch.js";
import { ContextMenuItem, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from "../ui/index.js";

/**
 * The sidebar's context menus' items (docs/specs/gui.md, "The window and
 * the sidebar"): each offered as the runtime answers for its command, dim
 * with the line saying why while it cannot be sent, never hidden.
 */

/** An item offered as the runtime answers for it: dim, with the line saying why under its name, while absent. */
export const Entry = ({ offer, detail, onSelect, children }: { readonly offer: Offer; readonly detail?: string; onSelect(): void; readonly children: ReactNode }) => {
  const absent = offer.status === "absent" ? offer.message : undefined;
  return (
    <ContextMenuItem disabled={absent !== undefined} onSelect={onSelect} className="flex-wrap">
      {children}
      {detail !== undefined && <span className="ml-auto pl-3 text-xs text-ink-muted">{detail}</span>}
      {absent !== undefined && <span className="block basis-full text-xs text-ink-faint">{absent}</span>}
    </ContextMenuItem>
  );
};

/** An item that opens a submenu, or, while its command cannot be sent, a dim item saying why. */
export const SubEntry = ({ offer, name, children }: { readonly offer: Offer; readonly name: string; readonly children: ReactNode }) =>
  offer.status === "absent" ? (
    <Entry offer={offer} onSelect={() => undefined}>
      {name}
    </Entry>
  ) : (
    <ContextMenuSub>
      <ContextMenuSubTrigger>{name}</ContextMenuSubTrigger>
      <ContextMenuSubContent>{children}</ContextMenuSubContent>
    </ContextMenuSub>
  );

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
