import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { PRODUCT_NAME } from "@agent-harness/contracts";

/** What the default data directory is resolved from; the running process's own unless a test says otherwise. */
export interface PlatformContext {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir: string;
}

const currentPlatform = (): PlatformContext => ({ platform: process.platform, env: process.env, homedir: homedir() });

/**
 * Where an environment keeps everything it owns, when nothing overrides it:
 * the platform's user state directory, in a folder named after the product
 * (ADR 0017's placeholder, the one constant). Linux and the other Unixes use
 * XDG state (`$XDG_STATE_HOME`, which the XDG spec ignores when relative, else
 * `~/.local/state`); macOS Application Support; Windows LocalAppData. A
 * second environment on one machine is a second directory, chosen by the
 * override (ADR 0001).
 */
export const defaultDataDirectory = (context: PlatformContext = currentPlatform()): string => {
  const { platform, env, homedir: home } = context;
  if (platform === "win32") {
    return win32.join(env["LOCALAPPDATA"] || win32.join(home, "AppData", "Local"), PRODUCT_NAME);
  }
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", PRODUCT_NAME);
  const xdg = env["XDG_STATE_HOME"];
  return posix.join(xdg && posix.isAbsolute(xdg) ? xdg : posix.join(home, ".local", "state"), PRODUCT_NAME);
};

/**
 * Creates the data directory, and any missing parent, readable by its owner
 * alone. An existing directory is tightened to the same mode: it holds the
 * vault and the bootstrap grant. Windows has no mode bits; its per-user
 * LocalAppData is already private to the user.
 */
export const prepareDataDirectory = (path: string): void => {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(path, 0o700);
};
