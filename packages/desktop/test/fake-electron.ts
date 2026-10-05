import type { ShellPlatform } from "@agent-harness/client-runtime";
import type {
  DesktopElectron,
  DialogFilter,
  ElectronApp,
  ElectronBrowserWindow,
  ElectronClipboard,
  ElectronContents,
  ElectronDialog,
  ElectronIpcMain,
  ElectronNotification,
  ElectronProtocol,
  ElectronSafeStorage,
  ElectronWindow,
  IpcCaller,
  NotificationOptions,
  RequestListener,
  SchemeRegistration,
  WindowOptions,
  ViewOptions,
  ViewBounds,
  ElectronWebView,
  MediaPermissionDetails,
} from "../src/electron.js";
import { APP_URL } from "../src/schemes.js";

/**
 * Electron's main-process modules, faked for the desktop's tests: every
 * call recorded, and what Electron or the OS would start (a second launch, a
 * navigation, a request, an IPC message, a click on a notification) fired by
 * the test. No Electron
 * binary is needed, so the tests run on any runner and drive any platform's
 * behaviour (`fakeElectron({ os })`).
 */

/** A call a fake was asked to make: the method's name, then every argument. */
export type Call = readonly [method: string, ...args: unknown[]];

type Heard = (...args: unknown[]) => unknown;

/** Listeners by name: `on` as Electron's modules have it, and `emit` for the test. */
const listeners = () => {
  const byName = new Map<string, Heard[]>();
  return {
    on(name: string, listener: (...args: never[]) => unknown): unknown {
      byName.set(name, [...(byName.get(name) ?? []), listener as Heard]);
      return undefined;
    },
    emit(name: string, ...args: unknown[]): void {
      for (const listener of byName.get(name) ?? []) listener(...args);
    },
  };
};

export interface FakeApp extends ElectronApp {
  readonly calls: Call[];
  /** Whether another instance holds the single-instance lock. */
  locked: boolean;
  /** Whether the app runs packaged, as an install does, rather than as `electron .` from a checkout. */
  isPackaged: boolean;
  emit(name: "second-instance" | "open-url" | "window-all-closed", ...args: unknown[]): void;
  /** Makes the app ready, when it was made with `ready: false`. */
  becomeReady(): void;
  /** Settles once a `quit()` has gone through: its `will-quit` was not refused. */
  readonly quitted: Promise<void>;
}

/** A navigation the test fired: whether a listener refused it. */
export interface Navigation {
  readonly prevented: boolean;
}

export interface FakeContents extends ElectronContents {
  getZoomFactor(): number;
  setZoomFactor(factor: number): void;
  press(key: string, modifiers?: Partial<{ code: string; type: string; control: boolean; meta: boolean; shift: boolean; alt: boolean }>): { prevented: boolean };
  checkPermission(permission: string, details: MediaPermissionDetails, origin?: string, source?: ElectronContents | null): boolean;
  requestPermission(permission: string, details: MediaPermissionDetails, source?: ElectronContents): boolean;
  on(name: string, listener: (...args: never[]) => unknown): unknown;
  /** Every message sent to the page, by channel. */
  readonly sent: Call[];
  /** Hears each later message sent to the page on `channel`, as the page's `ipcRenderer.on` does. */
  listen(channel: string, listener: (...args: unknown[]) => void): void;
  /** Fires `will-navigate` for `url`, as a link clicked or `location` set would: one details object, as Electron 25 and later hand it. */
  navigate(url: string): Navigation;
  /** Asks the window-open handler about `url`, as `window.open` or a `target="_blank"` link would. */
  openWindow(url: string): { readonly action: string };
  /** Asks the request hook about `url`: true when Chromium would cancel it. */
  cancels(url: string): boolean;
  /** The page logs `message` to its console at `level`, as `console.error` and the like do. */
  log(level: "info" | "warning" | "error" | "debug", message: string): void;
}

export interface FakeWindow extends ElectronBrowserWindow {
  readonly children: ElectronWebView[];
  close(): void;
  readonly options: WindowOptions;
  readonly calls: Call[];
  readonly webContents: FakeContents;
  minimized: boolean;
  maximized: boolean;
  focused: boolean;
  fullScreen: boolean;
  emit(name: "focus" | "blur" | "maximize" | "unmaximize" | "enter-full-screen" | "leave-full-screen"): void;
}

