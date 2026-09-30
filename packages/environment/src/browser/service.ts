import type { BrowserStatus, ExtensionListenerStatus, PortFile } from "@agent-harness/contracts";
import { formatActor, type EventLog, type StreamRef } from "../event-log/event-log.js";
import type { Clock } from "../serve/clock.js";
import type { MethodHandlers } from "../serve/methods.js";
import { extensionFolder, type FolderState } from "./extension-folder.js";
import { createExtensionListener, type ExtensionListenerPorts } from "./listener.js";

/**
 * The browser service's extension half (browser spec, "The extension, its
 * folder and its listener"; ADR 0024; #547): the folder Chrome loads, made
 * at start and again when `browser.status` finds it missing, the listener
 * the extension dials, the port file that joins them, and the unpaired
 * signal, `extension.seen` on the environment stream beside the unpaired
 * flag `browser.status` answers.
 */

/** Who the log says appended `extension.seen`. */
const BROWSER_ACTOR = formatActor({ kind: "system", id: "browser" });

export interface BrowserServiceOptions {
  readonly log: EventLog;
  readonly clock: Clock;
  /** The environment stream, which `environment.subscribe` follows. */
  readonly stream: StreamRef;
  readonly environmentId: string;
  /** The environment's name as it is now: the port file and `announced` carry it. */
  readonly name: () => string;
  readonly harnessVersion: string;
  readonly dataDir: string;
  /** The built extension the environment carries. */
  readonly extensionSource: string;
  /** The ports the listener tries. */
  readonly ports: ExtensionListenerPorts;
}

export interface BrowserService {
  /** Binds the listener, then makes the folder and writes the port file into it. Never rejects: what fails, `browser.status` says. */
  start(): Promise<void>;
  /** `browser.status`, the folder made again first when it is missing. */
  status(): Promise<BrowserStatus>;
  readonly handlers: MethodHandlers;
  close(): Promise<void>;
}

export const createBrowserService = (options: BrowserServiceOptions): BrowserService => {
  const { log, stream } = options;
  const folder = extensionFolder({ dataDir: options.dataDir, source: options.extensionSource });
  const listener = createExtensionListener({
    clock: options.clock,
    environment: { id: options.environmentId, name: options.name },
    onAnnounce: ({ protocolVersion, extensionVersion }) => {
      try {
        log.append(stream, [{ type: "extension.seen", payload: { protocolVersion, extensionVersion } }], { actor: BROWSER_ACTOR });
      } catch (error) {
        console.error("Recording that an unpaired extension was seen failed:", error);
      }
    },
  });

  let listening: ExtensionListenerStatus | undefined;
  let state: FolderState = { shippedVersion: null, problem: "The environment has not made the extension's folder yet." };

  const portFile = (): PortFile | null =>
    listening?.state === "listening"
      ? { port: listening.port, environmentId: options.environmentId, environmentName: options.name(), harnessVersion: options.harnessVersion }
      : null;

  const ensure = async (): Promise<void> => {
    state = await folder.ensure(portFile());
  };

  const status = async (): Promise<BrowserStatus> => {
    await ensure();
    return {
      listener: listening ?? { state: "not-listening", reason: "bind-failed", message: "The listener has not been started." },
      folder: { path: folder.path, problem: state.problem },
      shippedVersion: state.shippedVersion,
      unpairedConnected: listener.unpairedConnected(),
    };
  };

  // The port file names the environment as it is now: a rename writes it again.
  const stopFollowingRenames = log.subscribe((event) => {
    if (event.streamKind === stream.kind && event.streamId === stream.id && event.type === "environment.renamed") void ensure();
  });

  return {
    async start() {
      listening = await listener.listen(options.ports);
      await ensure();
    },
    status,
    handlers: { "browser.status": () => status() },
    async close() {
      stopFollowingRenames();
      await listener.close();
    },
  };
};
