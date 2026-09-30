import type {
  GrantReader,
  HttpFetch,
  Shell,
  ShellClipboard,
  ShellDeepLinks,
  ShellDialogs,
  ShellInstaller,
  ShellNetwork,
  ShellPreview,
  ShellSecrets,
  ShellService,
  ShellSystem,
  ShellUpdate,
  ShellWindow,
} from "@agent-harness/client-runtime";
import { channelOf, DEEP_LINK_CHANNEL, type Answered, type HttpAnswer, type Told } from "../channels.js";

/**
 * The shell as the desktop gives it to its renderer: the members every
 * surface needs, and the platform's own (`secrets`, `localGrant`, `service`,
 * `update`, `installer`). `notifications` and `webView` join as their
 * tickets build them; there is no `tray` in milestone 1.
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
  readonly secrets: Required<ShellSecrets>;
  readonly localGrant: GrantReader;
  readonly service: ShellService;
  readonly preview: ShellPreview;
  readonly update: ShellUpdate;
  readonly installer: ShellInstaller;
}

/** `ipcRenderer`, as the preload uses it. */
export interface PreloadIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  /** Hears the main process's messages on `channel`; what Electron hands first is never passed on to the page. */
  on(channel: string, listener: (details: unknown, ...args: unknown[]) => void): unknown;
}

/**
 * The shell over `ipc`: each member one channel of its own, a renderer's
 * listener handed strings alone. The preload exposes what this answers to
 * the page, through the context bridge.
 */
export const shellBridge = (ipc: PreloadIpc): DesktopShell => {
  const ask = <T>(member: Answered, ...args: unknown[]): Promise<T> => ipc.invoke(channelOf(member), ...args) as Promise<T>;
  const tell = (member: Told, ...args: unknown[]): void => ipc.send(channelOf(member), ...args);

  const linkListeners = new Set<(url: string) => void>();
  const hand = (url: unknown) => {
    if (typeof url === "string") for (const listener of [...linkListeners]) listener(url);
  };
  let listening = false;
  ipc.on(DEEP_LINK_CHANNEL, (_details, url) => hand(url));

  return {
    window: {
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
    secrets: {
      get: (name) => ask("secrets.get", name),
      set: (name, secret) => ask("secrets.set", name, secret),
      delete: (name) => ask("secrets.delete", name),
      protection: () => ask("secrets.protection"),
    },
    localGrant: { read: () => ask("localGrant.read") },
    service: { install: () => ask("service.install"), start: () => ask("service.start"), status: () => ask("service.status") },
    preview: { grant: (content) => ask("preview.grant", content) },
    update: { current: () => ask("update.current"), apply: (staged, when) => ask("update.apply", staged, when) },
    installer: { bundledServer: () => ask("installer.bundledServer") },
  };
};