export interface FakeProtocol extends ElectronProtocol {
  readonly privileged: SchemeRegistration[];
  /** Asks the handler registered for `url`'s scheme, as Chromium would load it. */
  load(url: string): Promise<Response>;
}

export interface FakeIpcMain extends ElectronIpcMain {
  /** `ipcRenderer.invoke` from a frame at `from`: what the handler answered, or its rejection. */
  invoke(channel: string, args?: readonly unknown[], from?: string | null): Promise<unknown>;
  /** `ipcRenderer.send` from a frame at `from`. */
  send(channel: string, args?: readonly unknown[], from?: string | null): void;
  /** Every channel answered or heard. */
  readonly channels: () => string[];
}

export interface FakeDialog extends ElectronDialog {
  readonly calls: Call[];
  /** What the next open dialogs answer: the paths chosen, or undefined for a cancel. */
  opens: (readonly string[] | undefined)[];
  /** What the next save dialogs answer. */
  saves: (string | undefined)[];
}

export interface FakeClipboard extends ElectronClipboard {
  text: string;
  /** The picture the clipboard holds beside its text, if any. */
  image: { readonly bytes: Uint8Array; readonly mediaType: string } | undefined;
}

export interface FakeSafeStorage extends ElectronSafeStorage {
  /** The secret store Chromium chose on Linux: preset `gnome_libsecret`, a secret service answering; `basic_text` is none. */
  backend: string;
  /** Whether the OS keeps a key for the app (the Keychain, DPAPI, the secret service): preset true; false is one locked or gone. */
  keychain: boolean;
  /** Whether the app asked for Chromium's fixed key where no secret service answers (`setUsePlainTextEncryption(true)`). */
  readonly plainText: boolean;
  /** The OS's key changes, as on a new keychain: what it encrypted before no longer decrypts. */
  changeKey(): void;
}

/** An OS notification the desktop made: what it shows, whether it was shown, and the OS's clicks and closes, which the test fires. */
export interface FakeNotification extends ElectronNotification {
  readonly options: NotificationOptions;
  readonly shown: boolean;
  /** Clicks it, as a person does in the OS's notification centre. */
  click(): void;
  /** The OS takes it off, dismissed or timed out. */
  close(): void;
}

export interface FakeElectron extends DesktopElectron {
  readonly app: FakeApp;
  readonly protocol: FakeProtocol;
  readonly ipcMain: FakeIpcMain;
  readonly dialog: FakeDialog;
  readonly clipboard: FakeClipboard;
  readonly shell: { openExternal(url: string): Promise<void>; readonly opened: string[] };
  readonly nativeTheme: { shouldUseDarkColors: boolean };
  readonly safeStorage: FakeSafeStorage;
  /** Whether this OS shows notifications (`Notification.isSupported()`): preset true. */
  notificationsSupported: boolean;
  /** Every notification made, oldest first. */
  readonly notifications: FakeNotification[];
  /** Every window opened, oldest first. */
  readonly windows: FakeWindow[];
  readonly views: FakeWebView[];
  /** The one window; throws when none is open. */
  window(): FakeWindow;
}

const fakeApp = (os: ShellPlatform, ready: boolean, version: string): FakeApp => {
  const calls: Call[] = [];
  const heard = listeners();
  let makeReady = () => {};
  const whenReady = ready ? Promise.resolve() : new Promise<void>((resolve) => (makeReady = resolve));
  let quit = () => {};
  const quitted = new Promise<void>((resolve) => (quit = resolve));
  return {
    calls,
    locked: false,
    isPackaged: false,
    quitted,
    getVersion: () => version,
    requestSingleInstanceLock() {
      calls.push(["requestSingleInstanceLock"]);
      return !this.locked;
    },
    setAsDefaultProtocolClient(...args: [string, string?, string[]?]) {
      calls.push(["setAsDefaultProtocolClient", ...args]);
      return true;
    },
    setPath(name, path) {
      calls.push(["setPath", name, path]);
    },
    whenReady: () => whenReady,
    // As Electron does once the windows are closed: `will-quit`, whose listener may refuse it.
    quit() {
      calls.push(["quit"]);
      let refused = false;
      heard.emit("will-quit", { preventDefault: () => (refused = true) });
      if (!refused) quit();
    },
    relaunch() {
      calls.push(["relaunch"]);
    },
    setBadgeCount(count) {
      calls.push(["setBadgeCount", count]);
      return os !== "win32";
    },
    dock: os === "darwin" ? { setBadge: (text: string) => void calls.push(["dock.setBadge", text]) } : undefined,
    setAppUserModelId(id) {
      calls.push(["setAppUserModelId", id]);
    },
    on: heard.on,
    emit: heard.emit,
    becomeReady: () => makeReady(),
  };
};

