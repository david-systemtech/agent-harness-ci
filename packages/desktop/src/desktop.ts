import { join } from "node:path";
import { PRODUCT_NAME } from "@agent-harness/contracts";
import { APP_SCHEME_REGISTRATION, serveApp } from "./app-scheme.js";
import { canvasStore, presetCanvas } from "./canvas.js";
import { ANSWERED, channelOf, TOLD } from "./channels.js";
import { deepLinkIn, deepLinkInbox } from "./deep-links.js";
import { grantFile } from "./local-grant.js";
import type { DesktopElectron, ElectronBrowserWindow, ElectronIpcMain, IpcCaller, WindowOptions } from "./electron.js";
import { lockNavigation, lockNetwork } from "./lockdown.js";
import { bringForward, shellMembers, type Members } from "./members.js";
import type { DesktopPlatform } from "./platform.js";
import { APP_SCHEME, APP_URL, isAppPage } from "./schemes.js";
import { keychainSecrets } from "./secrets.js";
import { bundledService, type ServiceWait } from "./service.js";

/** The client session tokens' folder in the desktop's data directory. */
const SECRETS_DIRECTORY = "secrets";

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
  /** Hears a fault with no caller to hand it to: a refused told member, a window that failed to load, an error on the window's console. */
  readonly reportError?: (error: unknown) => void;
  /** How `service.start` waits for the environment to answer: preset `SERVICE_WAIT`. */
  readonly serviceWait?: ServiceWait;
}

/**
 * Starts the desktop: resolves once its window has loaded, or at once when
 * another instance holds the lock, which this one hands its launch to by
 * quitting. The steps before the first `await` run before the app is ready,
 * as Electron requires of the data path, the lock, the scheme's privileges
 * and the macOS `open-url` listener.
 */
export const startDesktop = async (electron: DesktopElectron, platform: DesktopPlatform, { reportError = console.error, serviceWait }: DesktopOptions = {}): Promise<void> => {
  const { app, protocol } = electron;
  // First: Electron keeps the single-instance lock in the data directory in force when it is asked for.
  app.setPath("userData", platform.paths.data);
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
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
  // The renderer's platform reports what it has no caller for to its console: its errors are the window's faults.
  window.webContents.on("console-message", ({ level, message, sourceId, lineNumber }) => {
    if (level === "error") reportError(`The window: ${message} (${sourceId}:${lineNumber})`);
  });
  const network = lockNetwork(window.webContents.session.webRequest);
  const secrets = keychainSecrets({ safeStorage: electron.safeStorage, os: platform.os, dir: join(platform.paths.data, SECRETS_DIRECTORY), report: reportError });
  const localGrant = grantFile(platform.paths.environment, reportError);
  const service = bundledService({ os: platform.os, server: platform.paths.server, ...(serviceWait && { wait: serviceWait }) });
  serveShell(electron.ipcMain, shellMembers({ electron, secrets, localGrant, service, platform, window, canvas, network, links }), reportError);
  await window.loadURL(APP_URL).catch(reportError);
};
