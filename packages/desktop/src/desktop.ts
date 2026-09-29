import { PRODUCT_NAME } from "@agent-harness/contracts";
import { APP_SCHEME_REGISTRATION, serveApp } from "./app-scheme.js";
import { canvasStore, presetCanvas } from "./canvas.js";
import { ANSWERED, channelOf, TOLD } from "./channels.js";
import { deepLinkIn, deepLinkInbox } from "./deep-links.js";
import type { DesktopElectron, ElectronBrowserWindow, ElectronIpcMain, IpcCaller, WindowOptions } from "./electron.js";
import { lockNavigation, lockNetwork } from "./lockdown.js";
import { bringForward, shellMembers, type Members } from "./members.js";
import type { DesktopPlatform } from "./platform.js";
import { APP_SCHEME, APP_URL, isAppPage } from "./schemes.js";

/**
 * The desktop's main process (docs/specs/gui.md, "The desktop shell"): one
 * instance and one window, the renderer loaded from the app scheme behind
 * four hardening layers, and the shell's members answered over IPC. Nothing
 * about sessions crosses it (ADR 0004): deep links are strings the runtime
 * parses. Electron's modules and the platform are handed in (`main.ts`
 * hands in the real ones), so a test drives any platform on any runner.
 */

/** The four layers' first: the renderer is sandboxed and isolated, with no Node, and the preload its one bridge. */
const windowOptions = (platform: DesktopPlatform, backgroundColor: string): WindowOptions => ({
  title: PRODUCT_NAME,
  width: 1280,
  height: 800,
  backgroundColor,
  webPreferences: {
    preload: platform.paths.preload,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
  },
});

/** Refuses a call from anything but the app's own page: a frame gone, or one on another origin. */
const fromApp = (caller: IpcCaller): void => {
  if (caller.senderFrame === null || !isAppPage(caller.senderFrame.url)) {
    throw new Error("The desktop shell answers the app's own page only.");
  }
};

/** Answers each member on its channel, for the app's page alone; a told member's refusal is reported, having no caller to reach. */
const serveShell = (ipcMain: ElectronIpcMain, members: Members, reportError: (error: unknown) => void): void => {
  for (const member of ANSWERED) {
    ipcMain.handle(channelOf(member), (caller, ...args) => {
      fromApp(caller);
      return members[member](...args);
    });
  }
  for (const member of TOLD) {
    ipcMain.on(channelOf(member), (caller, ...args) => {
      try {
        fromApp(caller);
        members[member](...args);
      } catch (error) {
        reportError(error);
      }
    });
  }
};

export interface DesktopOptions {
  /** Hears a fault with no caller to hand it to: a refused told member, a window that failed to load. */
  readonly reportError?: (error: unknown) => void;
}

/**
 * Starts the desktop: resolves once its window has loaded, or at once when
 * another instance holds the lock, which this one hands its launch to by
 * quitting. The steps before the first `await` run before the app is ready,
 * as Electron requires of the lock, the data path, the scheme's privileges
 * and the macOS `open-url` listener.
 */
export const startDesktop = async (electron: DesktopElectron, platform: DesktopPlatform, { reportError = console.error }: DesktopOptions = {}): Promise<void> => {
  const { app, protocol } = electron;
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.setPath("userData", platform.paths.data);
  protocol.registerSchemesAsPrivileged([APP_SCHEME_REGISTRATION]);
  if (platform.relaunch) app.setAsDefaultProtocolClient(APP_SCHEME, platform.relaunch.executable, [...platform.relaunch.args]);
  else app.setAsDefaultProtocolClient(APP_SCHEME);

  const links = deepLinkInbox();
  const launchLink = deepLinkIn(platform.argv);
  if (launchLink !== undefined) links.open(launchLink);
  /** The window once it is open: a deep link or a second launch before then has nothing to bring forward. */
  const shown: { window?: ElectronBrowserWindow } = {};
  app.on("open-url", (details, url) => {
    details.preventDefault();
    links.open(url);
    if (shown.window) bringForward(shown.window);
  });
  app.on("second-instance", (_details, argv) => {
    if (shown.window) bringForward(shown.window);
    const link = deepLinkIn(argv);
    if (link !== undefined) links.open(link);
  });
  app.on("window-all-closed", () => app.quit());

  await app.whenReady();
  protocol.handle(APP_SCHEME, serveApp(platform.paths.renderer));
  const canvas = canvasStore(platform.paths.data);
  const window = electron.openWindow(windowOptions(platform, (await canvas.read()) ?? presetCanvas(electron.nativeTheme.shouldUseDarkColors)));
  shown.window = window;
  lockNavigation(window.webContents, (url) => void electron.shell.openExternal(url).catch(reportError));
  const network = lockNetwork(window.webContents.session.webRequest);
  serveShell(electron.ipcMain, shellMembers({ electron, platform, window, canvas, network, links }), reportError);
  await window.loadURL(APP_URL).catch(reportError);
};
