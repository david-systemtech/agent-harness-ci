import { posix, win32 } from "node:path";
import { PRODUCT_NAME } from "@agent-harness/contracts";
import type { ShellPlatform } from "@agent-harness/client-runtime";

export interface DataDirectoryContext {
  readonly os: ShellPlatform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir: string;
}

/**
 * Where the desktop keeps its files (Chromium's profile, and with it the
 * renderer's IndexedDB, and the window's last Canvas colour):
 * `<user state directory>/agent-harness/desktop`, beside the terminal UI's
 * `tui` under the roots the environment's data directory uses: `$XDG_STATE_HOME`
 * (when absolute, else `~/.local/state`) on Linux, Application Support on
 * macOS, LocalAppData on Windows. Never Electron's default, which on macOS
 * would be the environment's own directory.
 */
export const desktopDataDirectory = ({ os, env, homedir: home }: DataDirectoryContext): string => {
  if (os === "win32") return win32.join(env["LOCALAPPDATA"] || win32.join(home, "AppData", "Local"), PRODUCT_NAME, "desktop");
  if (os === "darwin") return posix.join(home, "Library", "Application Support", PRODUCT_NAME, "desktop");
  const xdg = env["XDG_STATE_HOME"];
  return posix.join(xdg && posix.isAbsolute(xdg) ? xdg : posix.join(home, ".local", "state"), PRODUCT_NAME, "desktop");
};
