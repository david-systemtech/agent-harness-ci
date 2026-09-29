import { createRequire } from "node:module";
import { arch, homedir, hostname, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ShellPlatform } from "@agent-harness/client-runtime";
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, protocol, safeStorage, shell } from "electron";
import { desktopDataDirectory, environmentDataDirectory } from "./data-directory.js";
import { startDesktop } from "./desktop.js";
import { desktopLog } from "./log.js";

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

const machine = { os, env: process.env, homedir: homedir() };
const data = desktopDataDirectory(machine);
const log = desktopLog(data);

startDesktop(
  { app, protocol, ipcMain, dialog, clipboard, shell, nativeTheme, safeStorage, openWindow: (options) => new BrowserWindow(options) },
  {
    os,
    architecture: arch(),
    hostname: hostname(),
    user: userInfo().username,
    argv: process.argv,
    paths: {
      data,
      environment: environmentDataDirectory(machine),
      renderer,
      preload: join(here, "preload.cjs"),
      // A packaged desktop carries the server artefact in its resources (#423 puts it there); one run from a checkout carries none.
      ...(app.isPackaged && { server: join(process.resourcesPath, "server") }),
    },
    // Unpackaged (`electron .`), the OS starts the app again as Electron's executable and the app's folder.
    ...(process.defaultApp && { relaunch: { executable: process.execPath, args: [resolve(process.argv[1] ?? ".")] } }),
  },
  { reportError: log.report },
).catch(async (error: unknown) => {
  console.error(error);
  log.report(error);
  await log.flushed();
  app.exit(1);
});
