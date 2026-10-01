import { homeEnvironment, uuidv4, type ShellWebView } from "@agent-harness/client-runtime";
import { createContext, use, useEffect, useMemo, useRef, type ReactNode } from "react";
import { registerDockDriver } from "./dock-driver.js";
import { panesOf } from "../grid/layout.js";
import { sideColumnKey, type PaneSession } from "../presentation.js";
import { useObservable, usePresentation, useRuntime, useShell } from "../window-context.js";

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
      const page: Page = {
        paneId,
        id: views.create({ url: "about:blank", partition }),
        closed: false,
      };
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
  const runtime = useRuntime();
  const home = homeEnvironment(useObservable(runtime.projections.environments));
  const [layout] = usePresentation("paneLayout");
  const [partitions, setPartitions] = usePresentation("browserPartitions");
  const held = useRef({ layout, partitions });
  held.current = { layout, partitions };
  useEffect(() => {
    if (!views?.debugger || !home) return;
    return registerDockDriver(runtime, views, home.environmentId, (session) => {
      const { layout, partitions } = held.current;
      const pane = panesOf(layout).find((pane) => pane.session?.environmentId === session.environmentId && pane.session.sessionId === session.sessionId);
      const paneId = pane?.id ?? layout.focused;
      const key = `${paneId} ${sideColumnKey(session)}`;
      const partition = partitions[key] ?? uuidv4();
      if (!partitions[key]) setPartitions((kept) => ({ ...kept, [key]: partition }));
      return panes.page(paneId, session, partition);
    });
  }, [runtime, views, home?.environmentId, panes, setPartitions]);
  useEffect(() => panes.keep(new Set(panesOf(layout).map((pane) => pane.id))), [panes, layout]);
  useEffect(() => () => panes.dispose(), [panes]);
  return <BrowserPanesContext value={panes}>{children}</BrowserPanesContext>;
};
export const useBrowserPanes = (): BrowserPanes => {
  const panes = use(BrowserPanesContext);
  if (!panes) throw new Error("Browser panes live inside the frame.");
  return panes;
};
