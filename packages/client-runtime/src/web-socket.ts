import type { WebSocketFactory } from "./platform.js";

/** The part of a standard (WHATWG) WebSocket the factory drives: a browser's, or Node's global one. */
interface StandardSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/**
 * A WebSocket factory over a standard `WebSocket` constructor: the browser's
 * and the desktop renderer's, or Node's global one in the terminal UI and in
 * tests. Takes the constructor rather than reading a global, so the runtime
 * names no DOM or Node type.
 */
export const standardWebSocketFactory =
  (WebSocketClass: new (url: string) => unknown): WebSocketFactory =>
  (url, handlers) => {
    let closed = false;
    const closeOnce = (code: number, reason: string) => {
      if (closed) return;
      closed = true;
      handlers.onClose(code, reason);
    };
    let socket: StandardSocket;
    try {
      socket = new WebSocketClass(url) as StandardSocket;
    } catch (error) {
      // A URL the constructor refuses closes the socket it never opened, as a refused connection does.
      void Promise.resolve().then(() => closeOnce(1006, error instanceof Error ? error.message : String(error)));
      return { send: () => undefined, close: () => undefined };
    }
    socket.onopen = () => handlers.onOpen();
    socket.onmessage = (event) => {
      if (typeof event.data === "string") handlers.onMessage(event.data);
    };
    socket.onclose = (event) => closeOnce(event.code, event.reason);
    // An error is followed by a close, which reports it.
    socket.onerror = () => undefined;
    return {
      send(text) {
        try {
          socket.send(text);
        } catch {
          // Sending on a socket that is not open drops the frame; its close is reported.
        }
      },
      close(code, reason) {
        try {
          socket.close(code, reason);
        } catch {
          socket.close();
        }
      },
    };
  };
