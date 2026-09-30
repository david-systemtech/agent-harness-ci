import type { CdpTransport } from "./session.js";

/**
 * A transport over a WebSocket to a browser's DevTools address
 * (`ws://127.0.0.1:9222/devtools/browser/…`), with the platform's own
 * `WebSocket`, which browsers and Node both have. It opens before it
 * answers; one that cannot open rejects with why.
 */
export const webSocketTransport = (url: string): Promise<CdpTransport> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const messageListeners: ((message: string) => void)[] = [];
    const closeListeners: ((reason: string) => void)[] = [];
    let opened = false;
    let closed = false;
    const closedWith = (reason: string): void => {
      if (closed) return;
      closed = true;
      for (const listener of closeListeners) listener(reason);
    };
    socket.addEventListener("message", (event: MessageEvent) => {
      // The protocol speaks text frames; a binary frame is no message of it.
      if (typeof event.data !== "string") return;
      for (const listener of messageListeners) listener(event.data);
    });
    socket.addEventListener("close", (event: CloseEvent) => {
      if (!opened) reject(new Error(`Could not open a CDP WebSocket to ${url} (closed with ${event.code}).`));
      closedWith(event.reason === "" ? `the WebSocket closed with ${event.code}` : event.reason);
    });
    socket.addEventListener("error", () => {
      if (!opened) reject(new Error(`Could not open a CDP WebSocket to ${url}.`));
    });
    socket.addEventListener("open", () => {
      opened = true;
      resolve({
        send(message) {
          if (!closed && socket.readyState === WebSocket.OPEN) socket.send(message);
        },
        onMessage: (listener) => void messageListeners.push(listener),
        onClose: (listener) => void closeListeners.push(listener),
        close() {
          socket.close();
          closedWith("the driver closed the WebSocket");
        },
      });
    });
  });
