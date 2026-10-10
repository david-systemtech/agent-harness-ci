import { createRequire } from "node:module";
import { arch, homedir, hostname, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ShellPlatform } from "@agent-harness/client-runtime";
import { app, BrowserWindow, WebContentsView, clipboard, dialog, ipcMain, Menu, nativeTheme, Notification, protocol, safeStorage, shell } from "electron";
import { promises as originalFiles } from "original-fs";
import type { ElectronWebView } from "./electron.js";
import { desktopDataDirectory, environmentDataDirectory } from "./data-directory.js";
import { startDesktop } from "./desktop.js";
import { desktopLog } from "./log.js";
import { CREDENTIAL_HELPER_ARGUMENT, launchMacCredentials, serveMacCredentials } from "./mac-credentials.js";
import { credentialHelperName, macCredentialStore } from "./mac-credential-store.js";
import { PACKAGED_RENDERER, PACKAGED_SERVER } from "./packaged.js";
import { NODE_UPDATE_SYSTEM } from "./update.js";

/**
 * The desktop's entry, which Electron runs (`package.json`'s `main`): the
 * real Electron modules and the real machine handed to `startDesktop`. It
 * holds no behaviour of its own, and no test loads it: the `electron`
 * package fetches its binary when Node first requires it.
 */

const os = ((): ShellPlatform => {
  const { platform } = process;
  if (platform === "darwin" || platform === "linux" || platform === "win32") return platform;
  throw new Error(`The desktop is built for macOS, Linux and Windows, not ${platform}.`);
})();

const machine = { os, env: process.env, homedir: homedir() };
const data = desktopDataDirectory(machine);

if (os === "darwin" && process.argv.includes(CREDENTIAL_HELPER_ARGUMENT) && process.send) {
  // Electron derives the Keychain service from this name before ready. A recovered
  // item has a new name; the default still reads earlier synchronous v10 ciphertext.
  const name = credentialHelperName(process.argv);
  app.setName(name);
  app.setPath("userData", join(data, "credential-provider", encodeURIComponent(name)));
  void app.whenReady().then(() => app.dock?.hide());
  process.on("disconnect", () => process.kill(process.pid, "SIGKILL"));
  serveMacCredentials(safeStorage, app.whenReady(), (receive) => process.on("message", receive), (reply) => process.send?.(reply));
} else {
  const here = dirname(fileURLToPath(import.meta.url));
  /**
   * The `gui` build this desktop carries: packaged, in the app's folder (#423);
   * run from a checkout, the package's `dist`, beside its manifest.
   */
  const renderer = app.isPackaged
    ? join(app.getAppPath(), PACKAGED_RENDERER)
    : join(dirname(createRequire(import.meta.url).resolve("@agent-harness/gui/package.json")), "dist");

  const log = desktopLog(data);

  const macCredentials = os === "darwin" ? macCredentialStore({
    dir: join(data, "secrets"),
    open: (name) => launchMacCredentials(process.execPath, process.defaultApp ? [resolve(process.argv[1] ?? ".")] : [], name),
  }) : undefined;
  process.on("exit", () => macCredentials?.close());
  const nativeViews = new WeakMap<ElectronWebView, WebContentsView>();

  startDesktop(
    {
      app,
      protocol,
      ipcMain,
      dialog,
      clipboard,
      shell,
      nativeTheme,
      safeStorage,
      menu: { set: (template) => Menu.setApplicationMenu(Menu.buildFromTemplate(template)) },
      notification: { isSupported: () => Notification.isSupported(), create: (options) => new Notification(options) },
      openWindow: (options) => {
        const window = new BrowserWindow(options);
        return Object.assign(window, {
          addWebView: (view: ElectronWebView) => {
            const native = nativeViews.get(view);
            if (native) window.contentView.addChildView(native);
          },
          removeWebView: (view: ElectronWebView) => {
            const native = nativeViews.get(view);
            if (native) window.contentView.removeChildView(native);
          },
        });
      },
      openWebView: (options) => {
        const view = new WebContentsView(options);
        nativeViews.set(view, view);
        return view;
      },
    },
    {
      os,
      architecture: arch(),
      hostname: hostname(),
      user: userInfo().username,
      argv: process.argv,
      executable: process.execPath,
      paths: {
        data,
        environment: environmentDataDirectory(machine),
        renderer,
        preload: join(here, "preload.cjs"),
        // A packaged desktop carries the server artefact in its resources (#423 puts it there); one run from a checkout carries none.
        ...(app.isPackaged && { server: join(process.resourcesPath, PACKAGED_SERVER) }),
      },
      // Unpackaged (`electron .`), the OS starts the app again as Electron's executable and the app's folder.
      ...(process.defaultApp && { relaunch: { executable: process.execPath, args: [resolve(process.argv[1] ?? ".")] } }),
    },
    {
      reportError: log.report,
      // Update paths describe physical bundles, including app.asar as a file, never virtual directories.
      updateSystem: { ...NODE_UPDATE_SYSTEM, files: originalFiles },
      ...(macCredentials && { macCredentials }),
    },
  ).catch(async (error: unknown) => {
    console.error(error);
    log.report(error);
    await log.flushed();
    app.exit(1);
  });

}