const fakeContents = (): FakeContents => {
  const heard = listeners();
  const page = listeners();
  const sent: Call[] = [];
  let openHandler: ((details: { readonly url: string }) => { action: "deny" }) | undefined;
  let requestHook: RequestListener | undefined;
  let checkPermission: Parameters<ElectronContents["session"]["setPermissionCheckHandler"]>[0] | undefined;
  let requestPermission: Parameters<ElectronContents["session"]["setPermissionRequestHandler"]>[0] | undefined;
  let zoomFactor = 1;
  const contents: FakeContents = {
    sent,
    getZoomFactor: () => zoomFactor,
    setZoomFactor: (factor) => { zoomFactor = factor; },
    press(key, modifiers = {}) {
      let prevented = false;
      heard.emit("before-input-event", { preventDefault: () => { prevented = true; } }, { type: "keyDown", key, code: "", control: false, meta: false, shift: false, alt: false, ...modifiers });
      return { prevented };
    },
    on: heard.on,
    setWindowOpenHandler(handler) {
      openHandler = handler;
    },
    send(channel, ...args) {
      sent.push([channel, ...args]);
      page.emit(channel, ...args);
    },
    listen: page.on,
    session: {
      setPermissionCheckHandler(handler) { checkPermission = handler; },
      setPermissionRequestHandler(handler) { requestPermission = handler; },
      webRequest: {
        onBeforeRequest(listener) {
          requestHook = listener;
        },
      },
    },
    checkPermission(permission, details, origin = APP_URL, source = contents) {
      return checkPermission?.(source, permission, origin, details) ?? true;
    },
    requestPermission(permission, details, source = contents) {
      let allowed = true;
      requestPermission?.(source, permission, (answer) => { allowed = answer; }, details);
      return allowed;
    },
    navigate(url) {
      let prevented = false;
      heard.emit("will-navigate", { url, preventDefault: () => (prevented = true) });
      return { prevented };
    },
    openWindow(url) {
      if (!openHandler) throw new Error("No window-open handler is set: Chromium would open the window.");
      return openHandler({ url });
    },
    cancels(url) {
      if (!requestHook) throw new Error("No request hook is set: Chromium would make every request.");
      let answer: { cancel: boolean } | undefined;
      requestHook({ url }, (response) => (answer = response));
      if (!answer) throw new Error(`The request hook did not answer ${url}.`);
      return answer.cancel;
    },
    log(level, message) {
      heard.emit("console-message", { level, message, lineNumber: 1, sourceId: "agent-harness://app/assets/index.js" });
    },
  };
  return contents;
};

