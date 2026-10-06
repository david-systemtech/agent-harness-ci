import { changeZoom } from "./zoom.js";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type {
  CredentialAccessReader,
  GrantReader,
  ShellContent,
  ShellWindowState,
  ShellFile,
  ShellInstaller,
  ShellSecrets,
  ShellService,
  ShellSystem,
  ShellUpdate,
  ShellWebView,
} from "@agent-harness/client-runtime";
import { optionalCount, optionalFilters, optionalFlag, optionalText, options, text, texts } from "./arguments.js";
import { isCanvasColour, type CanvasStore } from "./canvas.js";
import type { Answered, Told } from "./channels.js";
import type { DeepLinkInbox } from "./deep-links.js";
import type { DesktopElectron, ElectronBrowserWindow, ElectronWindow } from "./electron.js";
import type { computerGh } from "./gh.js";
import { viewBounds } from "./web-view.js";
import { environmentHttp } from "./http.js";
import type { NetworkLockdown } from "./lockdown.js";
import type { DesktopNotifications } from "./notifications.js";
import type { DesktopPlatform } from "./platform.js";
import type { Previews } from "./preview.js";
import { isWebLink } from "./schemes.js";
import { applyWhen, stagedBuild } from "./update.js";

/**
 * The main process's side of each shell member (docs/specs/gui.md, "The
 * desktop shell"), by the channel the preload reaches it on. Each reads what
 * the renderer sent as unknown and refuses what the shell interface does not
 * allow.
 */
export type Members = { readonly [M in Answered]: (...args: unknown[]) => unknown } & { readonly [M in Told]: (...args: unknown[]) => void };

/** A snapshot read from Electron, never inferred from the last button pressed. */
export const windowState = (window: ElectronBrowserWindow, platform: DesktopPlatform["os"]): ShellWindowState => ({
  platform, focused: window.isFocused(), maximized: window.isMaximized(), fullScreen: window.isFullScreen(),
});

/** Brings `window` to the front: restored when minimised, shown and focused. */
export const bringForward = (window: ElectronWindow): void => {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
};

/**
 * The dock or taskbar badge. macOS's Dock shows a count or a short text;
 * Linux's launcher a count; Windows has no badge without an icon drawn for
 * it, so its taskbar button asks for attention while a badge is set.
 */
const showBadge = ({ app }: DesktopElectron, window: ElectronWindow, os: DesktopPlatform["os"], badge: unknown): void => {
  if (badge !== undefined && typeof badge !== "string" && !(typeof badge === "number" && Number.isSafeInteger(badge) && badge >= 0)) {
    throw new TypeError("A badge is a count, a short text, or nothing.");
  }
  const shown = badge === undefined || badge === 0 || badge === "" ? undefined : badge;
  if (os === "darwin") app.dock?.setBadge(shown === undefined ? "" : String(shown));
  else if (os === "linux") app.setBadgeCount(typeof shown === "number" ? shown : 0);
  else window.flashFrame(shown !== undefined);
};

/** Whether a clipboard item's content is a `Blob`, told by its shape: Electron's may not be this realm's class. */
const isBlob = (content: unknown): content is Pick<Blob, "arrayBuffer"> =>
  typeof content === "object" && content !== null && typeof (content as { readonly arrayBuffer?: unknown }).arrayBuffer === "function";

/** A chosen file, read unless it is larger than `maxBytes`. */
const readChosen = async (path: string, maxBytes: number | undefined): Promise<ShellFile> => {
  const { size } = await stat(path);
  if (maxBytes !== undefined && size > maxBytes) return { name: basename(path), size, bytes: null };
  const bytes = new Uint8Array(await readFile(path));
  return { name: basename(path), size: bytes.length, bytes };
};

export interface MemberParts {
  readonly electron: DesktopElectron;
  readonly secrets: Required<ShellSecrets>;
  readonly localGrant: GrantReader;
  readonly credentialAccess: CredentialAccessReader;
  readonly service: ShellService;
  readonly update: ShellUpdate;
  readonly installer: ShellInstaller;
  readonly platform: DesktopPlatform;
  readonly window: ElectronBrowserWindow;
  readonly canvas: CanvasStore;
  readonly network: NetworkLockdown;
  readonly links: DeepLinkInbox;
  readonly notifications: DesktopNotifications;
  readonly preview: Previews;
  readonly gh: ReturnType<typeof computerGh>;
  readonly webView: ShellWebView;
}

