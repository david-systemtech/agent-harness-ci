import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock, ShellPlatform } from "@agent-harness/client-runtime";
import { startDesktop } from "../src/desktop.js";
import type { DesktopPlatform } from "../src/platform.js";
import type { ServiceWait } from "../src/service.js";
import type { GhProcess } from "../src/gh.js";
import type { MacCredentials } from "../src/mac-credentials.js";
import type { UpdateSystem } from "../src/update.js";
import { shellBridge, type DesktopShell, type PreloadIpc } from "../src/preload/bridge.js";
import { APP_URL } from "../src/schemes.js";
import { fakeElectron, type FakeElectron } from "./fake-electron.js";

/**
 * The desktop's main process started over faked Electron, and the renderer's
 * side of it: the shell the preload builds, over an `ipcRenderer` wired to
 * the fake `ipcMain` and the window's page, so a test acts as the renderer
 * does and sees what Electron was asked.
 */

const made: string[] = [];

/** A directory of the test's own, removed by `cleanUp`. */
export const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agent-harness-desktop-"));
  made.push(dir);
  return dir;
};

/** Removes every directory `scratch` made: the tests' `afterEach`. */
export const cleanUp = (): void => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
};

/** A `gui` build as Vite writes one, in a `dist` of a package of its own: the page, its script and its stylesheet. */
export const rendererBuild = (): string => {
  const dir = join(scratch(), "dist");
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), '<!doctype html><script type="module" crossorigin src="./assets/index.js"></script>');
  writeFileSync(join(dir, "assets", "index.js"), "export {};\n");
  writeFileSync(join(dir, "assets", "index.css"), "body { margin: 0; }\n");
  return dir;
};

export const platformOn = (os: ShellPlatform, overrides: Partial<DesktopPlatform> = {}): DesktopPlatform => ({
  os,
  architecture: "arm64",
  hostname: "desk",
  user: "milo",
  argv: ["/opt/agent-harness/agent-harness"],
  executable: "/opt/agent-harness/agent-harness",
  paths: { data: scratch(), environment: scratch(), renderer: rendererBuild(), preload: "/opt/agent-harness/resources/preload.cjs" },
  ...overrides,
});

export interface Started {
  readonly electron: FakeElectron;
  readonly platform: DesktopPlatform;
  /** The shell as the renderer's page holds it, calling from `from` (the app's page unless a test says otherwise). */
  shell(from?: string | null): DesktopShell;
}

/**
 * Starts the desktop on `platform` (Linux, a fresh data directory and a
 * renderer build, unless given) over `electron` (faked, ready and dark
 * unless given), and waits for its window to load. A fault it reports with
 * no caller to hand it to is thrown, unless the test hears it. An update
 * runs its commands and file calls on `system` (`test/fake-system.ts`) when
 * given, and this computer's `gh` is run by `gh` with `environment` as the
 * desktop's variables when given.
 */
export const start = async ({
  electron = fakeElectron(),
  platform = platformOn("linux"),
  reportError = (error: unknown) => {
    throw error;
  },
  serviceWait,
  system,
  gh,
  environment,
  credentialClock,
  macCredentials,
}: {
  electron?: FakeElectron;
  platform?: DesktopPlatform;
  reportError?: (error: unknown) => void;
  serviceWait?: ServiceWait;
  system?: UpdateSystem;
  gh?: GhProcess;
  environment?: Readonly<Record<string, string | undefined>>;
  credentialClock?: Clock;
  macCredentials?: MacCredentials;
} = {}): Promise<Started> => {
  await startDesktop(electron, platform, { reportError, ...(serviceWait && { serviceWait }), ...(system && { updateSystem: system }), ...(gh && { ghProcess: gh }), ...(environment && { environment }), ...(credentialClock && { credentialClock }), ...(macCredentials && { macCredentials }) });
  return { electron, platform, shell: (from = APP_URL) => rendererShell(electron, from) };
};

/**
 * The preload's shell over an `ipcRenderer` that reaches `electron`'s `ipcMain` from a frame at `from`, and hears its window's page.
 * A handler's rejection reaches the preload as Electron's `ipcRenderer.invoke` hands it over: a new `Error` whose message wraps the
 * handler's error as text, behind `Error invoking remote method '<channel>': `.
 */
export const rendererShell = (electron: FakeElectron, from: string | null = APP_URL): DesktopShell => {
  const contents = electron.window().webContents;
  const ipc: PreloadIpc = {
    invoke: (channel, ...args) =>
      electron.ipcMain.invoke(channel, args, from).catch((error: unknown) => {
        throw new Error(`Error invoking remote method '${channel}': ${String(error)}`);
      }),
    send: (channel, ...args) => electron.ipcMain.send(channel, args, from),
    on(channel, listener) {
      contents.listen(channel, (...args) => listener({}, ...args));
    },
  };
  return shellBridge(ipc);
};
