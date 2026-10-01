import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";

/**
 * Which Chromium or Chrome the environment launches as its headless browser
 * (browser spec, "The headless Chromium"; #555): the one
 * `browser.headless.executable` names, else the first found in the
 * platform's usual install locations, then the first on PATH. Chromium comes
 * before Chrome on Linux, whose distributions package it; Chrome before
 * Chromium on macOS and Windows, where Chrome is what is installed.
 */

/** Where the search looks, and how it tells an executable is there. */
export interface ExecutableSearch {
  readonly platform: NodeJS.Platform;
  /** The process's variables: PATH (Windows's `Path`), and the Windows folders the usual locations are under. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The person's home folder: macOS's own Applications folder is under it. */
  readonly home: string;
  /** Whether a file is there that the environment can run. */
  readonly isExecutable: (path: string) => boolean;
}

/** The executable to launch, or why there is none: a clause the headless browser's absence is stated with. */
export type FoundExecutable = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string };

const LINUX_LOCATIONS = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/snap/bin/chromium", "/opt/google/chrome/chrome"];
const POSIX_NAMES = ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"];
const MAC_APPS = ["Google Chrome.app/Contents/MacOS/Google Chrome", "Chromium.app/Contents/MacOS/Chromium"];
/** Windows's locations: a variable naming a folder, and the executable's path under it. */
const WINDOWS_LOCATIONS: readonly (readonly [variable: string, path: string])[] = [
  ["ProgramFiles", "Google\\Chrome\\Application\\chrome.exe"],
  ["ProgramFiles(x86)", "Google\\Chrome\\Application\\chrome.exe"],
  ["LOCALAPPDATA", "Google\\Chrome\\Application\\chrome.exe"],
  ["ProgramFiles", "Chromium\\Application\\chrome.exe"],
  ["LOCALAPPDATA", "Chromium\\Application\\chrome.exe"],
];
const WINDOWS_NAMES = ["chrome.exe", "chromium.exe"];

const usualLocations = ({ platform, env, home }: ExecutableSearch): string[] => {
  if (platform === "win32") {
    return WINDOWS_LOCATIONS.flatMap(([variable, path]) => {
      const folder = env[variable];
      return folder === undefined || folder === "" ? [] : [win32.join(folder, path)];
    });
  }
  if (platform === "darwin") return [...MAC_APPS.map((app) => posix.join("/Applications", app)), ...MAC_APPS.map((app) => posix.join(home, "Applications", app))];
  return LINUX_LOCATIONS;
};

/** Every place on PATH a name could be, in PATH's order. */
const onPath = ({ platform, env }: ExecutableSearch, names: readonly string[]): string[] => {
  const windows = platform === "win32";
  const path = windows ? win32 : posix;
  const folders = (env.PATH ?? env.Path ?? "").split(windows ? ";" : ":").filter((folder) => folder !== "");
  return folders.flatMap((folder) => names.map((name) => path.join(folder, name)));
};

const NOT_FOUND =
  "no Chromium or Chrome was found in this platform's usual install locations or on PATH; name one in browser.headless.executable, or a browser beside the environment in browser.headless.endpoint";

/**
 * The executable `named` (`browser.headless.executable`; a bare name is looked
 * up on PATH), or with none named the first found where the platform's
 * browsers are installed, then on PATH. A named one that is not there is the
 * reason there is none: another found elsewhere is not what was asked for.
 */
export const findHeadlessExecutable = (named: string | null, search: ExecutableSearch): FoundExecutable => {
  if (named !== null) {
    const bare = !/[\\/]/.test(named);
    const found = (bare ? onPath(search, [named]) : [named]).find((path) => search.isExecutable(path));
    return found === undefined ? { ok: false, reason: `the executable browser.headless.executable names, ${named}, is not a file this environment can run` } : { ok: true, path: found };
  }
  const found = [...usualLocations(search), ...onPath(search, search.platform === "win32" ? WINDOWS_NAMES : POSIX_NAMES)].find((path) => search.isExecutable(path));
  return found === undefined ? { ok: false, reason: NOT_FOUND } : { ok: true, path: found };
};

/** Whether `path` is a file this process may run: on Windows, any file. */
export const isExecutableFile = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
