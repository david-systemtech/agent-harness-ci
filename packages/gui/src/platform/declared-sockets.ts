import type { Observable, PlatformSocket, ShellNetwork, SocketHandlers, WebSocketFactory } from "@agent-harness/client-runtime";

/**
 * The renderer's side of the desktop's WebSocket lockdown
 * (docs/specs/gui.md, "The desktop shell"): Chromium cancels a WebSocket to
 * an address the renderer has not declared through `network.allow`,
 * loopback aside. The window declares each connection's address (the local
 * one's is loopback) whenever the list of them changes, so a forgotten
 * connection's address is closed again; and a socket to an address not
 * declared yet (a pairing tries its new client session before the
 * connection is kept) waits for its address to be declared before it
 * opens, and keeps it declared until it has opened or closed; then only
 * the connections' addresses are, so a pairing that failed leaves none.
 */

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])(:\d+)?$/i;
const SOCKET = /^(wss?):\/\/([^/?#\s]+)/i;

/** The address a WebSocket URL reaches, as a connection keeps it: `ws://host:port/ws` is `http://host:port`, `wss:` is `https:`. */
const addressOf = (url: string): { readonly address: string; readonly loopback: boolean } | undefined => {
  const match = SOCKET.exec(url);
  if (!match) return undefined;
  const [, scheme = "", host = ""] = match;
  return { address: `${scheme.toLowerCase() === "wss" ? "https" : "http"}://${host.toLowerCase()}`, loopback: LOOPBACK.test(host) };
};

const isWebAddress = (address: string): boolean => /^https?:\/\/[^/\s]+$/i.test(address);

export interface DeclaredSockets {
  /** Opens a WebSocket once its address is declared: at once when it is, or it is loopback. */
  readonly webSocket: WebSocketFactory;
  /** Declares every connection's address as the list changes; answers the stop. */
  follow(connections: Observable<readonly { readonly address: string }[]>): () => void;
}

export const declaredSockets = (network: ShellNetwork, open: WebSocketFactory, report: (error: unknown) => void): DeclaredSockets => {
  let connections: readonly string[] = [];
  /** Sockets waiting to open, by their address. */
  const waiting = new Map<string, number>();
  /** What the lockdown was last told, once it has taken it. */
  let taken: ReadonlySet<string> = new Set();
  let told = "";
  let telling: Promise<void> = Promise.resolve();

  /** Tells the lockdown the connections' addresses and the waiting sockets', when they are not what it was told last. */
  const declare = (): Promise<void> => {
    const addresses = [...new Set([...connections, ...waiting.keys()])].sort();
    const key = addresses.join(" ");
    if (key === told) return telling;
    told = key;
    telling = network.allow(addresses).then(() => {
      if (told === key) taken = new Set(addresses);
    });
    return telling;
  };

  const wait = (address: string, delta: 1 | -1) => {
    const count = (waiting.get(address) ?? 0) + delta;
    if (count > 0) waiting.set(address, count);
    else waiting.delete(address);
  };

  const webSocket: WebSocketFactory = (url, handlers) => {
    const reached = addressOf(url);
    if (!reached || reached.loopback || taken.has(reached.address)) return open(url, handlers);
    const { address } = reached;
    wait(address, 1);
    let done = false;
    // Opened or closed, the socket no longer needs its address declared: an address no connection keeps (a pairing that
    // failed) is closed again.
    const settle = () => {
      if (done) return;
      done = true;
      wait(address, -1);
      declare().catch(report);
    };
    const settling: SocketHandlers = {
      onOpen: () => (settle(), handlers.onOpen()),
      onMessage: (text) => handlers.onMessage(text),
      onClose: (code, reason) => (settle(), handlers.onClose(code, reason)),
    };
    let socket: PlatformSocket | undefined;
    let closed = false;
    const closeUnopened = (reason: string) => {
      if (closed) return;
      closed = true;
      settling.onClose(1006, reason);
    };
    declare().then(
      () => {
        if (!closed) socket = open(url, settling);
      },
      (error: unknown) => {
        report(error);
        closeUnopened(`The desktop did not let this window connect to ${address}.`);
      },
    );
    return {
      send: (text) => socket?.send(text),
      close(code, reason) {
        if (socket) socket.close(code, reason);
        else void Promise.resolve().then(() => closeUnopened(reason ?? "Closed before it opened."));
      },
    };
  };

  return {
    webSocket,
    follow(list) {
      const follow = (records: readonly { readonly address: string }[]) => {
        connections = records.map((record) => record.address).filter(isWebAddress);
        declare().catch(report);
      };
      follow(list.read());
      return list.subscribe(follow);
    },
  };
};
