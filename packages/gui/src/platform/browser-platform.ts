import { standardWebSocketFactory, writable, type Clock, type DocumentStore, type NetworkSignal, type NetworkState, type Platform, type SecretStore, type Observable } from "@agent-harness/client-runtime";

import { indexedDocuments } from "./indexed-documents.js";
import { indexedSecrets } from "./indexed-secrets.js";
import { runsInstalled, webClientLabel } from "./browser-name.js";

/** Browser storage has no OS secret protection; credentials stay in a separate origin-local database. */
export interface BrowserPlatform extends Platform {
  readonly persistence: Observable<"persistent" | "visit-only">;
}

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

/** A failed storage operation switches to memory and announces pairing for this visit. */
export const browserPlatform = (view: Window & typeof globalThis, version: string): BrowserPlatform => {
  const persistence = writable<"persistent" | "visit-only">("persistent");
  const documents = memoryDocuments();
  const secrets = memorySecrets();
  const fallback = <T>(persistent: () => Promise<T>, memory: () => Promise<T>): Promise<T> => {
    if (persistence.read() === "visit-only") return memory();
    return Promise.resolve().then(persistent).catch(() => { persistence.set("visit-only"); return memory(); });
  };
  // Access to indexedDB itself may throw in privacy modes; defer it to the guarded operation.
  let storedDocuments: DocumentStore | undefined;
  let storedSecrets: SecretStore | undefined;
  const documentStore = () => storedDocuments ??= indexedDocuments(view.indexedDB);
  const secretStore = () => storedSecrets ??= indexedSecrets(view.indexedDB);
  return {
    persistence,
    documents: {
      get: key => fallback(async () => {
        const value = await documentStore().get(key);
        if (value !== undefined) await documents.set(key, value);
        return value;
      }, () => documents.get(key)),
      set: async (key, value) => { await documents.set(key, value); await fallback(() => documentStore().set(key, value), async () => undefined); },
      delete: async key => { await documents.delete(key); await fallback(() => documentStore().delete(key), async () => undefined); },
    },
    secrets: {
      get: key => fallback(async () => {
        const value = await secretStore().get(key);
        if (value !== undefined) await secrets.set(key, value);
        return value;
      }, () => secrets.get(key)),
      set: async (key, value) => { await secrets.set(key, value); await fallback(() => secretStore().set(key, value), async () => undefined); },
      // Always attempt erasure, including after a transient persistence failure.
      delete: async key => { await secrets.delete(key); try { await secretStore().delete(key); } catch { persistence.set("visit-only"); } },
    },
    webSocket: standardWebSocketFactory(view.WebSocket),
    fetch: (url, request) => view.fetch(url, request),
    clock: systemClock(), network: browserNetwork(view),
    client: { kind: "web", label: webClientLabel(view.navigator.userAgent, runsInstalled(view)), version },
    // Raw errors can contain pairing URLs or connection credentials; keep them out of the console.
    reportError: () => view.console.error("The browser client could not complete an operation."),
  };
};

/** Whether the browser runs on macOS, where the keys' `Mod` is ⌘. */
export const onMacOS = (navigator: Navigator): boolean => /^Mac/.test(navigator.platform) || /Macintosh/.test(navigator.userAgent);
