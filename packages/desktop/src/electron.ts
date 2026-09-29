/**
 * The parts of Electron's main-process modules the desktop uses, typed as
 * Electron types them but no wider, so `main.ts` hands in Electron's own and
 * a test hands in fakes (`test/fake-electron.ts`) on any runner, with no
 * Electron binary. Each is a structural subset: tsc checks in `main.ts` that
 * Electron's modules satisfy it.
 *
 * Nothing here names a session, run, group or event (ADR 0004): the lint
 * `agent-harness/no-session-types-in-shell` covers this package, so what
 * Electron passes a listener is typed by what the desktop reads of it.
 */

/** What Electron hands a listener that may refuse what it heard: a navigation, a URL opened. */
export interface Refusable {
  preventDefault(): void;
}

/** The `app` module. */
export interface ElectronApp {
  requestSingleInstanceLock(): boolean;
  setAsDefaultProtocolClient(protocol: string, path?: string, args?: string[]): boolean;
  setPath(name: "userData", path: string): void;
  whenReady(): Promise<void>;
  quit(): void;
  /** macOS and Linux (docks and taskbars with the LauncherEntry API). */
  setBadgeCount(count?: number): boolean;
  /** macOS only; undefined elsewhere. */
  readonly dock: { setBadge(text: string): void } | undefined;
  /** A second launch: its command line, where Windows and Linux put the deep link it was opened with. */
  on(name: "second-instance", listener: (details: unknown, argv: string[]) => void): unknown;
  /** macOS: a deep link opened, before or after the app is ready. */
  on(name: "open-url", listener: (details: Refusable, url: string) => void): unknown;
  on(name: "window-all-closed", listener: () => void): unknown;
}

/** A scheme's registration with Chromium, before the app is ready. */
export interface SchemeRegistration {
  scheme: string;
  privileges: { standard: boolean; secure: boolean; supportFetchAPI: boolean; corsEnabled: boolean };
}

/** The `protocol` module. */
export interface ElectronProtocol {
  registerSchemesAsPrivileged(schemes: SchemeRegistration[]): void;
  handle(scheme: string, handler: (request: { readonly url: string }) => Promise<Response>): void;
}

/** The frame an IPC message came from, as Electron hands it to a handler. */
export interface IpcCaller {
  /** Null once the frame has navigated away or gone. */
  readonly senderFrame: { readonly url: string } | null;
}

/** The `ipcMain` module. */
export interface ElectronIpcMain {
  /** Answers `ipcRenderer.invoke` on `channel`: what the listener returns, or its rejection. */
  handle(channel: string, listener: (caller: IpcCaller, ...args: unknown[]) => unknown): void;
  /** Hears `ipcRenderer.send` on `channel`: nothing is answered. */
  on(channel: string, listener: (caller: IpcCaller, ...args: unknown[]) => void): unknown;
}

/** A top-level window as the dialogs take it: `BaseWindow`'s members the desktop uses. */
export interface ElectronWindow {
  setTitle(title: string): void;
  focus(): void;
  show(): void;
  restore(): void;
  isMinimized(): boolean;
  setBackgroundColor(colour: string): void;
  /** Asks for attention on the taskbar button until the window is focused (Windows), or sets the urgency hint (Linux). */
  flashFrame(flag: boolean): void;
}

/** What Electron hands a navigation's listener. */
export interface NavigationDetails extends Refusable {
  readonly url: string;
}

/** One request Chromium is about to make, and the answer to it. */
export type RequestListener = (details: { readonly url: string }, answer: (response: { cancel: boolean }) => void) => void;

/** A message the page logged to its console, as Electron hands it to `console-message`'s listener. */
export interface ConsoleMessage {
  /** `info`, `warning`, `error` or `debug`. */
  readonly level: string;
  readonly message: string;
  readonly lineNumber: number;
  /** The script that logged it. */
  readonly sourceId: string;
}

