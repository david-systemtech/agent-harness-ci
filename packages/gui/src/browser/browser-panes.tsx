import type { ShellWebView } from "@agent-harness/client-runtime";
import { createContext, use, useEffect, useMemo, type ReactNode } from "react";
import { panesOf } from "../grid/layout.js";
import { sideColumnKey, type PaneSession } from "../presentation.js";
import { usePresentation, useShell } from "../window-context.js";

interface Page {
  readonly paneId: string;
  readonly id: Promise<string>;
  closed: boolean;
}
interface BrowserPanes {
  page(paneId: string, session: PaneSession, partition: string): Promise<string>;
  close(paneId: string, session: PaneSession): void;
  keep(paneIds: ReadonlySet<string>): void;
  dispose(): void;
}

/** Keeps native pages across session switches and Settings. Only closing a dock, its grid pane, or the window destroys it. */
const browserPanes = (views: ShellWebView | undefined): BrowserPanes => {
  const pages = new Map<string, Page>();
  const key = (paneId: string, session: PaneSession) => `${paneId} ${sideColumnKey(session)}`;
  const close = (key: string) => {
    const page = pages.get(key);
    if (!page) return;
    pages.delete(key);
    page.closed = true;
    void page.id.then(
      (id) => views?.destroy(id),
      () => undefined,
    );
  };
  return {
    page(paneId, session, partition) {
      if (!views) return Promise.reject(new Error("The browser dock needs the desktop shell."));
      const name = key(paneId, session);
      const held = pages.get(name);
      if (held) return held.id;
      const page: Page = { paneId, id: views.create({ url: "about:blank", partition }), closed: false };
      pages.set(name, page);
      // A failed create can be tried again when the dock is next opened.
      void page.id.catch(() => {
        if (pages.get(name) === page) pages.delete(name);
      });
      return page.id.then((id) => {
        if (page.closed) throw new Error("The browser page is closed.");
        return id;
      });
    },
    close: (paneId, session) => close(key(paneId, session)),
    keep(paneIds) {
      for (const [key, page] of pages) if (!paneIds.has(page.paneId)) close(key);
    },
    dispose() {
      for (const key of pages.keys()) close(key);
    },
  };
};

const BrowserPanesContext = createContext<BrowserPanes | null>(null);
export const BrowserPanesProvider = ({ children }: { readonly children: ReactNode }) => {
  const views = useShell()?.webView;
  const panes = useMemo(() => browserPanes(views), [views]);
  const [layout] = usePresentation("paneLayout");
  useEffect(() => panes.keep(new Set(panesOf(layout).map((pane) => pane.id))), [panes, layout]);
  useEffect(() => () => panes.dispose(), [panes]);
  return <BrowserPanesContext value={panes}>{children}</BrowserPanesContext>;
};
export const useBrowserPanes = (): BrowserPanes => {
  const panes = use(BrowserPanesContext);
  if (!panes) throw new Error("Browser panes live inside the frame.");
  return panes;
};
