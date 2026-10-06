import type {
  CredentialAccessReader,
  GrantReader,
  HttpFetch,
  Shell,
  ShellClipboard,
  ShellDeepLinks,
  ShellDialogs,
  ShellGh,
  ShellInstaller,
  ShellNetwork,
  ShellNotifications,
  ShellPreview,
  ShellSecrets,
  SecretAccess,
  ShellService,
  ShellSystem,
  ShellUpdate,
  ShellWindow,
  ShellWindowState,
  ShellWebView,
  ShellDebuggerMessage,
  ShellWebViewState,
  ShellWebViewKey,
} from "@agent-harness/client-runtime";
import { channelOf, WINDOW_CHANNEL, SECRET_ACCESS_CHANNEL, WEB_VIEW_DEBUG_CHANNEL, WEB_VIEW_DETACH_CHANNEL, WEB_VIEW_CHANNEL, WEB_VIEW_KEY_CHANNEL, DEEP_LINK_CHANNEL, NOTIFICATION_CHANNEL, type Answered, type HttpAnswer, type Told } from "../channels.js";

/**
 * The shell as the desktop gives it to its renderer: the members every
 * surface needs, and the platform's own (`secrets`, `localGrant`, `service`,
 * `update`, `installer`, `gh`). `webView` carries the browser dock;
 * there is no `tray` in milestone 1.
 */
export interface DesktopShell extends Shell {
  readonly window: ShellWindow;
  readonly dialogs: ShellDialogs;
  readonly clipboard: ShellClipboard;
  readonly openExternal: (url: string) => Promise<void>;
  readonly system: () => Promise<ShellSystem>;
  readonly http: HttpFetch;
  readonly network: ShellNetwork;
  readonly deepLinks: Required<ShellDeepLinks>;
  readonly notifications: Required<ShellNotifications>;
  readonly secrets: Required<ShellSecrets>;
  readonly localGrant: GrantReader;
  readonly credentialAccess: CredentialAccessReader;
  readonly service: ShellService;
  readonly preview: ShellPreview;
  readonly update: ShellUpdate;
  readonly installer: ShellInstaller;
  readonly gh: ShellGh;
  readonly webView: ShellWebView;
}

/** `ipcRenderer`, as the preload uses it. */
export interface PreloadIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  /** Hears the main process's messages on `channel`; what Electron hands first is never passed on to the page. */
  on(channel: string, listener: (details: unknown, ...args: unknown[]) => void): unknown;
}

/**
 * What a member's failure says, without the envelope Electron's `ipcRenderer.invoke` wraps it in: `Error invoking remote
 * method '<channel>': ` and the failed error's class, as `Error: `. Every shell call fails through this, so the window says the
 * main process's own words.
 */
const unwrapped = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, "");
};

/**
 * The shell over `ipc`: each member one channel of its own, a renderer's
 * listener handed strings alone. The preload exposes what this answers to
 * the page, through the context bridge.
 */