/** The window's page: `BrowserWindow.webContents`. */
export interface ElectronContents {
  /**
   * Electron (25 and later) hands `will-navigate` one details object,
   * `Event<WebContentsWillNavigateEventParams>`: the URL beside
   * `preventDefault`. The positional arguments after it are deprecated.
   */
  on(name: "will-navigate", listener: (details: NavigationDetails) => void): unknown;
  /** The page logged to its console: one details object, as Electron (35 and later) hands it; the positional arguments after it are deprecated. */
  on(name: "console-message", listener: (details: ConsoleMessage) => void): unknown;
  setWindowOpenHandler(handler: (details: { readonly url: string }) => { action: "deny" }): void;
  send(channel: string, ...args: unknown[]): void;
  /** The window's Chromium profile; the desktop reads its request hook only. */
  readonly session: { readonly webRequest: { onBeforeRequest(listener: RequestListener): void } };
}

/** The window the renderer loads in: `BrowserWindow`. */
export interface ElectronBrowserWindow extends ElectronWindow {
  readonly webContents: ElectronContents;
  loadURL(url: string): Promise<void>;
}

/** The `BrowserWindow` options the desktop sets. */
export interface WindowOptions {
  title: string;
  width: number;
  height: number;
  backgroundColor: string;
  webPreferences: {
    preload: string;
    sandbox: boolean;
    contextIsolation: boolean;
    nodeIntegration: boolean;
    nodeIntegrationInWorker: boolean;
    nodeIntegrationInSubFrames: boolean;
    webSecurity: boolean;
    allowRunningInsecureContent: boolean;
    webviewTag: boolean;
  };
}

/** A filter of the native file dialogs. */
export interface DialogFilter {
  name: string;
  extensions: string[];
}

/** The `dialog` module, always modal to the window. */
export interface ElectronDialog {
  showOpenDialog(
    window: ElectronWindow,
    options: { title?: string; filters?: DialogFilter[]; properties: ("openFile" | "openDirectory" | "multiSelections" | "createDirectory")[] },
  ): Promise<{ canceled: boolean; filePaths: string[] }>;
  showSaveDialog(window: ElectronWindow, options: { title?: string; defaultPath?: string; filters?: DialogFilter[] }): Promise<{ canceled: boolean; filePath?: string }>;
}

/** One item on the clipboard: the media types it offers, and each one's content. */
export interface ClipboardEntry {
  readonly types: string[];
  /** A `Blob` for a media type (a bookmark for Electron's own). */
  getType(type: string): Promise<unknown>;
}

/** The `clipboard` module, modelled on the W3C's asynchronous clipboard. */
export interface ElectronClipboard {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
  read(): Promise<ClipboardEntry[]>;
}

/**
 * The `safeStorage` module: text encrypted under a key the OS keeps for the
 * app (the macOS Keychain, Windows' DPAPI, a Linux secret service), usable
 * once the app is ready.
 */
export interface ElectronSafeStorage {
  isEncryptionAvailable(): boolean;
  /** Throws when encryption is not available. */
  encryptString(plainText: string): Buffer;
  /** Throws when encryption is not available, or `encrypted` was not encrypted under this key. */
  decryptString(encrypted: Buffer): string;
  /** Linux only: the secret store Chromium chose, `basic_text` when no secret service answers. */
  getSelectedStorageBackend(): string;
  /** Linux only: lets `basic_text` encrypt, under Chromium's fixed key. */
  setUsePlainTextEncryption(usePlainText: boolean): void;
}

/** Electron's main-process modules, and the window's constructor, as the desktop takes them. */
export interface DesktopElectron {
  readonly app: ElectronApp;
  readonly protocol: ElectronProtocol;
  readonly ipcMain: ElectronIpcMain;
  readonly dialog: ElectronDialog;
  readonly clipboard: ElectronClipboard;
  /** The `shell` module: a link opened in the OS's browser. */
  readonly shell: { openExternal(url: string): Promise<void> };
  /** Whether the OS prefers dark: which of the preset's ladders the first window opens on. */
  readonly nativeTheme: { readonly shouldUseDarkColors: boolean };
  readonly safeStorage: ElectronSafeStorage;
  /** `new BrowserWindow(options)`. */
  openWindow(options: WindowOptions): ElectronBrowserWindow;
}
