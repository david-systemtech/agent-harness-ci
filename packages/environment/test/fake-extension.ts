import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BRIDGE_PROTOCOL_VERSION,
  EXTENSION_ORIGIN,
  PORT_FILE_NAME,
  PortFile,
  bridgeUrl,
  decodeFromEnvironment,
  encodeBridgeMessage,
  type BridgeCall,
  type BridgeFromEnvironment,
  type BridgeFromExtension,
  type PageCallOf,
  type PageOutcome,
  type PageResult,
  type PageVerb,
} from "@agent-harness/contracts";
import { WebSocket } from "ws";
import { CONNECT_MS, WAIT_MS } from "./wire-client.js";

/**
 * The fake extension (browser spec, "Testing Decisions"; #547): the built
 * extension a test environment carries, and a WebSocket client that finds
 * its environment as the real extension does. It reads the port file from
 * the unpacked folder, dials that port on loopback with the extension's
 * Origin, speaks bridge protocol version 2, and answers each verb the
 * environment calls from a script. Pairing and the proof (#548) and the
 * verbs a paired Chrome answers (#552) extend it.
 */

/** The built extension a test environment carries unless told otherwise: a manifest and a worker. */
export const TEST_EXTENSION = fileURLToPath(new URL("./fixtures/extension", import.meta.url));

/** The version name in `TEST_EXTENSION`'s manifest. */
export const TEST_EXTENSION_VERSION = "1.0.0-test";

/** The listener's ports in a test environment unless told otherwise: any free one, never 47615. */
export const TEST_EXTENSION_PORTS = { preferred: 0, last: 0 } as const;

/**
 * Writes a built extension of `version` into `dir`, as another harness
 * version would carry one: its manifest, naming the version, and `files`
 * (paths in the folder to their text). Answers `dir`.
 */
export const writeExtensionBuild = (dir: string, version: string, files: Readonly<Record<string, string>> = {}): string => {
  mkdirSync(dir, { recursive: true });
  const manifest = { manifest_version: 3, name: "agent-harness", version: "1.0.0", version_name: version };
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
};

/** The port file in an unpacked folder, checked against its schema. */
export const readPortFile = (folder: string): PortFile => PortFile.parse(JSON.parse(readFileSync(join(folder, PORT_FILE_NAME), "utf8")));

/** How the fake answers one verb: its value or a refusal, as the extension's driver would. */
export type VerbAnswer<V extends PageVerb> = (call: PageCallOf<V>) => PageResult<V> | Promise<PageResult<V>>;

/** The fake's script: an answer for each verb it is to answer; any other is refused with a sentence naming it. */
export type ExtensionScript = { readonly [V in PageVerb]?: VerbAnswer<V> };

export interface DialOptions {
  /** The Origin the upgrade carries; preset the extension's, `EXTENSION_ORIGIN`. Null sends none. */
  readonly origin?: string | null;
  /** The Host the upgrade carries; preset the loopback address and port dialled, as Chrome sends it. */
  readonly host?: string;
  /** How the verbs the environment calls are answered; preset none, every verb refused. */
  readonly script?: ExtensionScript;
}

/** The listener refused the upgrade: no socket was opened, and no message went either way. */
export class DialRefusedError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`The listener refused the upgrade with ${status}.`);
    this.name = "DialRefusedError";
    this.status = status;
  }
}

/** What the fake announces, each over its preset. */
export interface AnnounceOptions {
  /** Preset `BRIDGE_PROTOCOL_VERSION`. */
  readonly protocolVersion?: number;
  /** Preset the version name in the unpacked folder's manifest. */
  readonly extensionVersion?: string;
  /** Preset `Chrome`. */
  readonly name?: string;
}

export interface FakeExtension {
  /** The port file the fake read before it dialled. */
  readonly portFile: PortFile;
  /** Every message the environment sent, in order. */
  readonly received: readonly BridgeFromEnvironment[];
  /** Every call the environment made, in order, each answered from the script. */
  readonly calls: readonly BridgeCall[];
  /** Sends a message; a string goes as it is, for a malformed one. */
  send(message: BridgeFromExtension | string): void;
  /**
   * The first message received, now or later, that matches `predicate` and
   * that no earlier `next` returned. Rejects after `WAIT_MS`, or once the
   * socket has closed without it.
   */
  next(predicate?: (message: BridgeFromEnvironment) => boolean): Promise<BridgeFromEnvironment>;
  /** Opens as an extension that holds no credential: sends `announce`, and answers the environment's reply, `announced` or `refused`. */
  announce(options?: AnnounceOptions): Promise<BridgeFromEnvironment>;
  /** Settles when the socket has closed, with its close code. */
  readonly closed: Promise<{ readonly code: number }>;
  isOpen(): boolean;
  /** Closes the socket and waits for it to be closed. */
  close(): Promise<void>;
}

