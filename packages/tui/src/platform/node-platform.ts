import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import {
  standardWebSocketFactory,
  writable,
  type Clock,
  type GrantReader,
  type HttpFetch,
  type NetworkSignal,
  type NetworkState,
  type Platform,
  type WebSocketFactory,
} from "@agent-harness/client-runtime";
import { BOOTSTRAP_GRANT_FILE, BootstrapGrant, PRODUCT_NAME } from "@agent-harness/contracts";
import { messageOf } from "../view.js";
import { readTextIfPresent } from "./files.js";
import { clientLabel, currentIdentity, type TerminalIdentity } from "./identity.js";
import { jsonDocuments } from "./json-documents.js";
import { secretsDirectory } from "./secrets-directory.js";

export { clientLabel, type TerminalIdentity } from "./identity.js";

/**
 * The terminal UI as a platform for the client runtime (docs/specs/tui.md,
 * "The entry point and the platform"; docs/specs/client-runtime.md,
 * "Package and platform"). The state directory holds client-local things
 * only: the runtime's documents (`documents/`), the secrets (`secrets/`), and the
 * terminal UI's own presentation (the keybindings file). No pins, groups,
 * archive or drafts: those are the environment's (ADR 0003).
 */

/** Names a state directory other than the preset one: a second terminal UI profile, or a test. */
export const STATE_DIR_VARIABLE = "AGENT_HARNESS_TUI_STATE_DIR";

/** Where the runtime's documents live, inside the state directory. */
export const DOCUMENTS_DIRECTORY = "documents";
/** The client session tokens, one 0600 file each, inside the state directory. */
export const SECRETS_DIRECTORY = "secrets";
/** Where earlier builds kept every token in one file; moved into `SECRETS_DIRECTORY` on first use. */
const LEGACY_SECRETS_FILE = "secrets.json";

export interface StateContext {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir: string;
}

const currentContext = (): StateContext => ({ platform: process.platform, env: process.env, homedir: homedir() });

/**
 * The terminal UI's state directory: `AGENT_HARNESS_TUI_STATE_DIR` when set,
 * else `<user state directory>/agent-harness/tui`: `$XDG_STATE_HOME` (when
 * absolute, else `~/.local/state`) on Linux, Application Support on macOS,
 * LocalAppData on Windows, the same roots the environment's data directory
 * uses.
 */
export const stateDirectory = (context: StateContext = currentContext()): string => {
  const override = context.env[STATE_DIR_VARIABLE];
  if (override) return override;
  const { platform, env, homedir: home } = context;
  if (platform === "win32") return win32.join(env["LOCALAPPDATA"] || win32.join(home, "AppData", "Local"), PRODUCT_NAME, "tui");
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", PRODUCT_NAME, "tui");
  const xdg = env["XDG_STATE_HOME"];
  return posix.join(xdg && posix.isAbsolute(xdg) ? xdg : posix.join(home, ".local", "state"), PRODUCT_NAME, "tui");
};

/**
 * Reads `bootstrap-grant.json` in the environment's data directory:
 * undefined when there is none, or none an environment wrote, or when it
 * cannot be read at all (a permission, a directory in its place), which
 * `report` hears once until a read succeeds again. It never rejects: the
 * runtime and the service-down offer take an unreadable grant as none.
 */
export const grantFileReader = (dataDir: string, report?: (error: unknown) => void): GrantReader => {
  let reported = false;
  return {
    read: async () => {
      const path = join(dataDir, BOOTSTRAP_GRANT_FILE);
      let text: string | undefined;
      try {
        text = readTextIfPresent(path);
      } catch (error) {
        if (!reported) report?.(new Error(`The grant file ${path} cannot be read: ${messageOf(error)}`));
        reported = true;
        return undefined;
      }
      reported = false;
      if (text === undefined) return undefined;
      try {
        const grant = BootstrapGrant.safeParse(JSON.parse(text));
        return grant.success ? grant.data : undefined;
      } catch {
        return undefined;
      }
    },
  };
};

/** Time from the system; timers do not keep the process alive on their own (Ink's hold on the terminal does). */
export const systemClock: Clock = {
  now: () => new Date(),
  setTimeout(callback, ms) {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

/**
 * The network signal, derived from socket failures only (a chosen default,
 * docs/specs/tui.md): a terminal has no operating-system reachability or
 * focus event to read, so the signal is always online and in the
 * foreground. The only evidence of the network is a socket failing, which
 * each connection's backoff ladder already answers; a signal that went
 * offline on failures would park every retry with nothing left to wake it.
 */
export const socketFailureNetwork = (): NetworkSignal => writable<NetworkState>({ online: true, foreground: true });

export interface NodePlatformOptions {
  /** The state directory (`stateDirectory()`). */
  readonly stateDir: string;
  /** The local environment's data directory, where its grant file is. */
  readonly dataDir: string;
  /** The harness version this terminal UI was built as. */
  readonly version: string;
  /** Preset: the process's user, host and terminal. */
  readonly identity?: TerminalIdentity | undefined;
  readonly reportError?: (error: unknown) => void;
  /** Preset: the global `fetch`. */
  readonly fetch?: HttpFetch;
  /** Preset: Node's global `WebSocket`. */
  readonly webSocket?: WebSocketFactory;
}

/** The terminal UI's platform, with no shell: every shell member is absent with reason `no-shell` (ADR 0004). */
export const nodePlatform = (options: NodePlatformOptions): Platform => ({
  documents: jsonDocuments(join(options.stateDir, DOCUMENTS_DIRECTORY)),
  secrets: secretsDirectory(join(options.stateDir, SECRETS_DIRECTORY), join(options.stateDir, LEGACY_SECRETS_FILE), options.reportError),
  webSocket: options.webSocket ?? standardWebSocketFactory(globalThis.WebSocket),
  fetch: options.fetch ?? ((url, request) => globalThis.fetch(url, request)),
  clock: systemClock,
  network: socketFailureNetwork(),
  client: { kind: "tui", label: clientLabel(options.identity ?? currentIdentity()), version: options.version },
  grant: grantFileReader(options.dataDir, options.reportError),
  ...(options.reportError && { reportError: options.reportError }),
});