const fakeWindow = (options: WindowOptions): FakeWindow => {
  const events = listeners();
  let gone = false;
  const calls: Call[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) =>
      void calls.push([method, ...args]);
  const window: FakeWindow = {
    options,
    calls,
    children: [],
    addWebView: (view) => {
      if (gone) throw new Error("The window is closed.");
      window.children.push(view);
    },
    removeWebView: (view) => {
      if (gone) throw new Error("The window is closed.");
      const at = window.children.indexOf(view);
      if (at !== -1) window.children.splice(at, 1);
    },
    on: events.on,
    emit(name) {
      if (name === "focus" || name === "blur") window.focused = name === "focus";
      if (name === "maximize" || name === "unmaximize") window.maximized = name === "maximize";
      if (name === "enter-full-screen" || name === "leave-full-screen") window.fullScreen = name === "enter-full-screen";
      events.emit(name);
    },
    close: () => { calls.push(["close"]); gone = true; events.emit("closed"); },
    minimize: () => { calls.push(["minimize"]); window.minimized = true; },
    maximize: () => { calls.push(["maximize"]); window.emit("maximize"); },
    unmaximize: () => { calls.push(["unmaximize"]); window.emit("unmaximize"); },
    isFocused: () => window.focused,
    isMaximized: () => window.maximized,
    isFullScreen: () => window.fullScreen,
    maximized: false,
    focused: true,
    fullScreen: false,
    minimized: false,
    webContents: fakeContents(),
    setTitle: record("setTitle"),
    focus: record("focus"),
    show: record("show"),
    restore() {
      calls.push(["restore"]);
      window.minimized = false;
    },
    isMinimized: () => window.minimized,
    setBackgroundColor: record("setBackgroundColor"),
    flashFrame: record("flashFrame"),
    async loadURL(url) {
      calls.push(["loadURL", url]);
    },
  };
  return window;
};

const fakeProtocol = (): FakeProtocol => {
  const privileged: SchemeRegistration[] = [];
  const handlers = new Map<string, (request: { readonly url: string }) => Promise<Response>>();
  return {
    privileged,
    registerSchemesAsPrivileged(schemes) {
      privileged.push(...schemes);
    },
    handle(scheme, handler) {
      handlers.set(scheme, handler);
    },
    async load(url) {
      const handler = handlers.get(new URL(url).protocol.slice(0, -1));
      if (!handler) throw new Error(`No handler for ${url}: Chromium would fail to load it.`);
      return handler(new Request(url));
    },
  };
};

const fakeIpcMain = (): FakeIpcMain => {
  const answered = new Map<string, (caller: IpcCaller, ...args: unknown[]) => unknown>();
  const heard = new Map<string, (caller: IpcCaller, ...args: unknown[]) => void>();
  const caller = (from: string | null): IpcCaller => ({ senderFrame: from === null ? null : { url: from } });
  return {
    handle(channel, listener) {
      if (answered.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
      answered.set(channel, listener);
    },
    on(channel, listener) {
      heard.set(channel, listener);
      return undefined;
    },
    async invoke(channel, args = [], from = APP_URL) {
      const listener = answered.get(channel);
      if (!listener) throw new Error(`No handler registered for '${channel}'`);
      return listener(caller(from), ...args);
    },
    send(channel, args = [], from = APP_URL) {
      heard.get(channel)?.(caller(from), ...args);
    },
    channels: () => [...answered.keys(), ...heard.keys()],
  };
};

const fakeDialog = (): FakeDialog => {
  const calls: Call[] = [];
  const dialog: FakeDialog = {
    calls,
    opens: [],
    saves: [],
    async showOpenDialog(window: ElectronWindow, options: { title?: string; filters?: DialogFilter[]; properties: string[] }) {
      calls.push(["showOpenDialog", window, options]);
      const chosen = dialog.opens.shift();
      return chosen === undefined ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [...chosen] };
    },
    async showSaveDialog(window, options) {
      calls.push(["showSaveDialog", window, options]);
      const chosen = dialog.saves.shift();
      return chosen === undefined ? { canceled: true, filePath: "" } : { canceled: false, filePath: chosen };
    },
  };
  return dialog;
};

const fakeClipboard = (): FakeClipboard => {
  const clipboard: FakeClipboard = {
    text: "",
    image: undefined,
    readText: async () => clipboard.text,
    async writeText(text) {
      clipboard.text = text;
    },
    // One item holding the text, as the OS offers it, and the picture beside it.
    async read() {
      const { text, image } = clipboard;
      const offered: Record<string, Blob> = {
        ...(text !== "" && { "text/plain": new Blob([text], { type: "text/plain" }) }),
        ...(image !== undefined && { [image.mediaType]: new Blob([image.bytes], { type: image.mediaType }) }),
      };
      if (Object.keys(offered).length === 0) return [];
      return [{ types: Object.keys(offered), getType: async (type) => offered[type] ?? Promise.reject(new Error(`No ${type} on the clipboard.`)) }];
    },
  };
  return clipboard;
};

