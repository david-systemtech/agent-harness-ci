import type { SessionRow } from "@agent-harness/client-runtime";
import { createContext, use, useMemo, useState, type ReactNode } from "react";

/**
 * What the sidebar keeps for the life of the window (docs/specs/gui.md, "The
 * window and the sidebar"), held above it because the sidebar is unmounted
 * while it is hidden (Mod+B) or Settings has the window: what is typed in its
 * filter, which is not presentation, so a window opened again starts with
 * none; and the session being dragged from it, which a drop anywhere in the
 * window reads (the sidebar's headings and rows, and the pane grid's, #407).
 */
interface WindowSidebar {
  readonly filter: string;
  setFilter(text: string): void;
  /** The row being dragged from the sidebar; null while none is. */
  readonly dragged: SessionRow | null;
  setDragged(row: SessionRow | null): void;
}

const WindowSidebarContext = createContext<WindowSidebar | null>(null);

export const WindowSidebarProvider = ({ children }: { readonly children: ReactNode }) => {
  const [filter, setFilter] = useState("");
  const [dragged, setDragged] = useState<SessionRow | null>(null);
  const held = useMemo(() => ({ filter, setFilter, dragged, setDragged }), [filter, dragged]);
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

/** The row being dragged from the sidebar (null while none is), and the setter that starts or ends a drag. */
export const useDraggedRow = (): readonly [SessionRow | null, (row: SessionRow | null) => void] => {
  const { dragged, setDragged } = useWindowSidebar();
  return [dragged, setDragged];
};
