import { randomBytes, randomUUID } from "node:crypto";
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
  type PageCall,
  type PageOutcome,
  type PagePolicy,
} from "@agent-harness/contracts";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { Clock, Timer } from "../serve/clock.js";
import { createHttpSurface, refuseUpgrade, type HttpSurface } from "../serve/http.js";
import { LOOPBACK } from "../serve/interfaces.js";
import { textOf } from "../wire/wire.js";

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
 * sub-step. A `pair` on it that the desk takes answers `paired`, and the
 * socket is the Chrome's from then on; one it refuses is answered `refused`
 * and the socket kept for the next. A paired extension opens with `hello`,
 * answered with a `challenge` carrying the environment's id and a nonce,
 * and a proof the desk takes answers `ready` (#548). Each paired Chrome
 * holds one proved socket at most: a newer one replaces it. A verb goes to
 * a Chrome as a `call` on its proved socket, answered by the `result` with
 * the call's id (#552); a socket that closes first, or a deadline that
 * passes, ends the call, and a later result is dropped.
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

/** An environment failure keeps the pairing: no `refused`, so the extension retries with its credential. */
const ENVIRONMENT_FAILURE_CLOSE_CODE = 1011;

/** How long the close waits for the extensions' sockets to close before it cuts them, as the wire's does. */
const CLOSE_GRACE_MS = 1000;

type Announce = Extract<BridgeFromExtension, { readonly type: "announce" }>;
export type Hello = Extract<BridgeFromExtension, { readonly type: "hello" }>;

/** What the desk made of a `pair`: the Chrome it paired, or the sentence the extension shows. */
export type PairAnswer = { readonly ok: true; readonly chromeId: string; readonly secret: string } | { readonly ok: false; readonly reason: string };

/** How a call to a Chrome ended: the extension's outcome, or why there was none. */
export type ChromeCallAnswer =
  | { readonly kind: "answered"; readonly outcome: PageOutcome }
  /** The Chrome holds no proved socket. */
  | { readonly kind: "not-connected" }
  /** Its socket closed, or was replaced or refused, before the result came. */
  | { readonly kind: "disconnected" }
  /** No result came within the deadline. */
  | { readonly kind: "timed-out" };

/**
 * Where the listener takes what its sockets ask of the environment's paired
 * Chromes (#548): a pairing, a proof, a Chrome that connected or went, and
 * the page policy it sends. A failure of `pair` or `prove` is answered on the
 * socket; `connected`, `disconnected` and `policy` never throw.
 */
export interface ChromeDesk {
  /** A `pair` on a socket that announced `announce`; `open` says whether the socket is still there to hear the answer. */
  pair(pair: { readonly code: string; readonly name: string }, announce: Announce, open: () => boolean): Promise<PairAnswer>;
  /** The proof `mac` of the hello's Chrome on `nonce`: true, or the sentence the socket is refused with. The listener logs a throw and closes with 1011, preserving the pairing. */
  prove(hello: Hello, nonce: string, mac: string): Promise<true | string>;
  /** The hello's Chrome proved itself and holds this socket now; a failure to record it is logged. */
  connected(hello: Hello): void;
  /** A Chrome's proved socket closed, and no newer one replaced it; a failure to record it is logged. */
  disconnected(chromeId: string): void;
  /** The page policy last sent to the proved sockets, held rather than read. */
  policy(): PagePolicy;
}

export interface ExtensionListenerOptions {
  readonly clock: Clock;
  /** The environment an extension finds on the port: its id, and its name as it is now. */
  readonly environment: { readonly id: string; readonly name: () => string };
  /** An extension that holds no credential announced itself, and its socket is kept. */
  readonly onAnnounce: (announce: Announce) => void;
  readonly chromes: ChromeDesk;
}

export interface ExtensionListener {
  /** Binds loopback on the first free port of `ports`, and answers where it listens or why it does not. Once. */
  listen(ports: ExtensionListenerPorts): Promise<ExtensionListenerStatus>;
  /** Whether an extension that announced itself, and has not paired, holds its socket open. */
  unpairedConnected(): boolean;
  /** Whether the Chrome `chromeId` holds a proved socket now. */
  isConnected(chromeId: string): boolean;
  /** Refuses the Chrome's proved socket with `reason` and closes it, raising no disconnection: its pairing is gone. */
  drop(chromeId: string, reason: string): void;
  /** Sends `policy` to every proved socket. */
  sendPolicy(policy: PagePolicy): void;
  /** Sends `call` to the Chrome's proved socket, and answers its result, or why none came within `deadlineMs`. Never rejects. */
  call(chromeId: string, call: PageCall, deadlineMs: number): Promise<ChromeCallAnswer>;
  /** Closes every socket (1001), cutting what has not closed after a second, then stops listening. */
  close(): Promise<void>;
}

/**
 * Where a socket's conversation is: opened with nothing yet; announced (a
 * pairing may be under way); challenged on a hello (its proof may be under
 * way); or live, the proved or paired socket of a Chrome.
 */
type Conversation =
  | { readonly state: "opened" }
  | { readonly state: "announced"; readonly announce: Announce; readonly pairing: boolean }
  | { readonly state: "challenged"; readonly hello: Hello; readonly nonce: string; readonly proving: boolean }
  | { readonly state: "live"; readonly chromeId: string };

const portsOf = ({ preferred, last }: ExtensionListenerPorts): number[] =>
  preferred === 0 ? [0] : Array.from({ length: Math.max(1, last - preferred + 1) }, (_, index) => preferred + index);

export const createExtensionListener = (options: ExtensionListenerOptions): ExtensionListener => {
  const surface: HttpSurface = createHttpSurface();
  const server = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, clientTracking: false });
  const conversations = new Map<WebSocket, Conversation>();
  /** Each paired Chrome's proved socket. */
  const live = new Map<string, WebSocket>();
  /** The calls each proved socket has not answered yet, by call id: each ends with the answer given to it. */
  const calls = new Map<WebSocket, Map<string, (answer: ChromeCallAnswer) => void>>();
  const { chromes } = options;

  const send = (socket: WebSocket, message: BridgeFromEnvironment): void => {
    if (socket.readyState === socket.OPEN) socket.send(encodeBridgeMessage(message));
  };

  /** Ends the conversation: `refused` with the sentence, then the close. */
  const refuse = (socket: WebSocket, reason: string): void => {
    send(socket, { type: "refused", reason });
    socket.close(REFUSED_CLOSE_CODE);
  };

  const isOpen = (socket: WebSocket): boolean => socket.readyState === socket.OPEN;

  /** Makes `socket` the Chrome's one proved socket, closing the one it replaces, which raises no disconnection. */
  const goLive = (socket: WebSocket, chromeId: string): void => {
    const replaced = live.get(chromeId);
    live.set(chromeId, socket);
    conversations.set(socket, { state: "live", chromeId });
    if (replaced !== undefined && replaced !== socket) replaced.close(1000);
  };

  const pair = async (socket: WebSocket, conversation: Extract<Conversation, { state: "announced" }>, message: { readonly code: string; readonly name: string }): Promise<void> => {
    conversations.set(socket, { ...conversation, pairing: true });
    let answer: PairAnswer;
    try {
      answer = await chromes.pair(message, conversation.announce, () => isOpen(socket));
    } catch (error) {
      answer = { ok: false, reason: `Pairing failed in the environment: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!isOpen(socket)) return;
    if (!answer.ok) {
      conversations.set(socket, { ...conversation, pairing: false });
      return send(socket, { type: "refused", reason: answer.reason });
    }
    goLive(socket, answer.chromeId);
    send(socket, { type: "paired", chromeId: answer.chromeId, secret: answer.secret, policy: chromes.policy() });
  };

  const prove = async (socket: WebSocket, conversation: Extract<Conversation, { state: "challenged" }>, mac: string): Promise<void> => {
    conversations.set(socket, { ...conversation, proving: true });
    let proved: true | string;
    try {
      proved = await chromes.prove(conversation.hello, conversation.nonce, mac);
    } catch (error) {
      console.error(`Checking the proof of the Chrome ${conversation.hello.chromeId.toLowerCase()} failed:`, error);
      // A failed check says nothing about the credential; a refusal would make Chrome forget it.
      if (isOpen(socket)) socket.close(ENVIRONMENT_FAILURE_CLOSE_CODE);
      return;
    }
    if (!isOpen(socket)) return;
    if (proved !== true) return refuse(socket, proved);
    goLive(socket, conversation.hello.chromeId.toLowerCase());
    chromes.connected(conversation.hello);
    send(socket, { type: "ready", policy: chromes.policy() });
  };

  const onMessage = (socket: WebSocket, data: RawData, isBinary: boolean): void => {
    const text = textOf(data, isBinary);
    if (text === undefined) return refuse(socket, "The bridge carries JSON text, one message a frame, never binary.");
    const decoded = decodeFromExtension(text);
    if (!decoded.ok) return refuse(socket, decoded.reason);
    const message = decoded.message;
    const conversation = conversations.get(socket) ?? { state: "opened" };
    switch (message.type) {
      case "announce":
        if (conversation.state !== "opened" && conversation.state !== "announced") return refuse(socket, "This socket opened already; an announce opens a socket.");
        if (conversation.state === "opened") conversations.set(socket, { state: "announced", announce: message, pairing: false });
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
        if (conversation.state !== "announced") return refuse(socket, "A pair comes on a socket that opened with announce.");
        if (conversation.pairing) return send(socket, { type: "refused", reason: "A pairing is under way on this socket; wait for its answer." });
        return void pair(socket, conversation, message);
      case "hello": {
        if (conversation.state !== "opened") return refuse(socket, "This socket opened already; a hello opens a socket.");
        const nonce = randomBytes(32).toString("hex");
        conversations.set(socket, { state: "challenged", hello: message, nonce, proving: false });
        return send(socket, { type: "challenge", environmentId: options.environment.id, nonce });
      }
      case "proof":
        if (conversation.state !== "challenged" || conversation.proving) return refuse(socket, "A proof answers the challenge to a hello, once.");
        return void prove(socket, conversation, message.mac);
      case "result":
        if (conversation.state !== "live") return refuse(socket, "A result comes only on a socket whose Chrome has proved itself.");
        // A result for a call that ended (its deadline passed) or that this socket was never sent is dropped.
        return calls.get(socket)?.get(message.id)?.({ kind: "answered", outcome: message.result });
    }
  };

  let closing = false;
  surface.upgrade(BRIDGE_PATH, (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (closing) return refuseUpgrade(socket, 503, { error: "closing", message: "The environment is stopping." });
    // The Host check is the surface's; the Origin is the extension's fixed id, which no web page can send.
    if (request.headers.origin !== EXTENSION_ORIGIN) {
      return refuseUpgrade(socket, 403, { error: "forbidden", message: "Only the extension may open a socket here." });
    }
    server.handleUpgrade(request, socket, head, (ws) => {
      conversations.set(ws, { state: "opened" });
      ws.on("message", (data, isBinary) => onMessage(ws, data, isBinary));
      ws.on("close", () => {
        const conversation = conversations.get(ws);
        conversations.delete(ws);
        for (const end of [...(calls.get(ws)?.values() ?? [])]) end({ kind: "disconnected" });
        if (conversation?.state !== "live" || live.get(conversation.chromeId) !== ws) return;
        live.delete(conversation.chromeId);
        // A stop closes every socket: that is no Chrome going.
        if (!closing) chromes.disconnected(conversation.chromeId);
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
        // Taken, or on Windows reserved (an excluded port range answers EACCES): the next port may be free.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EADDRINUSE" || code === "EACCES") continue;
        return { state: "not-listening", reason: "bind-failed", message: `Binding ${LOOPBACK}:${port} for the extension failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    const range = candidates.length === 1 ? `Port ${candidates[0]}` : `Ports ${candidates[0]} to ${candidates.at(-1)}`;
    return {
      state: "not-listening",
      reason: "port-in-use",
      message: `${range} on loopback ${candidates.length === 1 ? "is" : "are all"} in use or reserved, so no Chrome can reach this environment. Stop what holds ${candidates.length === 1 ? "it" : "one of them"}, then restart the environment.`,
    };
  };

  return {
    listen: (ports) => (listened ??= bind(ports)),
    unpairedConnected: () => [...conversations.values()].some((conversation) => conversation.state === "announced"),
    isConnected: (chromeId) => live.has(chromeId),
    drop(chromeId, reason) {
      const socket = live.get(chromeId);
      if (socket === undefined) return;
      live.delete(chromeId);
      refuse(socket, reason);
    },
    sendPolicy(policy) {
      for (const socket of live.values()) send(socket, { type: "policy", policy });
    },
    call(chromeId, call, deadlineMs) {
      const socket = live.get(chromeId);
      if (socket === undefined || !isOpen(socket)) return Promise.resolve({ kind: "not-connected" });
      const id = randomUUID();
      const open = calls.get(socket) ?? new Map<string, (answer: ChromeCallAnswer) => void>();
      calls.set(socket, open);
      return new Promise<ChromeCallAnswer>((resolve) => {
        const deadline = options.clock.setTimeout(() => end({ kind: "timed-out" }), deadlineMs);
        const end = (answer: ChromeCallAnswer): void => {
          deadline.cancel();
          open.delete(id);
          if (open.size === 0 && calls.get(socket) === open) calls.delete(socket);
          resolve(answer);
        };
        open.set(id, end);
        send(socket, { type: "call", id, ...call });
      });
    },
    async close() {
      closing = true;
      const sockets = [...conversations.keys()];
      const closed = sockets.map(
        (socket) =>
          new Promise<void>((resolve) => {
            socket.once("close", () => resolve());
            socket.close(1001);
          }),
      );
      let grace: Timer | undefined;
      await Promise.race([Promise.all(closed), new Promise<void>((resolve) => (grace = options.clock.setTimeout(resolve, CLOSE_GRACE_MS)))]);
      grace?.cancel();
      for (const socket of conversations.keys()) socket.terminate();
      await Promise.all(closed);
      await surface.close();
    },
  };
};