const withTimeout = <T>(promise: Promise<T>, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${WAIT_MS} ms waiting for ${what}.`)), WAIT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });

/** One attempt: the socket once open; `DialRefusedError` for an upgrade answered with a refusal; another error for a connection that failed. */
const attempt = (port: number, options: DialOptions): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const origin = options.origin === undefined ? EXTENSION_ORIGIN : options.origin;
    const ws = new WebSocket(bridgeUrl(port), { ...(origin !== null && { origin }), headers: { host: options.host ?? `127.0.0.1:${port}` } });
    ws.once("unexpected-response", (_request, response) => {
      response.resume();
      reject(new DialRefusedError(response.statusCode ?? 0));
      ws.terminate();
    });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });

/**
 * Dials the environment whose port file is in `folder`, as the extension
 * does at each connection attempt, and answers once the socket is open. A
 * connection refused or reset is tried again for up to `CONNECT_MS`, as a
 * loaded machine may need; a refused upgrade is not.
 */
export const dialExtension = async (folder: string, options: DialOptions = {}): Promise<FakeExtension> => {
  const portFile = readPortFile(folder);
  const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8")) as { readonly version_name?: string };
  const until = Date.now() + CONNECT_MS;
  let opened: WebSocket | undefined;
  while (opened === undefined) {
    try {
      opened = await attempt(portFile.port, options);
    } catch (error) {
      if (error instanceof DialRefusedError || Date.now() > until) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const socket = opened;
  const received: BridgeFromEnvironment[] = [];
  const calls: BridgeCall[] = [];
  const returned = new Set<number>();
  const waiters = new Set<() => void>();
  let failure: Error | undefined;
  const wake = () => {
    for (const waiter of [...waiters]) waiter();
  };
  const closed = new Promise<{ readonly code: number }>((resolve) => {
    socket.once("close", (code) => {
      resolve({ code });
      wake();
    });
  });
  socket.on("error", () => undefined);

  const send = (message: BridgeFromExtension | string): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(typeof message === "string" ? message : encodeBridgeMessage(message));
  };

  const answer = async (call: BridgeCall): Promise<void> => {
    const scripted = options.script?.[call.command.verb] as VerbAnswer<PageVerb> | undefined;
    const result = scripted
      ? await scripted(call as PageCallOf<PageVerb>)
      : { ok: false as const, reason: `The fake extension has no answer scripted for ${call.command.verb}.` };
    // A verb's typed value is JSON on the wire, which PageOutcome reads it as.
    send({ type: "result", id: call.id, result: result as PageOutcome });
  };

  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      failure = new Error("The environment sent a binary frame.");
      return wake();
    }
    const decoded = decodeFromEnvironment(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
    if (!decoded.ok) {
      failure = new Error(`The environment sent a message the codec refuses: ${decoded.reason}`);
      return wake();
    }
    const message = decoded.message;
    received.push(message);
    if (message.type === "ping") send({ type: "pong" });
    if (message.type === "call") {
      calls.push(message);
      void answer(message);
    }
    wake();
  });

  const next = (predicate: (message: BridgeFromEnvironment) => boolean = () => true): Promise<BridgeFromEnvironment> =>
    withTimeout(
      new Promise<BridgeFromEnvironment>((resolve, reject) => {
        const look = () => {
          if (failure) {
            waiters.delete(look);
            return reject(failure);
          }
          const index = received.findIndex((message, i) => !returned.has(i) && predicate(message));
          if (index >= 0) {
            returned.add(index);
            waiters.delete(look);
            return resolve(received[index] as BridgeFromEnvironment);
          }
          if (socket.readyState === WebSocket.CLOSED) {
            waiters.delete(look);
            reject(new Error(`The socket closed before the message came; received ${JSON.stringify(received)}.`));
          }
        };
        waiters.add(look);
        look();
      }),
      "a message from the environment",
    );

  return {
    portFile,
    received,
    calls,
    send,
    next,
    async announce(announce = {}) {
      send({
        type: "announce",
        protocolVersion: announce.protocolVersion ?? BRIDGE_PROTOCOL_VERSION,
        extensionVersion: announce.extensionVersion ?? manifest.version_name ?? TEST_EXTENSION_VERSION,
        name: announce.name ?? "Chrome",
      });
      return next((message) => message.type === "announced" || message.type === "refused");
    },
    closed,
    isOpen: () => socket.readyState === WebSocket.OPEN,
    async close() {
      if (socket.readyState !== WebSocket.CLOSED) socket.close(1000);
      await withTimeout(closed, "the extension's socket to close");
    },
  };
};
