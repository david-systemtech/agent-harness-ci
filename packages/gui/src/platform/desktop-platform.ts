import {
  standardWebSocketFactory,
  type Clock,
  type DocumentStore,
  type NetworkSignal,
  type Observable,
  type Platform,
  type Shell,
  type WebSocketFactory,
} from "@agent-harness/client-runtime";
import { browserNetwork, systemClock } from "./browser-platform.js";
import { declaredSockets } from "./declared-sockets.js";
import { indexedDocuments } from "./indexed-documents.js";

/**
 * The desktop platform (docs/specs/gui.md, "Packages and the platform";
 * docs/specs/client-runtime.md, "Package and platform"): what the runtime
 * needs from the desktop's window. Documents in IndexedDB; client session
 * tokens through the shell's `secrets` (the OS keychain); the browser's
 * WebSocket, each to an address declared to the desktop's lockdown first
 * (`network.allow`); `fetch` through the shell's `http`, made by the main
 * process, so an environment needs no cross-origin headers; the system
 * clock; the network signal from the online and visibility events; kind
 * `desktop`, labelled `<user>@<hostname>` from the shell's `system`; the
 * grant through `localGrant`; and faults to the desktop's log, which hears
 * the window's console errors.
 */

/** The shell the desktop's preload exposes as `window.desktopShell`, with the members the platform is built on. */
export type DesktopShell = Shell & Required<Pick<Shell, "secrets" | "localGrant" | "http" | "network" | "system">>;

/** The desktop's shell, when the window is the desktop's (its preload exposes `desktopShell`); undefined in a browser tab. */
export const desktopShellOf = (view: Window): DesktopShell | undefined => {
  const shell = (view as unknown as { readonly desktopShell?: Shell }).desktopShell;
  return shell?.secrets && shell.localGrant && shell.http && shell.network && shell.system ? (shell as DesktopShell) : undefined;
};

/** Wait for the preload's device discovery before the runtime snapshots shell capabilities. */
export const readyDesktopShellOf = async (view: Window): Promise<DesktopShell | undefined> => {
  const shell = desktopShellOf(view) as (DesktopShell & { ready?: () => Promise<DesktopShell> }) | undefined;
  return shell?.ready ? shell.ready() : shell;
};

export interface DesktopPlatformParts {
  readonly shell: DesktopShell;
  /** The harness version the bundle was built as. */
  readonly version: string;
  readonly documents: DocumentStore;
  readonly clock: Clock;
  readonly network: NetworkSignal;
  /** Opens a WebSocket, as the window's `WebSocket` does; the platform declares its address first. */
  readonly webSocket: WebSocketFactory;
  readonly reportError: (error: unknown) => void;
  readonly random?: () => number;
}

export interface DesktopPlatform extends Platform {
  readonly shell: DesktopShell;
  readonly reportError: (error: unknown) => void;
  /** Declares each connection's address to the desktop's lockdown as the runtime's list of them changes; answers the stop. */
  follow(connections: Observable<readonly { readonly address: string }[]>): () => void;
}

export const desktopPlatform = async ({ shell, version, documents, clock, network, webSocket, reportError, random }: DesktopPlatformParts): Promise<DesktopPlatform> => {
  const { user, hostname } = await shell.system();
  const sockets = declaredSockets(shell.network, webSocket, reportError);
  return {
    documents,
    secrets: shell.secrets,
    webSocket: sockets.webSocket,
    fetch: shell.http,
    clock,
    ...(random && { random }),
    network,
    client: { kind: "desktop", label: `${user}@${hostname}`, version },
    grant: shell.localGrant,
    shell,
    reportError,
    follow: sockets.follow,
  };
};

/** A fault as the window's console shows it, and the desktop's log keeps it: an error with its stack. */
const describeFault = (error: unknown): string => (error instanceof Error ? (error.stack ?? String(error)) : String(error));

/** The desktop platform in the desktop's window `view`, over its preload's `shell`. */
export const windowDesktopPlatform = (view: Window & typeof globalThis, shell: DesktopShell, version: string): Promise<DesktopPlatform> =>
  desktopPlatform({
    shell,
    version,
    documents: indexedDocuments(view.indexedDB),
    clock: systemClock(),
    network: browserNetwork(view),
    webSocket: standardWebSocketFactory(view.WebSocket),
    reportError: (error) => view.console.error(describeFault(error)),
  });

/** Strip the desktop invocation envelope while retaining the service's actionable cause. */
export const desktopErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^(?:Error:\s*|Error invoking remote method ['"][^'"]+['"]:\s*)+/i, "").replace(/\s+/g, " ").trim();
};
