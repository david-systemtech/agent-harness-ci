import { randomUUID } from "node:crypto";
import type { ShellWebView, ShellWebViewState, ShellWebViewKey, ShellDebuggerMessage } from "@agent-harness/client-runtime";
import { options } from "./arguments.js";
import type { DesktopElectron, ElectronBrowserWindow, ElectronWebView, ViewBounds } from "./electron.js";
import { isWebLink } from "./schemes.js";

/** Checks IPC geometry before it reaches the native view. */
export const viewBounds = (given: unknown): ViewBounds => {
  const bounds = options(given, "A view's bounds");
  const number = (key: string): number => {
    const value = bounds[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError("View bounds are non-negative whole numbers.");
    return value;
  };
  return { x: number("x"), y: number("y"), width: number("width"), height: number("height") };
};

const pageUrl = (url: string): string => {
  if (url !== "about:blank" && !isWebLink(url)) throw new TypeError("The browser dock opens http and https pages only.");
  return url;
};

/** Native pages beside the renderer, each isolated in its own Chromium profile. */
export const webViews = (electron: DesktopElectron, window: ElectronBrowserWindow): ShellWebView => {
  const debugListeners = new Set<(id: string, message: ShellDebuggerMessage) => void>();
  const detachListeners = new Set<(id: string, reason: string) => void>();
  const keyListeners = new Set<(id: string, key: ShellWebViewKey) => void>();
  const listeners = new Set<(id: string, state: ShellWebViewState) => void>();
  const state = (view: ElectronWebView): ShellWebViewState => ({
    url: view.webContents.getURL(),
    canGoBack: view.webContents.navigationHistory.canGoBack(),
    canGoForward: view.webContents.navigationHistory.canGoForward(),
  });
  let windowClosed = false;
  const views = new Map<string, ElectronWebView>();
  const get = (id: string): ElectronWebView => {
    const view = views.get(id);
    if (!view) throw new Error("The browser page is closed.");
    return view;
  };
  const destroy = (id: string) => {
    const view = views.get(id);
    if (!view) return;
    views.delete(id);
    if (view.webContents.debugger.isAttached()) view.webContents.debugger.detach();
    if (!windowClosed) window.removeWebView(view);
    view.webContents.close();
  };
  window.on("closed", () => {
    windowClosed = true;
    for (const id of views.keys()) destroy(id);
  });
  return {
    debugger: {
      async attach(id) {
        const debug = get(id).webContents.debugger;
        if (!debug.isAttached()) debug.attach("1.3");
      },
      send: (id, method, params, sessionId) => get(id).webContents.debugger.sendCommand(method, params, sessionId),
      async detach(id) {
        const debug = views.get(id)?.webContents.debugger;
        if (debug?.isAttached()) debug.detach();
      },
      onEvent(listener) { debugListeners.add(listener); return () => void debugListeners.delete(listener); },
      onDetach(listener) { detachListeners.add(listener); return () => void detachListeners.delete(listener); },
    },
    async create({ url, partition }) {
      pageUrl(url);
      if (partition !== undefined && !/^[a-z0-9-]{1,100}$/.test(partition))
        throw new TypeError("A page's partition is an opaque key of at most 100 letters, digits and hyphens.");
      const id = randomUUID();
      const view = electron.openWebView({
        webPreferences: {
          partition: partition === undefined ? `dock-${id}` : `persist:dock-${partition}`,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
        },
      });
      views.set(id, view);
      view.webContents.debugger.on("message", (_details, method, params, sessionId) => {
        const event = { method, params, ...(sessionId && { sessionId }) };
        for (const listener of debugListeners) listener(id, event);
      });
      view.webContents.debugger.on("detach", (_details, reason) => {
        for (const listener of detachListeners) listener(id, reason);
      });
      view.setVisible(false);
      window.addWebView(view);
      view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      view.webContents.on("will-navigate", (details) => {
        if (!isWebLink(details.url)) details.preventDefault();
      });
      view.webContents.on("before-input-event", (_details, input) => {
        if (input.type === "keyDown" && views.has(id)) {
          const key = { key: input.key, code: input.code, ctrlKey: input.control, metaKey: input.meta, shiftKey: input.shift, altKey: input.alt };
          for (const listener of keyListeners) listener(id, key);
        }
      });
      const changed = () => {
        if (views.has(id)) for (const listener of listeners) listener(id, state(view));
      };
      for (const event of ["did-navigate", "did-navigate-in-page", "did-stop-loading"] as const) view.webContents.on(event, changed);
      try {
        await view.webContents.loadURL(url);
        return id;
      } catch (error) {
        destroy(id);
        throw error;
      }
    },
    attach(id, bounds) {
      const view = get(id);
      view.setBounds(bounds);
      view.setVisible(true);
    },
    hide(id) {
      views.get(id)?.setVisible(false);
    },
    navigate(id, url) {
      return get(id).webContents.loadURL(pageUrl(url));
    },
    back(id) {
      const history = get(id).webContents.navigationHistory;
      if (history.canGoBack()) history.goBack();
    },
    forward(id) {
      const history = get(id).webContents.navigationHistory;
      if (history.canGoForward()) history.goForward();
    },
    reload(id) {
      get(id).webContents.reload();
    },
    state: async (id) => state(get(id)),
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    onKey(listener) {
      keyListeners.add(listener);
      return () => void keyListeners.delete(listener);
    },
    destroy,
  };
};
