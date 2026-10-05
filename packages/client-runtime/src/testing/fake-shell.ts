import { PRODUCT_NAME } from "@agent-harness/contracts";
import type { GrantReader, HttpFetch, SecretStore } from "../platform.js";
import type {
  Shell,
  ShellCamera,
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
  ShellTray,
  ShellUpdate,
  ShellWebView,
  ShellWebViewState,
  ShellWebViewKey,
  ShellWindow,
  ShellWindowState,
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
  "dialogs.openFileContents": ShellDialogs["openFileContents"];
  "dialogs.openDirectory": ShellDialogs["openDirectory"];
  "dialogs.save": ShellDialogs["save"];
  "window.minimize": NonNullable<ShellWindow["minimize"]>;
  "window.toggleMaximize": NonNullable<ShellWindow["toggleMaximize"]>;
  "window.close": NonNullable<ShellWindow["close"]>;
  "window.state": NonNullable<ShellWindow["state"]>;
  "window.onChange": NonNullable<ShellWindow["onChange"]>;
  "window.setTitle": ShellWindow["setTitle"];
  "window.focus": ShellWindow["focus"];
  "window.setBadge": ShellWindow["setBadge"];
  "window.setBackgroundColour": ShellWindow["setBackgroundColour"];
  "notifications.show": NonNullable<ShellNotifications["show"]>;
  "notifications.onActivate": NonNullable<ShellNotifications["onActivate"]>;
  "tray.setTooltip": ShellTray["setTooltip"];
  "tray.onClick": ShellTray["onClick"];
  "deepLinks.onOpen": NonNullable<ShellDeepLinks["onOpen"]>;
  "webView.debugger.attach": NonNullable<ShellWebView["debugger"]>["attach"];
  "webView.debugger.send": NonNullable<ShellWebView["debugger"]>["send"];
  "webView.debugger.detach": NonNullable<ShellWebView["debugger"]>["detach"];
  "webView.debugger.onEvent": NonNullable<ShellWebView["debugger"]>["onEvent"];
  "webView.debugger.onDetach": NonNullable<ShellWebView["debugger"]>["onDetach"];
  "webView.create": ShellWebView["create"];
  "webView.attach": ShellWebView["attach"];
  "webView.hide": ShellWebView["hide"];
  "webView.back": ShellWebView["back"];
  "webView.forward": ShellWebView["forward"];
  "webView.reload": ShellWebView["reload"];
  "webView.stop": ShellWebView["stop"];
  "webView.state": ShellWebView["state"];
  "webView.onChange": ShellWebView["onChange"];
  "webView.onKey": ShellWebView["onKey"];

  "webView.navigate": ShellWebView["navigate"];
  "webView.destroy": ShellWebView["destroy"];
  "preview.grant": ShellPreview["grant"];
  "installer.bundledServer": ShellInstaller["bundledServer"];
  "installer.reserveSpace": NonNullable<ShellInstaller["reserveSpace"]>;
  "update.current": ShellUpdate["current"];
  "update.apply": ShellUpdate["apply"];
  "service.pendingUpdate": NonNullable<ShellService["pendingUpdate"]>;
  "service.applyUpdateNow": NonNullable<ShellService["applyUpdateNow"]>;
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
  "secrets.access": NonNullable<ShellSecrets["access"]>;
  "secrets.onAccess": NonNullable<ShellSecrets["onAccess"]>;
  "secrets.protection": NonNullable<ShellSecrets["protection"]>;
  http: HttpFetch;
  "network.allow": ShellNetwork["allow"];
  system: NonNullable<Shell["system"]>;
  "gh.token": ShellGh["token"];
  "camera.scanQr": ShellCamera["scanQr"];
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
  readonly secrets: Required<ShellSecrets>;
  /** Every call, oldest first. */
  readonly calls: readonly ShellCall[];
  /** Answers every later call of `member` with `responder`, still recording it. */
  answer<M extends ScriptableShellFunction>(member: M, responder: ShellFunctions[M]): void;
  /** Opens `url` as the desktop does a deep link: every listener `deepLinks.onOpen` holds now hears it. */
  openDeepLink(url: string): void;
  changeSecretAccess(state: SecretAccess): void;
  changeWindow(state: ShellWindowState): void;
  changeWebView(id: string, state: ShellWebViewState): void;
  pressWebViewKey(id: string, key: ShellWebViewKey): void;
  /** Clicks the notification shown with `tag`: every listener `notifications.onActivate` holds now is handed the tag. Throws when none was shown with it. */
  activateNotification(tag: string): void;
};

