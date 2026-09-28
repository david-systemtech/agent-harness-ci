import { PRODUCT_NAME } from "@agent-harness/contracts";
import type { GrantReader, HttpFetch, SecretStore } from "../platform.js";
import type {
  Shell,
  ShellClipboard,
  ShellDeepLinks,
  ShellDialogs,
  ShellNetwork,
  ShellNotifications,
  ShellPreview,
  ShellService,
  ShellTray,
  ShellUpdate,
  ShellWebView,
  ShellWindow,
} from "../shell.js";

/**
 * The recording fake shell (docs/specs/gui.md, "Testing Decisions"): every
 * member of the shell interface, for a test of a desktop client. Each call
 * is recorded with every argument it was given, and answered with something
 * plain until the test scripts another answer (`answer`). What only the
 * desktop's side starts, a deep link opened and a notification clicked, the
 * test fires (`openDeepLink`, `activateNotification`). Hand it to the
 * in-memory platform as its `shell`.
 */

/** Every function the shell carries, by its path, as a recorded call names it. */
export interface ShellFunctions {
  "dialogs.openFile": ShellDialogs["openFile"];
  "dialogs.openDirectory": ShellDialogs["openDirectory"];
  "dialogs.save": ShellDialogs["save"];
  "window.setTitle": ShellWindow["setTitle"];
  "window.focus": ShellWindow["focus"];
  "window.setBadge": ShellWindow["setBadge"];
  "window.setBackgroundColour": ShellWindow["setBackgroundColour"];
  "notifications.show": NonNullable<ShellNotifications["show"]>;
  "notifications.onActivate": NonNullable<ShellNotifications["onActivate"]>;
  "tray.setTooltip": ShellTray["setTooltip"];
  "tray.onClick": ShellTray["onClick"];
  "deepLinks.onOpen": NonNullable<ShellDeepLinks["onOpen"]>;
  "webView.create": ShellWebView["create"];
  "webView.attach": ShellWebView["attach"];
  "webView.navigate": ShellWebView["navigate"];
  "webView.destroy": ShellWebView["destroy"];
  "preview.grant": ShellPreview["grant"];
  "update.check": ShellUpdate["check"];
  "update.install": ShellUpdate["install"];
  "service.install": ShellService["install"];
  "service.start": ShellService["start"];
  "service.status": ShellService["status"];
  "clipboard.readText": ShellClipboard["readText"];
  "clipboard.writeText": ShellClipboard["writeText"];
  "clipboard.readImage": ShellClipboard["readImage"];
  openExternal: NonNullable<Shell["openExternal"]>;
  "localGrant.read": GrantReader["read"];
  "secrets.get": SecretStore["get"];
  "secrets.set": SecretStore["set"];
  "secrets.delete": SecretStore["delete"];
  http: HttpFetch;
  "network.allow": ShellNetwork["allow"];
  system: NonNullable<Shell["system"]>;
}

export type ShellFunctionName = keyof ShellFunctions;

/** A call the shell was asked to make: the function's path, then every argument, as given. */
export type ShellCall = readonly [member: ShellFunctionName, ...args: unknown[]];

/** The functions a test scripts the answers of: all but the two listeners the fake fires itself. */
export type ScriptableShellFunction = Exclude<ShellFunctionName, "deepLinks.onOpen" | "notifications.onActivate">;

/** A shell with every member, each inner one too, and what a test drives it by. */
export type FakeShell = Required<Shell> & {
  readonly notifications: Required<ShellNotifications>;
  readonly deepLinks: Required<ShellDeepLinks>;
  /** Every call, oldest first. */
  readonly calls: readonly ShellCall[];
  /** Answers every later call of `member` with `responder`, still recording it. */
  answer<M extends ScriptableShellFunction>(member: M, responder: ShellFunctions[M]): void;
  /** Opens `url` as the desktop does a deep link: every listener `deepLinks.onOpen` holds now hears it. */
  openDeepLink(url: string): void;
  /** Clicks the notification shown with `tag`: every listener `notifications.onActivate` holds now is handed the tag. Throws when none was shown with it. */
  activateNotification(tag: string): void;
};

