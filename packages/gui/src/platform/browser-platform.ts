import { standardWebSocketFactory, writable, type Clock, type DocumentStore, type NetworkSignal, type NetworkState, type Platform, type SecretStore } from "@agent-harness/client-runtime";

/**
 * What the runtime needs from a window, from what every browser has
 * (docs/specs/gui.md, "The desktop platform"): the system clock, the network
 * signal from the online and visibility events, the browser's WebSocket and
 * `fetch`. The desktop platform (#395) keeps its documents in IndexedDB and
 * its client session tokens through the shell's `secrets`, and reaches HTTP
 * through the shell's `http`; the browser tab's is milestone 2's. Until then
 * the bundle's own platform keeps its documents and tokens in memory, so a
 * reload forgets them.
 */

/** The system's time and timers. */
export const systemClock = (): Clock => ({
  now: () => new Date(),
  setTimeout(callback, ms) {
    const timer = globalThis.setTimeout(callback, ms);
    return { cancel: () => globalThis.clearTimeout(timer) };
  },
});

/** Online or offline as the browser's `online` and `offline` events say, and in the foreground while the page is visible. */
export const browserNetwork = (view: Window): NetworkSignal => {
  const now = (): NetworkState => ({ online: view.navigator.onLine, foreground: view.document.visibilityState === "visible" });
  const signal = writable(now());
  const follow = () => {
    const next = now();
    signal.update((was) => (was.online === next.online && was.foreground === next.foreground ? was : next));
  };
  view.addEventListener("online", follow);
  view.addEventListener("offline", follow);
  view.document.addEventListener("visibilitychange", follow);
  return { read: signal.read, subscribe: signal.subscribe };
};

/** Documents held as JSON text in memory, as storage would hold them, gone with the page. */
const memoryDocuments = (): DocumentStore => {
  const texts = new Map<string, string>();
  return {
    get: async (key) => {
      const text = texts.get(key);
      return text === undefined ? undefined : (JSON.parse(text) as unknown);
    },
    set: async (key, value) => void texts.set(key, JSON.stringify(value)),
    delete: async (key) => void texts.delete(key),
  };
};

const memorySecrets = (): SecretStore => {
  const secrets = new Map<string, string>();
  return {
    get: async (name) => secrets.get(name),
    set: async (name, secret) => void secrets.set(name, secret),
    delete: async (name) => void secrets.delete(name),
  };
};

/** The bundle's platform in `view`, a browser tab's kind, reporting what the runtime cannot hand back to the console. */
export const browserPlatform = (view: Window & typeof globalThis, version: string): Platform => ({
  documents: memoryDocuments(),
  secrets: memorySecrets(),
  webSocket: standardWebSocketFactory(view.WebSocket),
  fetch: (url, request) => view.fetch(url, request),
  clock: systemClock(),
  network: browserNetwork(view),
  client: { kind: "web", label: "Browser tab", version },
  reportError: (error) => view.console.error(error),
});

/** Whether the browser runs on macOS, where the keys' `Mod` is ⌘. */
export const onMacOS = (navigator: Navigator): boolean => /^Mac/.test(navigator.platform) || /Macintosh/.test(navigator.userAgent);
