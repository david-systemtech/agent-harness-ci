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
  ElectronProtocol,
  ElectronSafeStorage,
  ElectronWindow,
  IpcCaller,
  RequestListener,
  SchemeRegistration,
  WindowOptions,
} from "../src/electron.js";
import { APP_URL } from "../src/schemes.js";

/**
 * Electron's main-process modules, faked for the desktop's tests: every
 * call recorded, and what Electron or the OS would start (a second launch, a
 * navigation, a request, an IPC message) fired by the test. No Electron
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
  emit(name: "second-instance" | "open-url" | "window-all-closed", ...args: unknown[]): void;
  /** Makes the app ready, when it was made with `ready: false`. */
  becomeReady(): void;
}

/** A navigation the test fired: whether a listener refused it. */
export interface Navigation {
  readonly prevented: boolean;
}

export interface FakeContents extends ElectronContents {
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
  readonly options: WindowOptions;
  readonly calls: Call[];
  readonly webContents: FakeContents;
  minimized: boolean;
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

export interface FakeElectron extends DesktopElectron {
  readonly app: FakeApp;
  readonly protocol: FakeProtocol;
  readonly ipcMain: FakeIpcMain;
  readonly dialog: FakeDialog;
  readonly clipboard: FakeClipboard;
  readonly shell: { openExternal(url: string): Promise<void>; readonly opened: string[] };
  readonly nativeTheme: { shouldUseDarkColors: boolean };
  readonly safeStorage: FakeSafeStorage;
  /** Every window opened, oldest first. */
  readonly windows: FakeWindow[];
  /** The one window; throws when none is open. */
  window(): FakeWindow;
}

const fakeApp = (os: ShellPlatform, ready: boolean): FakeApp => {
  const calls: Call[] = [];
  const heard = listeners();
  let makeReady = () => {};
  const whenReady = ready ? Promise.resolve() : new Promise<void>((resolve) => (makeReady = resolve));
  return {
    calls,
    locked: false,
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
    quit() {
      calls.push(["quit"]);
    },
    setBadgeCount(count) {
      calls.push(["setBadgeCount", count]);
      return os !== "win32";
    },
    dock: os === "darwin" ? { setBadge: (text: string) => void calls.push(["dock.setBadge", text]) } : undefined,
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
  return {
    sent,
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
      webRequest: {
        onBeforeRequest(listener) {
          requestHook = listener;
        },
      },
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
};

const fakeWindow = (options: WindowOptions): FakeWindow => {
  const calls: Call[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) =>
      void calls.push([method, ...args]);
  const window: FakeWindow = {
    options,
    calls,
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
      if (!storage.isEncryptionAvailable()) throw new Error("Error while encrypting the text provided to safeStorage.encryptString. Encryption is not available.");
      const prefix = os === "linux" && storage.backend === "basic_text" ? "v10" : `v11:${key}:`;
      return Buffer.concat([Buffer.from(prefix), scramble(Buffer.from(plainText, "utf8"))]);
    },
    decryptString(encrypted) {
      if (!storage.isEncryptionAvailable()) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString. Decryption is not available.");
      const text = encrypted.toString("latin1");
      const prefix = text.startsWith("v10") ? "v10" : `v11:${key}:`;
      if (!text.startsWith(prefix)) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
      return scramble(encrypted.subarray(prefix.length)).toString("utf8");
    },
    getSelectedStorageBackend: () => (os === "linux" ? storage.backend : "unknown"),
    setUsePlainTextEncryption(usePlainText) {
      storage.plainText = usePlainText;
    },
  };
  return storage;
};

/** Electron on `os`, ready at once unless `ready` is false (then `app.becomeReady()`), preferring dark unless `dark` is false. */
export const fakeElectron = ({ os = "linux", ready = true, dark = true }: { os?: ShellPlatform; ready?: boolean; dark?: boolean } = {}): FakeElectron => {
  const windows: FakeWindow[] = [];
  const opened: string[] = [];
  return {
    app: fakeApp(os, ready),
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
    windows,
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
};
