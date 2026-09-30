import type { CdpTransport } from "./session.js";

/**
 * The two ends of a pipe to a browser, as byte streams: what a Chromium
 * launched with `--remote-debugging-pipe` reads its commands from (its file
 * descriptor 3) and writes its answers and events to (its 4). A Node host
 * hands them over as web streams (`Writable.toWeb`, `Readable.toWeb`), so
 * this package reads them with the platform's own streams and imports no
 * Node built-in.
 */
export interface CdpPipe {
  /** What the browser writes: its answers and events. */
  readonly readable: ReadableStream<Uint8Array>;
  /** What the browser reads: the commands. */
  readonly writable: WritableStream<Uint8Array>;
}

/** What ends each message on the pipe: a NUL, which JSON never writes raw. */
const SEPARATOR = "\0";

/**
 * A transport over a pipe: each message written as UTF-8 and ended with a
 * NUL, each read one cut at its NUL however the bytes were chunked, a
 * character split across two chunks included.
 */
export const pipeTransport = (pipe: CdpPipe): CdpTransport => {
  const messageListeners: ((message: string) => void)[] = [];
  const closeListeners: ((reason: string) => void)[] = [];
  const writer = pipe.writable.getWriter();
  const reader = pipe.readable.getReader();
  const encoder = new TextEncoder();
  let closed = false;

  const close = (reason: string): void => {
    if (closed) return;
    closed = true;
    void reader.cancel().catch(() => undefined);
    void writer.close().catch(() => undefined);
    for (const listener of closeListeners) listener(reason);
  };

  void (async () => {
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let end = buffered.indexOf(SEPARATOR);
        while (end !== -1) {
          const message = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          for (const listener of messageListeners) listener(message);
          end = buffered.indexOf(SEPARATOR);
        }
      }
      close("the browser closed the pipe");
    } catch (error) {
      close(`the pipe failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();

  return {
    send(message) {
      if (closed) return;
      writer.write(encoder.encode(message + SEPARATOR)).catch((error: unknown) => close(`the pipe failed: ${error instanceof Error ? error.message : String(error)}`));
    },
    onMessage: (listener) => void messageListeners.push(listener),
    onClose: (listener) => void closeListeners.push(listener),
    close: () => close("the driver closed the pipe"),
  };
};