export const fakeShell = (): FakeShell => {
  const calls: ShellCall[] = [];
  const secrets = new Map<string, string>();
  const heard = { links: new Set<(url: string) => void>(), activations: new Set<(tag: string) => void>() };
  let views = 0;
  let previews = 0;
  const listen =
    <T>(listeners: Set<(value: T) => void>) =>
    (listener: (value: T) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    };
  const responders: ShellFunctions = {
    "dialogs.openFile": async () => [],
    "dialogs.openDirectory": async () => undefined,
    "dialogs.save": async () => undefined,
    "window.setTitle": () => undefined,
    "window.focus": () => undefined,
    "window.setBadge": () => undefined,
    "window.setBackgroundColour": () => undefined,
    "notifications.show": async () => undefined,
    "notifications.onActivate": listen(heard.activations),
    "tray.setTooltip": () => undefined,
    "tray.onClick": () => () => undefined,
    "deepLinks.onOpen": listen(heard.links),
    "webView.create": async () => `view-${++views}`,
    "webView.attach": () => undefined,
    "webView.navigate": async () => undefined,
    "webView.destroy": () => undefined,
    "preview.grant": async () => `${PRODUCT_NAME}-preview://fake/${++previews}`,
    "update.check": async () => ({ available: false }),
    "update.install": async () => undefined,
    "service.install": async () => undefined,
    "service.start": async () => undefined,
    "service.status": async () => ({ installed: true, running: true, ready: true }),
    "clipboard.readText": async () => "",
    "clipboard.writeText": async () => undefined,
    "clipboard.readImage": async () => undefined,
    openExternal: async () => undefined,
    "localGrant.read": async () => undefined,
    "secrets.get": async (name) => secrets.get(name),
    "secrets.set": async (name, secret) => void secrets.set(name, secret),
    "secrets.delete": async (name) => void secrets.delete(name),
    // Nothing answers until the test scripts it: a request fails as one to an address with nothing listening does.
    http: async () => {
      throw new TypeError("fetch failed");
    },
    "network.allow": async () => undefined,
    system: async () => ({ platform: "linux", architecture: "x64", hostname: "desk", user: "seth" }),
  };
  /** `member` as the shell carries it: recorded, then answered by its responder as it stands at the call. */
  const recorded = <M extends ShellFunctionName>(member: M): ShellFunctions[M] =>
    ((...args: unknown[]) => {
      calls.push([member, ...args]);
      return (responders[member] as (...given: unknown[]) => unknown)(...args);
    }) as ShellFunctions[M];

  return {
    dialogs: { openFile: recorded("dialogs.openFile"), openDirectory: recorded("dialogs.openDirectory"), save: recorded("dialogs.save") },
    window: {
      setTitle: recorded("window.setTitle"),
      focus: recorded("window.focus"),
      setBadge: recorded("window.setBadge"),
      setBackgroundColour: recorded("window.setBackgroundColour"),
    },
    notifications: { show: recorded("notifications.show"), onActivate: recorded("notifications.onActivate") },
    tray: { setTooltip: recorded("tray.setTooltip"), onClick: recorded("tray.onClick") },
    deepLinks: { onOpen: recorded("deepLinks.onOpen") },
    webView: {
      create: recorded("webView.create"),
      attach: recorded("webView.attach"),
      navigate: recorded("webView.navigate"),
      destroy: recorded("webView.destroy"),
    },
    preview: { grant: recorded("preview.grant") },
    // The installer's members are the launcher workstream's to define (#354); it has none yet.
    installer: {},
    update: { check: recorded("update.check"), install: recorded("update.install") },
    service: { install: recorded("service.install"), start: recorded("service.start"), status: recorded("service.status") },
    clipboard: { readText: recorded("clipboard.readText"), writeText: recorded("clipboard.writeText"), readImage: recorded("clipboard.readImage") },
    openExternal: recorded("openExternal"),
    localGrant: { read: recorded("localGrant.read") },
    secrets: { get: recorded("secrets.get"), set: recorded("secrets.set"), delete: recorded("secrets.delete") },
    http: recorded("http"),
    network: { allow: recorded("network.allow") },
    system: recorded("system"),
    calls,
    answer(member, responder) {
      responders[member] = responder;
    },
    openDeepLink(url) {
      for (const listener of [...heard.links]) listener(url);
    },
    activateNotification(tag) {
      const shown = calls.some(([member, notification]) => member === "notifications.show" && (notification as { readonly tag?: string } | undefined)?.tag === tag);
      if (!shown) throw new Error(`No notification tagged ${JSON.stringify(tag)} was shown, so none can be clicked.`);
      for (const listener of [...heard.activations]) listener(tag);
    },
  };
};