export const shellBridge = (ipc: PreloadIpc): DesktopShell => {
  const ask = <T>(member: Answered, ...args: unknown[]): Promise<T> => (ipc.invoke(channelOf(member), ...args) as Promise<T>).catch((error: unknown) => {
    throw new Error(unwrapped(error));
  });
  const tell = (member: Told, ...args: unknown[]): void => ipc.send(channelOf(member), ...args);

  const accessListeners = new Set<(state: SecretAccess) => void>();
  let accessRevision = 0;
  ipc.on(SECRET_ACCESS_CHANNEL, (_details, state) => {
    if (state !== null && state !== "waiting" && state !== "denied") return;
    accessRevision++;
    for (const listener of [...accessListeners]) listener(state);
  });
  const windowListeners = new Set<(state: ShellWindowState) => void>();
  ipc.on(WINDOW_CHANNEL, (_details, state) => {
    if (typeof state !== "object" || state === null) return;
    const value = state as ShellWindowState;
    if (!["darwin", "win32", "linux"].includes(value.platform) || typeof value.focused !== "boolean" || typeof value.maximized !== "boolean" || typeof value.fullScreen !== "boolean") return;
    for (const listener of [...windowListeners]) listener(value);
  });

  const linkListeners = new Set<(url: string) => void>();
  const hand = (url: unknown) => {
    if (typeof url === "string") for (const listener of [...linkListeners]) listener(url);
  };
  let listening = false;
  ipc.on(DEEP_LINK_CHANNEL, (_details, url) => hand(url));

  const activationListeners = new Set<(tag: string) => void>();
  ipc.on(NOTIFICATION_CHANNEL, (_details, tag) => {
    if (typeof tag === "string") for (const listener of [...activationListeners]) listener(tag);
  });

  const debugListeners = new Set<(id: string, message: ShellDebuggerMessage) => void>();
  const detachListeners = new Set<(id: string, reason: string) => void>();
  ipc.on(WEB_VIEW_DEBUG_CHANNEL, (_details, id, event) => {
    for (const listener of debugListeners) listener(id as string, event as ShellDebuggerMessage);
  });
  ipc.on(WEB_VIEW_DETACH_CHANNEL, (_details, id, reason) => {
    for (const listener of detachListeners) listener(id as string, reason as string);
  });
  const keyListeners = new Set<(id: string, key: ShellWebViewKey) => void>();
  ipc.on(WEB_VIEW_KEY_CHANNEL, (_details, id, key) => {
    if (typeof id !== "string" || typeof key !== "object" || key === null) return;
    const value = key as ShellWebViewKey;
    if (typeof value.key !== "string" || typeof value.code !== "string" || typeof value.ctrlKey !== "boolean" || typeof value.metaKey !== "boolean" || typeof value.shiftKey !== "boolean" || typeof value.altKey !== "boolean") return;
    for (const listener of keyListeners) listener(id, value);
  });
  const viewListeners = new Set<(id: string, state: ShellWebViewState) => void>();
  ipc.on(WEB_VIEW_CHANNEL, (_details, id, state) => {
    if (typeof id !== "string" || typeof state !== "object" || state === null) return;
    const value = state as ShellWebViewState;
    if (typeof value.url !== "string" || typeof value.canGoBack !== "boolean" || typeof value.canGoForward !== "boolean") return;
    for (const listener of [...viewListeners]) listener(id, value);
  });

  return {
    window: {
      zoom: (action) => tell("window.zoom", action),
      minimize: () => tell("window.minimize"),
      toggleMaximize: () => tell("window.toggleMaximize"),
      close: () => tell("window.close"),
      state: () => ask("window.state"),
      onChange: (listener) => { windowListeners.add(listener); return () => void windowListeners.delete(listener); },
      setTitle: (text) => tell("window.setTitle", text),
      focus: () => tell("window.focus"),
      setBadge: (badge) => tell("window.setBadge", badge),
      setBackgroundColour: (colour) => tell("window.setBackgroundColour", colour),
    },
    dialogs: {
      openFile: (options) => ask("dialogs.openFile", options),
      openFileContents: (options) => ask("dialogs.openFileContents", options),
      openDirectory: (options) => ask("dialogs.openDirectory", options),
      save: (options) => ask("dialogs.save", options),
    },
    clipboard: {
      readText: () => ask("clipboard.readText"),
      writeText: (text) => ask("clipboard.writeText", text),
      readImage: () => ask("clipboard.readImage"),
    },
    openExternal: (url) => ask("openExternal", url),
    system: () => ask("system"),
    http: async (url, request) => {
      const answer = await ask<HttpAnswer>("http", url, request);
      return { status: answer.status, json: async () => JSON.parse(answer.body) as unknown };
    },
    network: { allow: (addresses) => ask("network.allow", addresses) },
    deepLinks: {
      onOpen: (listener) => {
        linkListeners.add(listener);
        if (!listening) {
          listening = true;
          ask<readonly string[]>("deepLinks.listen").then(
            (held) => held.forEach(hand),
            () => (listening = false),
          );
        }
        return () => void linkListeners.delete(listener);
      },
    },
    notifications: {
      show: (notification) => ask("notifications.show", notification),
      onActivate: (listener) => {
        activationListeners.add(listener);
        return () => void activationListeners.delete(listener);
      },
    },
    secrets: {
      access: () => ask("secrets.access"),
      onAccess: (listener) => {
        accessListeners.add(listener);
        const revision = accessRevision;
        void ask<SecretAccess>("secrets.access").then((state) => {
          if (revision === accessRevision && accessListeners.has(listener)) listener(state);
        }, () => {});
        return () => void accessListeners.delete(listener);
      },
      get: (name) => ask("secrets.get", name),
      set: (name, secret) => ask("secrets.set", name, secret),
      delete: (name) => ask("secrets.delete", name),
      protection: () => ask("secrets.protection"),
    },
    localGrant: { read: () => ask("localGrant.read") },
    credentialAccess: { read: () => ask("credentialAccess.read") },
    service: { pendingUpdate: () => ask("service.pendingUpdate"), applyUpdateNow: () => ask("service.applyUpdateNow"), install: () => ask("service.install"), start: () => ask("service.start"), status: () => ask("service.status") },
    preview: { grant: (content) => ask("preview.grant", content) },
    update: { current: () => ask("update.current"), apply: (staged, when) => ask("update.apply", staged, when) },
    installer: { bundledServer: () => ask("installer.bundledServer"), reserveSpace: () => ask("installer.reserveSpace") },
    gh: { token: (host) => ask("gh.token", host) },
    webView: {
      debugger: {
        attach: (id) => ask("webView.debugger.attach", id),
        send: (id, method, params, sessionId) => ask("webView.debugger.send", id, method, params, sessionId),
        detach: (id) => ask("webView.debugger.detach", id),
        onEvent(listener) { debugListeners.add(listener); return () => void debugListeners.delete(listener); },
        onDetach(listener) { detachListeners.add(listener); return () => void detachListeners.delete(listener); },
      },
      create: (options) => ask("webView.create", options),
      attach: (id, bounds) => tell("webView.attach", id, bounds),
      hide: (id) => tell("webView.hide", id),
      navigate: (id, url) => ask("webView.navigate", id, url),
      back: (id) => tell("webView.back", id),
      forward: (id) => tell("webView.forward", id),
      reload: (id) => tell("webView.reload", id),
      stop: (id) => tell("webView.stop", id),
      state: (id) => ask("webView.state", id),
      onChange: (listener) => {
        viewListeners.add(listener);
        return () => void viewListeners.delete(listener);
      },
      onKey: (listener) => { keyListeners.add(listener); return () => void keyListeners.delete(listener); },
      destroy: (id) => tell("webView.destroy", id),
    },
  };
};