/**
 * `safeStorage` as Electron gives it on `os`: encryption available while the
 * OS keeps a key, and on Linux while a secret service answers, or once the
 * app takes Chromium's fixed key where none does. What it encrypts starts
 * with Chromium's version prefix (`v11` under the OS's key, `v10` under the
 * fixed one) and does not hold the text as it was.
 */
const fakeSafeStorage = (os: ShellPlatform): FakeSafeStorage => {
  let key = 1;
  const scramble = (bytes: Uint8Array) => Buffer.from(bytes.map((byte) => byte ^ 0x5a));
  const storage: FakeSafeStorage & { plainText: boolean } = {
    backend: "gnome_libsecret",
    keychain: true,
    plainText: false,
    changeKey: () => void key++,
    isEncryptionAvailable() {
      if (os !== "linux") return storage.keychain;
      return storage.backend === "basic_text" ? storage.plainText : storage.keychain;
    },
    encryptString(plainText) {
      if (!available()) throw new Error("Error while encrypting the text provided to safeStorage.encryptString. Encryption is not available.");
      const prefix = os === "linux" && storage.backend === "basic_text" ? "v10" : `v11:${key}:`;
      return Buffer.concat([Buffer.from(prefix), scramble(Buffer.from(plainText, "utf8"))]);
    },
    decryptString(encrypted) {
      if (!available()) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString. Decryption is not available.");
      const text = encrypted.toString("latin1");
      const prefix = text.startsWith("v10") ? "v10" : `v11:${key}:`;
      if (!text.startsWith(prefix)) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
      return scramble(encrypted.subarray(prefix.length)).toString("utf8");
    },
    async isAsyncEncryptionAvailable() { return storage.keychain; },
    async encryptStringAsync(plainText) { return encrypt(plainText); },
    async decryptStringAsync(encrypted) { return { result: decrypt(encrypted), shouldReEncrypt: false }; },
    getSelectedStorageBackend: () => (os === "linux" ? storage.backend : "unknown"),
    setUsePlainTextEncryption(usePlainText) {
      storage.plainText = usePlainText;
    },
  };
  const available = storage.isEncryptionAvailable;
  const encrypt = storage.encryptString;
  const decrypt = storage.decryptString;
  return storage;
};

const fakeNotification = (options: NotificationOptions): FakeNotification => {
  const heard = listeners();
  const notification = {
    options,
    shown: false,
    on: heard.on,
    show() {
      notification.shown = true;
    },
    click: () => heard.emit("click"),
    close: () => heard.emit("close"),
  };
  return notification;
};

/**
 * Electron on `os`, ready at once unless `ready` is false (then
 * `app.becomeReady()`), preferring dark unless `dark` is false, the app at
 * `version` (preset 0.5.0) and run from a checkout until the test sets
 * `app.isPackaged`.
 */
export const fakeElectron = ({
  os = "linux",
  ready = true,
  dark = true,
  version = "0.5.0",
}: { os?: ShellPlatform; ready?: boolean; dark?: boolean; version?: string } = {}): FakeElectron => {
  const windows: FakeWindow[] = [];
  const views: FakeWebView[] = [];
  const opened: string[] = [];
  const notifications: FakeNotification[] = [];
  const electron: FakeElectron = {
    app: fakeApp(os, ready, version),
    protocol: fakeProtocol(),
    ipcMain: fakeIpcMain(),
    dialog: fakeDialog(),
    clipboard: fakeClipboard(),
    shell: {
      opened,
      async openExternal(url) {
        opened.push(url);
      },
    },
    nativeTheme: { shouldUseDarkColors: dark },
    safeStorage: fakeSafeStorage(os),
    notificationsSupported: true,
    notifications,
    notification: {
      isSupported: () => electron.notificationsSupported,
      create(options) {
        const made = fakeNotification(options);
        notifications.push(made);
        return made;
      },
    },
    windows,
    views,
    openWebView(options) {
      const view = fakeWebView(options);
      views.push(view);
      return view;
    },
    openWindow(options) {
      const window = fakeWindow(options);
      windows.push(window);
      return window;
    },
    window() {
      const [only] = windows;
      if (!only) throw new Error("No window is open.");
      return only;
    },
  };
  return electron;
};

