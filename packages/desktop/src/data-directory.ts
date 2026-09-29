import { posix, win32 } from "node:path";
import { PRODUCT_NAME } from "@agent-harness/contracts";
import type { ShellPlatform } from "@agent-harness/client-runtime";

export interface DataDirectoryContext {
  readonly os: ShellPlatform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir: string;
}

/**
 * This machine's environment's data directory, where its grant file is and
 * where the `service` verbs install it, as the environment's
 * `defaultDataDirectory` resolves it: `<user state directory>/agent-harness`
 * under `$XDG_STATE_HOME` (when absolute, else `~/.local/state`) on Linux,
 * Application Support on macOS, LocalAppData on Windows.
 */
export const environmentDataDirectory = ({ os, env, homedir: home }: DataDirectoryContext): string => {
  if (os === "win32") return win32.join(env["LOCALAPPDATA"] || win32.join(home, "AppData", "Local"), PRODUCT_NAME);
  if (os === "darwin") return posix.join(home, "Library", "Application Support", PRODUCT_NAME);
  const xdg = env["XDG_STATE_HOME"];
  return posix.join(xdg && posix.isAbsolute(xdg) ? xdg : posix.join(home, ".local", "state"), PRODUCT_NAME);
};

/**
 * Where the desktop keeps its files (Chromium's profile, and with it the
 * renderer's IndexedDB, the window's last Canvas colour, the client session
 * tokens and its log): `desktop` in the environment's data directory,
 * beside the terminal UI's `tui`. Never Electron's default, which on macOS
 * would be the environment's own directory.
 */
export const desktopDataDirectory = (context: DataDirectoryContext): string =>
  (context.os === "win32" ? win32 : posix).join(environmentDataDirectory(context), "desktop");
