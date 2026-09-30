import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  BRIDGE_MESSAGE_MAX_CHARS,
  BRIDGE_PATH,
  EXTENSION_ORIGIN,
  decodeFromExtension,
  encodeBridgeMessage,
  type BridgeFromEnvironment,
  type BridgeFromExtension,
  type ExtensionListenerStatus,
} from "@agent-harness/contracts";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { Clock, Timer } from "../serve/clock.js";
import { createHttpSurface, refuseUpgrade, type HttpSurface } from "../serve/http.js";
import { LOOPBACK } from "../serve/interfaces.js";

/**
 * The extension listener (browser spec, "The extension, its folder and its
 * listener"; ADR 0014, ADR 0024): a WebSocket on loopback that the extension
 * in a Chrome on this machine dials, on the port the port file names. It
 * takes the first free port of its range, 47615 to 47634 (a chosen
 * default), and with none free it does not listen and says why. An upgrade
 * is refused before any message unless its Host is loopback and its Origin
 * the extension's fixed id, which no web page can send: the Host check stops
 * a rebinding page, the Origin check every page.
 *
 * On a socket the extension speaks bridge protocol version 2, one message a
 * frame, the environment serving its version and the one before. An
 * extension that holds no credential opens with `announce`, answered with
 * the environment's id and name, and the socket is kept: while one is open
 * an unpaired extension is connected, which ticks the Browser card's Load
 * sub-step. Pairing and the proof on the same sockets are #548's.
 */

/** The ports the listener tries, the preferred first and then each next up to the last; a preferred port of 0 binds any free one. */
export interface ExtensionListenerPorts {
  readonly preferred: number;
  readonly last: number;
}

/** 47615, else the next free port up to 47634 (browser spec's chosen default). */
export const EXTENSION_LISTENER_PORTS: ExtensionListenerPorts = { preferred: 47_615, last: 47_634 };

/** The largest frame the socket takes: the bridge's longest message, every UTF-16 code unit as up to three UTF-8 bytes. */
const MAX_FRAME_BYTES = BRIDGE_MESSAGE_MAX_CHARS * 3;

/** How a socket that ends a conversation is closed: a policy violation, after the `refused` that says why. */
const REFUSED_CLOSE_CODE = 1008;

/** How long the close waits for the extensions' sockets to close before it cuts them, as the wire's does. */
const CLOSE_GRACE_MS = 1000;

type Announce = Extract<BridgeFromExtension, { readonly type: "announce" }>;

export interface ExtensionListenerOptions {
  readonly clock: Clock;
  /** The environment an extension finds on the port: its id, and its name as it is now. */
  readonly environment: { readonly id: string; readonly name: () => string };
  /** An extension that holds no credential announced itself, and its socket is kept. */
  readonly onAnnounce: (announce: Announce) => void;
}

export interface ExtensionListener {
  /** Binds loopback on the first free port of `ports`, and answers where it listens or why it does not. Once. */
  listen(ports: ExtensionListenerPorts): Promise<ExtensionListenerStatus>;
  /** Whether an extension that announced itself holds its socket open. */
  unpairedConnected(): boolean;
  /** Closes every socket (1001), cutting what has not closed after a second, then stops listening. */
  close(): Promise<void>;
}

const portsOf = ({ preferred, last }: ExtensionListenerPorts): number[] =>
  preferred === 0 ? [0] : Array.from({ length: Math.max(1, last - preferred + 1) }, (_, index) => preferred + index);

