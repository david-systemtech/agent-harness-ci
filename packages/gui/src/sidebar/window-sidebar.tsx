import { createContext, use, useMemo, useState, type ReactNode } from "react";

/**
 * What the sidebar keeps for the life of the window (docs/specs/gui.md, "The
 * window and the sidebar"), held above it because the sidebar is unmounted
 * while it is hidden (Mod+B) or Settings has the window: what is typed in its
 * filter, which is not presentation, so a window opened again starts with
 * none.
 */
interface WindowSidebar {
  readonly filter: string;
  setFilter(text: string): void;
}

const WindowSidebarContext = createContext<WindowSidebar | null>(null);

export const WindowSidebarProvider = ({ children }: { readonly children: ReactNode }) => {
  const [filter, setFilter] = useState("");
  const held = useMemo(() => ({ filter, setFilter }), [filter]);
  return <WindowSidebarContext value={held}>{children}</WindowSidebarContext>;
};

const useWindowSidebar = (): WindowSidebar => {
  const held = use(WindowSidebarContext);
  if (held === null) throw new Error("The sidebar is drawn inside the window's frame, which holds what it keeps.");
  return held;
};

/** What is typed in the sidebar's filter, and the setter that types another. */
export const useSidebarFilter = (): readonly [string, (text: string) => void] => {
  const { filter, setFilter } = useWindowSidebar();
  return [filter, setFilter];
};
