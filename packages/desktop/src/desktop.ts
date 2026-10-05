import { bindZoom } from "./zoom.js";
import { join } from "node:path";
import { PRODUCT_NAME } from "@agent-harness/contracts";
import { APP_ID } from "./app-id.js";
import { APP_SCHEME_REGISTRATION, serveApp } from "./app-scheme.js";
import { canvasStore, presetCanvas } from "./canvas.js";
import { allowAppCamera } from "./camera-permission.js";
import { ANSWERED, channelOf, TOLD, WINDOW_CHANNEL, SECRET_ACCESS_CHANNEL, WEB_VIEW_DEBUG_CHANNEL, WEB_VIEW_DETACH_CHANNEL, WEB_VIEW_CHANNEL, WEB_VIEW_KEY_CHANNEL } from "./channels.js";
import { deepLinkIn, deepLinkInbox } from "./deep-links.js";
import { computerGh, NODE_GH_PROCESS, type GhProcess } from "./gh.js";
import { grantFile } from "./local-grant.js";
import type { DesktopElectron, ElectronBrowserWindow, ElectronIpcMain, IpcCaller, WindowOptions } from "./electron.js";
import { lockNavigation, lockNetwork } from "./lockdown.js";
import { bringForward, shellMembers, windowState, type Members } from "./members.js";
import { desktopNotifications } from "./notifications.js";
import type { DesktopPlatform } from "./platform.js";
import { PREVIEW_SCHEME_REGISTRATION, previews } from "./preview.js";
import { APP_SCHEME, APP_URL, PREVIEW_SCHEME, isAppPage } from "./schemes.js";
import { webViews } from "./web-view.js";
import type { Clock } from "@agent-harness/client-runtime";
import type { MacCredentials } from "./mac-credentials.js";
import { keychainSecrets } from "./secrets.js";
import { bundledInstaller } from "./installer.js";
import { bundledService, type ServiceWait } from "./service.js";
import { desktopUpdate, NODE_UPDATE_SYSTEM, type UpdateSystem } from "./update.js";

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
  titleBarStyle: "hidden",
  ...(platform.os === "darwin" ? { trafficLightPosition: { x: 12, y: 15 } } : { frame: false }),
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
  /** The OS's commands and the file calls an update makes: preset Node's own, `NODE_UPDATE_SYSTEM`. */
  readonly updateSystem?: UpdateSystem;
  /** How this computer's `gh` is run: preset Node's own, `NODE_GH_PROCESS`. */
  readonly ghProcess?: GhProcess;
  /** The desktop's variables, which `gh` runs with: preset the process's own. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly macCredentials?: MacCredentials;
  readonly credentialClock?: Clock;
}

/**
 * Starts the desktop: resolves once its window has loaded, or at once when
 * another instance holds the lock, which this one hands its launch to by
 * quitting. The steps before the first `await` run before the app is ready,
 * as Electron requires of the data path, the lock, the scheme's privileges
 * and the macOS `open-url` listener.
 */
export const startDesktop = async (
  electron: DesktopElectron,
  platform: DesktopPlatform,
  { reportError = console.error, serviceWait, updateSystem = NODE_UPDATE_SYSTEM, ghProcess = NODE_GH_PROCESS, environment = process.env, macCredentials, credentialClock }: DesktopOptions = {},
): Promise<void> => {
  const { app, protocol } = electron;
  // First: Electron keeps the single-instance lock in the data directory in force when it is asked for.
  app.setPath("userData", platform.paths.data);
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  // Windows shows a notification only from the AppUserModelID a Start menu shortcut carries: the install's, or, run from a
  // checkout with no such shortcut, Electron's executable, as Electron names a development run.
  if (platform.os === "win32") app.setAppUserModelId(app.isPackaged ? APP_ID : platform.executable);
  // Once, both schemes together: Electron takes this call only once, before the app is ready.
  protocol.registerSchemesAsPrivileged([APP_SCHEME_REGISTRATION, PREVIEW_SCHEME_REGISTRATION]);
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
  const preview = previews();
  protocol.handle(PREVIEW_SCHEME, (request) => preview.serve(request));
  const canvas = canvasStore(platform.paths.data);
  const window = electron.openWindow(windowOptions(platform, (await canvas.read()) ?? presetCanvas(electron.nativeTheme.shouldUseDarkColors)));
  shown.window = window;
  for (const event of ["focus", "blur", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"] as const) {
    window.on(event, () => window.webContents.send(WINDOW_CHANNEL, windowState(window, platform.os)));
  }
  bindZoom(window.webContents, platform.os);
  allowAppCamera(window.webContents);
  lockNavigation(window.webContents, (url) => void electron.shell.openExternal(url).catch(reportError));
  // The renderer's platform reports what it has no caller for to its console: its errors are the window's faults.
  window.webContents.on("console-message", ({ level, message, sourceId, lineNumber }) => {
    if (level === "error") reportError(`The window: ${message} (${sourceId}:${lineNumber})`);
  });
  const webView = webViews(electron, window);
  webView.debugger!.onEvent((id, event) => window.webContents.send(WEB_VIEW_DEBUG_CHANNEL, id, event));
  webView.debugger!.onDetach((id, reason) => window.webContents.send(WEB_VIEW_DETACH_CHANNEL, id, reason));
  webView.onKey((id, key) => window.webContents.send(WEB_VIEW_KEY_CHANNEL, id, key));
  webView.onChange((id, state) => window.webContents.send(WEB_VIEW_CHANNEL, id, state));
  const network = lockNetwork(window.webContents.session.webRequest);
  const secrets = keychainSecrets({
    safeStorage: electron.safeStorage,
    os: platform.os,
    dir: join(platform.paths.data, SECRETS_DIRECTORY),
    report: reportError,
    ...(macCredentials && { macCredentials }),
    ...(credentialClock && { clock: credentialClock }),
  });
  app.on("will-quit", () => secrets.close());
  const stopAccess = secrets.onAccess((state) => window.webContents.send(SECRET_ACCESS_CHANNEL, state));
  window.on("closed", stopAccess);
  const localGrant = grantFile(platform.paths.environment, reportError);
  const service = bundledService({ os: platform.os, environmentDir: platform.paths.environment, server: platform.paths.server, ...(serviceWait && { wait: serviceWait }) });
  const update = desktopUpdate({ app, platform, system: updateSystem, report: reportError });
  const installer = bundledInstaller(platform.paths.server, platform.paths.environment);
  const gh = computerGh({ os: platform.os, process: ghProcess, environment });
  const notifications = desktopNotifications({ notification: electron.notification, window });
  serveShell(
    electron.ipcMain,
    shellMembers({ electron, secrets, localGrant, service, update, installer, platform, window, canvas, network, links, notifications, preview, gh, webView }),
    reportError,
  );
  await window.loadURL(APP_URL).catch(reportError);
};