export const fakeShell = (): FakeShell => {
  const calls: ShellCall[] = [];
  const secrets = new Map<string, string>();
  let access: SecretAccess = null;
  const accessListeners = new Set<(state: SecretAccess) => void>();
  const heard = { links: new Set<(url: string) => void>(), activations: new Set<(tag: string) => void>() };
  const keyListeners = new Set<(id: string, key: ShellWebViewKey) => void>();
  const windowListeners = new Set<(state: ShellWindowState) => void>();
  const viewListeners = new Set<(id: string, state: ShellWebViewState) => void>();
  const viewStates = new Map<string, ShellWebViewState>();
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
    "dialogs.openFileContents": async () => [],
    "dialogs.openDirectory": async () => undefined,
    "dialogs.save": async () => undefined,
    "window.minimize": () => undefined,
    "window.toggleMaximize": () => undefined,
    "window.close": () => undefined,
    "window.state": async () => undefined,
    "window.onChange": listen(windowListeners),
    "window.setTitle": () => undefined,
    "window.focus": () => undefined,
    "window.setBadge": () => undefined,
    "window.setBackgroundColour": () => undefined,
    "notifications.show": async () => undefined,
    "notifications.onActivate": listen(heard.activations),
    "tray.setTooltip": () => undefined,
    "tray.onClick": () => () => undefined,
    "deepLinks.onOpen": listen(heard.links),
    "webView.create": async ({ url }) => {
      const id = `view-${++views}`;
      viewStates.set(id, { url, canGoBack: false, canGoForward: false, loading: false });
      return id;
    },
    "webView.debugger.attach": async () => undefined,
    "webView.debugger.send": async () => ({}),
    "webView.debugger.detach": async () => undefined,
    "webView.debugger.onEvent": () => () => undefined,
    "webView.debugger.onDetach": () => () => undefined,
    "webView.attach": () => undefined,
    "webView.hide": () => undefined,
    "webView.navigate": async (id, url) => {
      const state = { url, canGoBack: true, canGoForward: false, loading: false };
      viewStates.set(id, state);
      for (const listener of viewListeners) listener(id, state);
    },
    "webView.state": async (id) => {
      const state = viewStates.get(id);
      if (!state) throw new Error("The browser page is closed.");
      return state;
    },
    "webView.onKey": (listener) => { keyListeners.add(listener); return () => void keyListeners.delete(listener); },
    "webView.back": () => undefined,
    "webView.forward": () => undefined,
    "webView.reload": () => undefined,
    "webView.stop": (id) => {
      const held = viewStates.get(id);
      if (!held) throw new Error("The browser page is closed.");
      const state = { ...held, loading: false };
      viewStates.set(id, state);
      for (const listener of viewListeners) listener(id, state);
    },
    "webView.onChange": (listener) => {
      viewListeners.add(listener);
      return () => void viewListeners.delete(listener);
    },
    "webView.destroy": (id) => { viewStates.delete(id); },
    "preview.grant": async () => `${PRODUCT_NAME}-preview://fake/${++previews}`,
    // Carries no server artefact, as a desktop run from a checkout; runs a build that updates itself, and applies one when asked.
    "installer.bundledServer": async () => null,
    "installer.reserveSpace": async () => ({ availableBytes: 1024 * 1024 * 1024, requiredBytes: 256 * 1024 * 1024 }),
    "update.current": async () => ({ version: "0.0.0-test", platform: "linux", arch: "x64", format: "pacman" }),
    "update.apply": async () => ({ outcome: "applied" }),
    "service.pendingUpdate": async () => ({ state: "current" }),
    "service.applyUpdateNow": async () => undefined,
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
    // A keychain whose key the OS keeps, until the test scripts one that stores tokens unprotected.
    "secrets.protection": async () => "os",
    "secrets.access": async () => access,
    "secrets.onAccess": (listener) => {
      accessListeners.add(listener);
      listener(access);
      return () => void accessListeners.delete(listener);
    },
    // Nothing answers until the test scripts it: a request fails as one to an address with nothing listening does.
    http: async () => {
      throw new TypeError("fetch failed");
    },
    "network.allow": async () => undefined,
    system: async () => ({ platform: "linux", architecture: "x64", hostname: "desk", user: "milo" }),
    // A computer whose gh is signed in nowhere until the test scripts a token.
    "gh.token": async () => undefined,
    // A camera the person closes before it reads a code, until the test scripts one it reads.
    "camera.scanQr": async () => undefined,
  };
  /** `member` as the shell carries it: recorded, then answered by its responder as it stands at the call. */
  const recorded = <M extends ShellFunctionName>(member: M): ShellFunctions[M] =>
    ((...args: unknown[]) => {
      calls.push([member, ...args]);
      return (responders[member] as (...given: unknown[]) => unknown)(...args);
    }) as ShellFunctions[M];

  return {
    dialogs: {
      openFile: recorded("dialogs.openFile"),
      openFileContents: recorded("dialogs.openFileContents"),
      openDirectory: recorded("dialogs.openDirectory"),
      save: recorded("dialogs.save"),
    },
    window: {
      minimize: recorded("window.minimize"),
      toggleMaximize: recorded("window.toggleMaximize"),
      close: recorded("window.close"),
      state: recorded("window.state"),
      onChange: recorded("window.onChange"),
      setTitle: recorded("window.setTitle"),
      focus: recorded("window.focus"),
      setBadge: recorded("window.setBadge"),
      setBackgroundColour: recorded("window.setBackgroundColour"),
    },
    notifications: { show: recorded("notifications.show"), onActivate: recorded("notifications.onActivate") },
    tray: { setTooltip: recorded("tray.setTooltip"), onClick: recorded("tray.onClick") },
    deepLinks: { onOpen: recorded("deepLinks.onOpen") },
    webView: {
      debugger: {
        attach: recorded("webView.debugger.attach"),
        send: recorded("webView.debugger.send"),
        detach: recorded("webView.debugger.detach"),
        onEvent: recorded("webView.debugger.onEvent"),
        onDetach: recorded("webView.debugger.onDetach"),
      },
      create: recorded("webView.create"),
      attach: recorded("webView.attach"),
      hide: recorded("webView.hide"),
      back: recorded("webView.back"),
      forward: recorded("webView.forward"),
      reload: recorded("webView.reload"),
      stop: recorded("webView.stop"),
      state: recorded("webView.state"),
      onChange: recorded("webView.onChange"),
      onKey: recorded("webView.onKey"),

      navigate: recorded("webView.navigate"),
      destroy: recorded("webView.destroy"),
    },
    preview: { grant: recorded("preview.grant") },
    installer: { bundledServer: recorded("installer.bundledServer"), reserveSpace: recorded("installer.reserveSpace") },
    update: { current: recorded("update.current"), apply: recorded("update.apply") },
    service: { pendingUpdate: recorded("service.pendingUpdate"), applyUpdateNow: recorded("service.applyUpdateNow"), install: recorded("service.install"), start: recorded("service.start"), status: recorded("service.status") },
    clipboard: { readText: recorded("clipboard.readText"), writeText: recorded("clipboard.writeText"), readImage: recorded("clipboard.readImage") },
    openExternal: recorded("openExternal"),
    localGrant: { read: recorded("localGrant.read") },
    secrets: { access: recorded("secrets.access"), onAccess: recorded("secrets.onAccess"), get: recorded("secrets.get"), set: recorded("secrets.set"), delete: recorded("secrets.delete"), protection: recorded("secrets.protection") },
    http: recorded("http"),
    network: { allow: recorded("network.allow") },
    system: recorded("system"),
    gh: { token: recorded("gh.token") },
    camera: { scanQr: recorded("camera.scanQr") },
    calls,
    answer(member, responder) {
      responders[member] = responder;
    },
    pressWebViewKey(id, key) { for (const listener of keyListeners) listener(id, key); },
    changeSecretAccess(state) {
      access = state;
      for (const listener of [...accessListeners]) listener(state);
    },
    changeWindow(state) { for (const listener of [...windowListeners]) listener(state); },
    changeWebView(id, state) {
      viewStates.set(id, state);
      for (const listener of viewListeners) listener(id, state);
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
