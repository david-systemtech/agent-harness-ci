import type { Platform } from "@agent-harness/client-runtime";
import { ensurePrivateDirectory } from "../platform/files.js";
import { nodePlatform, stateDirectory } from "../platform/node-platform.js";

/** Where the terminal keeps its state, the local environment's data directory, and who hears a fault no caller can take. */
export interface TerminalPlatformOptions {
  /** Preset: `stateDirectory()`, which `AGENT_HARNESS_TUI_STATE_DIR` overrides. */
  readonly stateDir?: string | undefined;
  /** The local environment's data directory, where its grant file is. */
  readonly dataDir: string;
  /** The harness version, sent in `auth`. */
  readonly version: string;
  readonly reportError: (error: unknown) => void;
}

/**
 * The terminal's state directory, made private, and the client runtime's
 * platform on it (docs/specs/tui.md, "The entry point and the platform"):
 * the saved connections, the secret storage and the local grant file the
 * screen renders from and the screenless selection starts on, one of each.
 */
export const terminalPlatform = (options: TerminalPlatformOptions): { readonly stateDir: string; readonly platform: Platform } => {
  const stateDir = options.stateDir ?? stateDirectory();
  ensurePrivateDirectory(stateDir);
  return { stateDir, platform: nodePlatform({ stateDir, dataDir: options.dataDir, version: options.version, reportError: options.reportError }) };
};