export const shellMembers = ({
  electron,
  secrets,
  localGrant,
  credentialAccess,
  service,
  update,
  installer,
  platform,
  window,
  canvas,
  network,
  links,
  notifications,
  preview,
  gh,
  webView,
}: MemberParts): Members => {
  const { dialog, clipboard } = electron;
  const openFile = async (given: unknown): Promise<string[]> => {
    const chosen = options(given, "The open dialog's options");
    const title = optionalText(chosen["title"], "The dialog's title");
    const filters = optionalFilters(chosen["filters"]);
    const answer = await dialog.showOpenDialog(window, {
      ...(title !== undefined && { title }),
      ...(filters !== undefined && { filters }),
      properties: optionalFlag(chosen["multiple"], "multiple") ? ["openFile", "multiSelections"] : ["openFile"],
    });
    return answer.canceled ? [] : answer.filePaths;
  };
  return {
    "window.zoom": (action) => changeZoom(window.webContents, action),
    "window.state": () => windowState(window, platform.os),
    "window.minimize": () => window.minimize(),
    "window.toggleMaximize": () => window.isMaximized() ? window.unmaximize() : window.maximize(),
    "window.close": () => window.close(),
    "window.setTitle": (title) => window.setTitle(text(title, "A window's title")),
    "window.focus": () => bringForward(window),
    "window.setBadge": (badge) => showBadge(electron, window, platform.os, badge),
    "window.setBackgroundColour": (colour) => {
      if (!isCanvasColour(colour)) throw new TypeError(`A window's background colour is #rrggbb, not ${JSON.stringify(colour)}.`);
      window.setBackgroundColor(colour);
      canvas.write(colour);
    },
    "dialogs.openFile": openFile,
    "dialogs.openFileContents": async (given) => {
      const maxBytes = optionalCount(options(given, "The open dialog's options")["maxBytes"], "maxBytes");
      return Promise.all((await openFile(given)).map((path) => readChosen(path, maxBytes)));
    },
    "dialogs.openDirectory": async (given) => {
      const title = optionalText(options(given, "The directory dialog's options")["title"], "The dialog's title");
      const answer = await dialog.showOpenDialog(window, { ...(title !== undefined && { title }), properties: ["openDirectory"] });
      return answer.canceled ? undefined : answer.filePaths[0];
    },
    "dialogs.save": async (given) => {
      const chosen = options(given, "The save dialog's options");
      const title = optionalText(chosen["title"], "The dialog's title");
      const defaultPath = optionalText(chosen["defaultPath"], "The dialog's default path");
      const filters = optionalFilters(chosen["filters"]);
      const answer = await dialog.showSaveDialog(window, {
        ...(title !== undefined && { title }),
        ...(defaultPath !== undefined && { defaultPath }),
        ...(filters !== undefined && { filters }),
      });
      return answer.canceled || !answer.filePath ? undefined : answer.filePath;
    },
    "clipboard.readText": () => clipboard.readText(),
    "clipboard.writeText": (value) => clipboard.writeText(text(value, "What the clipboard is given")),
    "clipboard.readImage": async (): Promise<ShellContent | undefined> => {
      for (const entry of await clipboard.read()) {
        const images = entry.types.filter((type) => type.startsWith("image/"));
        const mediaType = images.includes("image/png") ? "image/png" : images[0];
        if (mediaType === undefined) continue;
        const content = await entry.getType(mediaType);
        if (isBlob(content)) return { bytes: new Uint8Array(await content.arrayBuffer()), mediaType };
      }
      return undefined;
    },
    openExternal: async (url) => {
      const link = text(url, "A link");
      if (!isWebLink(link)) throw new TypeError(`The OS's browser opens http and https links only, not ${JSON.stringify(link)}.`);
      await electron.shell.openExternal(link);
    },
    system: (): ShellSystem => ({ platform: platform.os, architecture: platform.architecture, hostname: platform.hostname, user: platform.user }),
    http: environmentHttp,
    "webView.debugger.attach": (id) => webView.debugger!.attach(text(id, "A view's id")),
    "webView.debugger.detach": (id) => webView.debugger!.detach(text(id, "A view's id")),
    "webView.debugger.send": (id, method, params, sessionId) => webView.debugger!.send(
      text(id, "A view's id"), text(method, "A debugger command"), params === undefined ? {} : options(params, "A debugger command's parameters"), optionalText(sessionId, "A child target's session id"),
    ),
    "webView.create": (given) => {
      const chosen = options(given, "A page's options");
      const partition = optionalText(chosen["partition"], "A page's partition");
      return webView.create({ url: text(chosen["url"], "A page's URL"), ...(partition !== undefined && { partition }) });
    },
    "webView.attach": (id, bounds) => webView.attach(text(id, "A view's id"), viewBounds(bounds)),
    "webView.hide": (id) => webView.hide(text(id, "A view's id")),
    "webView.navigate": (id, url) => webView.navigate(text(id, "A view's id"), text(url, "A page's URL")),
    "webView.back": (id) => webView.back(text(id, "A view's id")),
    "webView.forward": (id) => webView.forward(text(id, "A view's id")),
    "webView.reload": (id) => webView.reload(text(id, "A view's id")),
    "webView.stop": (id) => webView.stop(text(id, "A view's id")),
    "webView.state": (id) => webView.state(text(id, "A view's id")),
    "webView.destroy": (id) => webView.destroy(text(id, "A view's id")),
    "network.allow": (addresses) => network.allow(texts(addresses, "The addresses")),
    "notifications.show": (notification) => notifications.show(notification),
    "deepLinks.listen": () => links.listen(window.webContents),
    "secrets.get": (name) => secrets.get(text(name, "A secret's name")),
    "secrets.set": (name, secret) => secrets.set(text(name, "A secret's name"), text(secret, "A secret")),
    "secrets.delete": (name) => secrets.delete(text(name, "A secret's name")),
    "secrets.protection": () => secrets.protection(),
    "secrets.access": () => secrets.access(),
    "localGrant.read": () => localGrant.read(),
    "credentialAccess.read": () => credentialAccess.read(),
    "service.pendingUpdate": () => service.pendingUpdate!(),
    "service.applyUpdateNow": () => service.applyUpdateNow!(),
    "service.install": () => service.install(),
    "service.start": () => service.start(),
    "service.status": () => service.status(),
    "preview.grant": (content) => preview.grant(content),
    "update.current": () => update.current(),
    "update.apply": (staged, when) => update.apply(stagedBuild(staged), applyWhen(when)),
    "installer.bundledServer": () => installer.bundledServer(),
    "installer.reserveSpace": () => installer.reserveSpace!(),
    "gh.token": (host) => gh.token(host),
  };
};
