import { createRequire } from "node:module";
import { arch, homedir, hostname, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ShellPlatform } from "@agent-harness/client-runtime";
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, protocol, shell } from "electron";
import { desktopDataDirectory } from "./data-directory.js";
import { startDesktop } from "./desktop.js";

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

const here = dirname(fileURLToPath(import.meta.url));
/** The `gui` build this desktop carries: the package's `dist`, beside its manifest. */
const renderer = join(dirname(createRequire(import.meta.url).resolve("@agent-harness/gui/package.json")), "dist");

startDesktop(
  { app, protocol, ipcMain, dialog, clipboard, shell, nativeTheme, openWindow: (options) => new BrowserWindow(options) },
  {
    os,
    architecture: arch(),
    hostname: hostname(),
    user: userInfo().username,
    argv: process.argv,
    paths: { data: desktopDataDirectory({ os, env: process.env, homedir: homedir() }), renderer, preload: join(here, "preload.cjs") },
    // Unpackaged (`electron .`), the OS starts the app again as Electron's executable and the app's folder.
    ...(process.defaultApp && { relaunch: { executable: process.execPath, args: [resolve(process.argv[1] ?? ".")] } }),
  },
).catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});