export const createExtensionListener = (options: ExtensionListenerOptions): ExtensionListener => {
  const surface: HttpSurface = createHttpSurface();
  const server = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, clientTracking: false });
  const sockets = new Set<WebSocket>();
  const announced = new Set<WebSocket>();

  const send = (socket: WebSocket, message: BridgeFromEnvironment): void => {
    if (socket.readyState === socket.OPEN) socket.send(encodeBridgeMessage(message));
  };

  /** Ends the conversation: `refused` with the sentence, then the close. */
  const refuse = (socket: WebSocket, reason: string): void => {
    send(socket, { type: "refused", reason });
    socket.close(REFUSED_CLOSE_CODE);
  };

  const onMessage = (socket: WebSocket, data: RawData, isBinary: boolean): void => {
    if (isBinary) return refuse(socket, "The bridge carries JSON text, one message a frame, never binary.");
    const decoded = decodeFromExtension(Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.concat(data as Buffer[]).toString("utf8"));
    if (!decoded.ok) return refuse(socket, decoded.reason);
    const message = decoded.message;
    switch (message.type) {
      case "announce":
        announced.add(socket);
        send(socket, { type: "announced", environmentId: options.environment.id, environmentName: options.environment.name() });
        options.onAnnounce(message);
        return;
      case "ping":
        return send(socket, { type: "pong" });
      case "pong":
        return;
      case "refused":
        socket.close(1000);
        return;
      case "pair":
        // Pairing on the announced socket is #548's: until it is built no code is live, and the socket stays for the next.
        if (announced.has(socket)) return send(socket, { type: "refused", reason: "This environment cannot pair a Chrome yet." });
        return refuse(socket, "A pair comes on a socket that opened with announce.");
      case "hello":
        // The proof is #548's: until it is built this environment holds no paired Chrome, so none can prove itself.
        return refuse(socket, "This environment holds no pairing for this Chrome. Pair it again from the extension's options page.");
      case "proof":
      case "result":
        return refuse(socket, `A ${message.type} comes only on a socket whose Chrome has proved itself.`);
    }
  };

  surface.upgrade(BRIDGE_PATH, (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // The Host check is the surface's; the Origin is the extension's fixed id, which no web page can send.
    if (request.headers.origin !== EXTENSION_ORIGIN) {
      return refuseUpgrade(socket, 403, { error: "forbidden", message: "Only the extension may open a socket here." });
    }
    server.handleUpgrade(request, socket, head, (ws) => {
      sockets.add(ws);
      ws.on("message", (data, isBinary) => onMessage(ws, data, isBinary));
      ws.on("close", () => {
        sockets.delete(ws);
        announced.delete(ws);
      });
      ws.on("error", () => ws.terminate());
    });
  });

  let listened: Promise<ExtensionListenerStatus> | undefined;
  const bind = async (ports: ExtensionListenerPorts): Promise<ExtensionListenerStatus> => {
    const candidates = portsOf(ports);
    for (const port of candidates) {
      try {
        const address = await surface.listen(LOOPBACK, port);
        return { state: "listening", port: address.port };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EADDRINUSE") continue;
        return { state: "not-listening", reason: "bind-failed", message: `Binding ${LOOPBACK}:${port} for the extension failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    const range = candidates.length === 1 ? `Port ${candidates[0]}` : `Ports ${candidates[0]} to ${candidates.at(-1)}`;
    return {
      state: "not-listening",
      reason: "port-in-use",
      message: `${range} on loopback ${candidates.length === 1 ? "is" : "are all"} in use, so no Chrome can reach this environment. Stop what holds ${candidates.length === 1 ? "it" : "one of them"}, then restart the environment.`,
    };
  };

  return {
    listen: (ports) => (listened ??= bind(ports)),
    unpairedConnected: () => announced.size > 0,
    async close() {
      const closing = [...sockets].map(
        (socket) =>
          new Promise<void>((resolve) => {
            socket.once("close", () => resolve());
            socket.close(1001);
          }),
      );
      let grace: Timer | undefined;
      await Promise.race([Promise.all(closing), new Promise<void>((resolve) => (grace = options.clock.setTimeout(resolve, CLOSE_GRACE_MS)))]);
      grace?.cancel();
      for (const socket of sockets) socket.terminate();
      await Promise.all(closing);
      await surface.close();
    },
  };
};