export interface FakeWebView extends ElectronWebView {
  readonly options: ViewOptions;
  bounds: ViewBounds;
  visible: boolean;
  closed: boolean;
  readonly urls: string[];
  reloads: number;
  stops: number;
  holdNextLoad(): { finish(): void; fail(error: unknown): void };
  startLoading(mainFrame?: boolean): void;
  finishLoading(mainFrame?: boolean, otherFramesLoading?: boolean): void;
  press(key: string, modifiers?: { control?: boolean; meta?: boolean; shift?: boolean; alt?: boolean }): void;
  readonly webContents: FakeContents & ElectronWebView["webContents"] & { readonly debugger: ElectronWebView["webContents"]["debugger"] & {
    readonly commands: unknown[];
    emit(name: string, ...args: unknown[]): void;
  } };
}
const fakeWebView = (options: ViewOptions): FakeWebView => {
  const events = listeners();
  const contents = fakeContents();
  const debugEvents = listeners();
  let attached = false;
  const commands: unknown[] = [];
  let loading = false;
  let nextLoad: Promise<void> | undefined;
  let abortLoad: (() => void) | undefined;
  let at = -1;
  const moved = () => events.emit("did-navigate");
  const view: FakeWebView = {
    options,
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    visible: false,
    closed: false,
    urls: [],
    reloads: 0,
    stops: 0,
    holdNextLoad() {
      let finish!: () => void;
      let fail!: (error: unknown) => void;
      nextLoad = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
      abortLoad = () => fail(Object.assign(new Error("Navigation aborted"), { code: "ERR_ABORTED", errno: -3 }));
      return { finish, fail };
    },
    startLoading(mainFrame = true) {
      if (mainFrame) loading = true;
      events.emit("did-start-navigation", { isMainFrame: mainFrame, isSameDocument: false });
      events.emit("did-start-loading");
    },
    finishLoading(mainFrame = true, otherFramesLoading = false) {
      if (mainFrame) loading = false;
      events.emit("did-frame-finish-load", {}, mainFrame);
      if (!loading && !otherFramesLoading) events.emit("did-stop-loading");
    },
    press: (key, modifiers = {}) => events.emit("before-input-event", { preventDefault: () => undefined }, { type: "keyDown", key, code: `Key${key.toUpperCase()}`, control: false, meta: false, shift: false, alt: false, ...modifiers }),
    webContents: {
      ...contents,
      debugger: {
        commands,
        emit: debugEvents.emit,
        on: debugEvents.on,
        isAttached: () => attached,
        attach: () => { attached = true; },
        detach: () => { attached = false; debugEvents.emit("detach", {}, "target_closed"); },
        sendCommand: async (method, params, sessionId) => {
          if (!attached) throw new Error("The debugger is not attached.");
          commands.push([method, params, sessionId]);
          return {};
        },
      },
      on: (name: string, listener: (...args: never[]) => unknown) => {
        contents.on(name, listener);
        events.on(name, listener);
      },
      loadURL: async (url) => {
        const held = nextLoad;
        nextLoad = undefined;
        view.startLoading();
        view.urls.splice(at + 1);
        view.urls.push(url);
        at++;
        moved();
        try { await held; } finally { abortLoad = undefined; view.finishLoading(); }
      },
      getURL: () => view.urls[at] ?? "",
      isLoadingMainFrame: () => loading,
      stop: () => { view.stops++; abortLoad?.(); view.finishLoading(); },
      close: () => {
        view.closed = true;
      },
      reload: () => {
        view.reloads++;
        events.emit("did-stop-loading");
      },
      navigationHistory: {
        canGoBack: () => at > 0,
        canGoForward: () => at < view.urls.length - 1,
        goBack: () => {
          at--;
          moved();
        },
        goForward: () => {
          at++;
          moved();
        },
      },
    },
    setBounds: (bounds) => {
      view.bounds = bounds;
    },
    setVisible: (visible) => {
      view.visible = visible;
    },
  };
  return view;
};
