/**
 * The IPC between the preload and the main process: one channel per shell
 * member, so the renderer can reach nothing but the members. Both sides
 * import this module; the preload bundle carries its own copy.
 */

/**
 * The name the preload gives the shell in the renderer's window
 * (`window.desktopShell`), the one thing it exposes, where the desktop
 * platform finds it.
 */
export const SHELL_GLOBAL = "desktopShell";

export const SECRET_ACCESS_CHANNEL = "shell:secrets.accessChanged";

export const WINDOW_CHANNEL = "shell:window.changed";

/** The members the renderer awaits, each answered through `ipcMain.handle`. */
export const ANSWERED = [
  "window.state",
  "dialogs.openFile",
  "dialogs.openFileContents",
  "dialogs.openDirectory",
  "dialogs.save",
  "clipboard.readText",
  "clipboard.writeText",
  "clipboard.readImage",
  "openExternal",
  "system",
  "http",
  "network.allow",
  "notifications.show",
  /** The renderer's first `deepLinks.onOpen`: answers the links held for it, and has the rest sent as they come. */
  "deepLinks.listen",
  "secrets.get",
  "secrets.set",
  "secrets.delete",
  "secrets.protection",
  "secrets.access",
  "localGrant.read",
  "service.applyUpdateNow",
  "service.install",
  "service.pendingUpdate",
  "service.start",
  "service.status",
  "preview.grant",
  "update.current",
  "update.apply",
  "installer.bundledServer",
  "installer.reserveSpace",
  "gh.token",
  "webView.create",
  "webView.navigate",
  "webView.state",
  "webView.debugger.attach",
  "webView.debugger.send",
  "webView.debugger.detach",
] as const;
export type Answered = (typeof ANSWERED)[number];

/** The members that answer nothing (`void` in the shell interface), each heard through `ipcMain.on`. */
export const TOLD = [
  "window.minimize",
  "window.toggleMaximize",
  "window.close",
  "window.setTitle",
  "window.focus",
  "window.setBadge",
  "window.setBackgroundColour",
  "webView.attach",
  "webView.hide",
  "webView.destroy",
  "webView.back",
  "webView.forward",
  "webView.reload",
  "webView.stop",
] as const;
export type Told = (typeof TOLD)[number];

export const channelOf = (member: Answered | Told): string => `shell:${member}`;

/** The channel the main process sends each deep link on, once the renderer listens. */
export const DEEP_LINK_CHANNEL = "shell:deepLinks.opened";

/** The channel the main process sends a dock page's native key presses on. */
export const WEB_VIEW_KEY_CHANNEL = "shell:webView.key";

/** The channel the main process sends a dock page's CDP events on. */
export const WEB_VIEW_DEBUG_CHANNEL = "shell:webView.debugger.event";
/** The channel the main process sends a dock page's debugger detach reason on. */
export const WEB_VIEW_DETACH_CHANNEL = "shell:webView.debugger.detached";
/** The channel the main process sends a dock page's navigation state on. */
export const WEB_VIEW_CHANNEL = "shell:webView.changed";

/** The channel the main process sends a clicked notification's tag on. */
export const NOTIFICATION_CHANNEL = "shell:notifications.activated";

/** What the main process answers an `http` call with; the preload gives the renderer its `json()`. */
export interface HttpAnswer {
  readonly status: number;
  readonly body: string;
}
