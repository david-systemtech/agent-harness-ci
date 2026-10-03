import type { SessionRow } from "@agent-harness/client-runtime";
import { createContext, use, useEffect, useMemo, useState, type ReactNode, type RefObject } from "react";
import { usePresentation } from "../window-context.js";

/**
 * What the sidebar keeps for the life of the window (docs/specs/gui.md, "The
 * window and the sidebar"), held above it because the sidebar is unmounted
 * while it is hidden (Mod+B) or Settings has the window: what is typed in its
 * filter, which is not presentation, so a window opened again starts with
 * none; and the session being dragged from it, which a drop anywhere in the
 * window reads (the sidebar's headings and rows, and the pane grid's, #407).
 * A session pane's `/search` (#753) types in the filter from outside it, the
 * filter taking the focus once the sidebar is drawn.
 */
interface WindowSidebar {
  readonly filter: string;
  setFilter(text: string): void;
  /** Whether the filter is to take the focus once it is drawn: `/search` asked for it. */
  readonly filterFocus: boolean;
  /** An explicit search keeps the field reachable even with eight or fewer sessions. */
  readonly searchShown: boolean;
  setSearchShown(shown: boolean): void;
  setFilterFocus(focus: boolean): void;
  /** The row being dragged from the sidebar; null while none is. */
  readonly dragged: SessionRow | null;
  setDragged(row: SessionRow | null): void;
}

const WindowSidebarContext = createContext<WindowSidebar | null>(null);

export const WindowSidebarProvider = ({ children }: { readonly children: ReactNode }) => {
  const [filter, setFilter] = useState("");
  const [filterFocus, setFilterFocus] = useState(false);
  const [searchShown, setSearchShown] = useState(false);
  const [dragged, setDragged] = useState<SessionRow | null>(null);
  const held = useMemo(() => ({ filter, setFilter, filterFocus, setFilterFocus, searchShown, setSearchShown, dragged, setDragged }), [filter, filterFocus, searchShown, dragged]);
  return <WindowSidebarContext value={held}>{children}</WindowSidebarContext>;
};

const useWindowSidebar = (): WindowSidebar => {
  const held = use(WindowSidebarContext);
  if (held === null) throw new Error("The sidebar is drawn inside the App, which holds what it keeps while the window lasts.");
  return held;
};

/** What is typed in the sidebar's filter, and the setter that types another. */
export const useSidebarFilter = (): readonly [string, (text: string) => void] => {
  const { filter, setFilter } = useWindowSidebar();
  return [filter, setFilter];
};

/**
 * Searches the sessions from elsewhere in the window (`/search <text>`): the
 * sidebar shown, `text` typed in its filter in place of what was there (none
 * for a bare `/search`), and the focus there, to go on typing.
 */
export const useSidebarSearch = (): ((text: string) => void) => {
  const { setFilter, setFilterFocus, setSearchShown } = useWindowSidebar();
  const [, setShown] = usePresentation("sidebarShown");
  return (text) => {
    setShown(true);
    setSearchShown(true);
    setFilter(text);
    setFilterFocus(true);
  };
};

export const useSidebarSearchShown = (): boolean => useWindowSidebar().searchShown;

/** Gives the sidebar's filter, `field`, the focus once drawn when a search asked for it. */
export const useFilterFocus = (field: RefObject<HTMLInputElement | null>): void => {
  const { filterFocus, setFilterFocus } = useWindowSidebar();
  useEffect(() => {
    if (!filterFocus) return;
    field.current?.focus();
    setFilterFocus(false);
  }, [field, filterFocus, setFilterFocus]);
};

/** The row being dragged from the sidebar (null while none is), and the setter that starts or ends a drag. */
export const useDraggedRow = (): readonly [SessionRow | null, (row: SessionRow | null) => void] => {
  const { dragged, setDragged } = useWindowSidebar();
  return [dragged, setDragged];
};
