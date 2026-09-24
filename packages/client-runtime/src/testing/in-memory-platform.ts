import { writable, type Observable } from "../observable.js";
import type {
  Clock,
  DocumentStore,
  GrantReader,
  HttpFetch,
  NetworkState,
  Platform,
  RuntimeClientKind,
  SecretStore,
  Timer,
  WebSocketFactory,
} from "../platform.js";
import type { Shell } from "../shell.js";
import { standardWebSocketFactory } from "../web-socket.js";

/**
 * The in-memory platform the runtime's tests run on, and any client's
 * (docs/specs/client-runtime.md, "Testing Decisions"): documents and secrets
 * in memory, a clock that moves only when told, a network signal the test
 * toggles, a seeded jitter source, and a fake shell. It talks to a real
 * environment over the global `fetch` and `WebSocket` unless given others;
 * `fake-wire.ts` gives it a scripted one.
 */

/** A clock that stands still until `advance` moves it; timers run as it passes them. */
export interface ManualClock extends Clock {
  /** Moves time on by `ms`, running every timer due on the way in due order, each with `now` at its due time. */
  advance(ms: number): void;
  /** How many timers are scheduled. */
  pending(): number;
}

export const MANUAL_CLOCK_START = "2026-09-24T00:00:00.000Z";

export const manualClock = (start: Date | string = MANUAL_CLOCK_START): ManualClock => {
  let now = new Date(start).getTime();
  let nextId = 1;
  const timers = new Map<number, { readonly id: number; readonly due: number; readonly callback: () => void }>();
  const nextDue = (until: number) => {
    let first: { readonly id: number; readonly due: number; readonly callback: () => void } | undefined;
    for (const timer of timers.values()) {
      if (timer.due > until) continue;
      if (!first || timer.due < first.due || (timer.due === first.due && timer.id < first.id)) first = timer;
    }
    return first;
  };
  return {
    now: () => new Date(now),
    setTimeout(callback, ms): Timer {
      if (!(ms >= 0)) throw new RangeError(`A delay is 0 ms or more; got ${ms}.`);
      const id = nextId++;
      timers.set(id, { id, due: now + ms, callback });
      return { cancel: () => void timers.delete(id) };
    },
    advance(ms) {
      if (!(ms >= 0)) throw new RangeError(`Time moves forward; got ${ms} ms.`);
      const until = now + ms;
      for (let timer = nextDue(until); timer; timer = nextDue(until)) {
        now = timer.due;
        timers.delete(timer.id);
        timer.callback();
      }
      now = until;
    },
    pending: () => timers.size,
  };
};

/** A deterministic source of numbers in [0, 1) (mulberry32), so a test's backoff jitter is the same on every run. */
export const seededRandom = (seed = 1): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Documents kept as JSON text, so a value that is not plain JSON fails here as it would in real storage. */
export interface InMemoryDocumentStore extends DocumentStore {
  /** Every document, for a storage contract test. */
  entries(): Record<string, unknown>;
}

export const inMemoryDocuments = (): InMemoryDocumentStore => {
  const texts = new Map<string, string>();
  return {
    get: async (key) => {
      const text = texts.get(key);
      return text === undefined ? undefined : (JSON.parse(text) as unknown);
    },
    set: async (key, value) => void texts.set(key, JSON.stringify(value)),
    delete: async (key) => void texts.delete(key),
    entries: () => Object.fromEntries([...texts].map(([key, text]) => [key, JSON.parse(text) as unknown])),
  };
};

export const inMemorySecrets = (): SecretStore => {
  const secrets = new Map<string, string>();
  return {
    get: async (name) => secrets.get(name),
    set: async (name, secret) => void secrets.set(name, secret),
    delete: async (name) => void secrets.delete(name),
  };
};

/** A network signal the test toggles. */
export interface InMemoryNetwork extends Observable<NetworkState> {
  setOnline(online: boolean): void;
  setForeground(foreground: boolean): void;
}

export const inMemoryNetwork = (): InMemoryNetwork => {
  const state = writable<NetworkState>({ online: true, foreground: true });
  return {
    read: state.read,
    subscribe: state.subscribe,
    setOnline: (online) => state.update((s) => (s.online === online ? s : { ...s, online })),
    setForeground: (foreground) => state.update((s) => (s.foreground === foreground ? s : { ...s, foreground })),
  };
};

/** A shell with every member, each recording its call as `[member path, argument]` and answering something plain. */
export type FakeShell = Required<Shell> & { readonly calls: [string, unknown][] };

export const fakeShell = (): FakeShell => {
  const calls: [string, unknown][] = [];
  const record =
    <A extends unknown[], R>(member: string, answer: R) =>
    (...args: A): R => {
      calls.push([member, args[0]]);
      return answer;
    };
  return {
    calls,
    dialogs: {
      openFile: record("dialogs.openFile", Promise.resolve([])),
      openDirectory: record("dialogs.openDirectory", Promise.resolve(undefined)),
      save: record("dialogs.save", Promise.resolve(undefined)),
    },
    window: { setTitle: record("window.setTitle", undefined), focus: record("window.focus", undefined), setBadge: record("window.setBadge", undefined) },
    notifications: { show: record("notifications.show", Promise.resolve()) },
    tray: { setTooltip: record("tray.setTooltip", undefined), onClick: record("tray.onClick", () => undefined) },
    deepLinks: { onOpen: record("deepLinks.onOpen", () => undefined) },
    webView: {
      create: record("webView.create", Promise.resolve("view-1")),
      attach: record("webView.attach", undefined),
      navigate: record("webView.navigate", Promise.resolve()),
      destroy: record("webView.destroy", undefined),
    },
    installer: {},
    update: { check: record("update.check", Promise.resolve({ available: false })), install: record("update.install", Promise.resolve()) },
    service: {
      install: record("service.install", Promise.resolve()),
      start: record("service.start", Promise.resolve()),
      status: record("service.status", Promise.resolve({ installed: true, running: true, ready: true })),
    },
    clipboard: { readText: record("clipboard.readText", Promise.resolve("")), writeText: record("clipboard.writeText", Promise.resolve()) },
    openExternal: record("openExternal", Promise.resolve()),
    localGrant: { read: record("localGrant.read", Promise.resolve(undefined)) },
    secrets: inMemorySecrets(),
  };
};

/** Node's global `WebSocket`, the one a browser has too. */
export const globalWebSocket = (): WebSocketFactory =>
  standardWebSocketFactory((globalThis as unknown as { WebSocket: new (url: string) => unknown }).WebSocket);

/** The global `fetch`. */
export const globalFetch = (): HttpFetch => {
  const fetch = (globalThis as unknown as { fetch: HttpFetch }).fetch;
  return (url, request) => fetch(url, request);
};

export interface InMemoryPlatformOptions {
  /** Preset `tui`. */
  readonly kind?: RuntimeClientKind;
  /** Preset `a <kind> under test`. */
  readonly label?: string;
  /** Preset `0.0.0-test`. */
  readonly version?: string;
  readonly grant?: GrantReader;
  readonly shell?: Shell;
  /** Pass another platform's stores to start a runtime again on what it saved. */
  readonly documents?: InMemoryDocumentStore;
  readonly secrets?: SecretStore;
  readonly clock?: ManualClock;
  /** The backoff's jitter source. Preset: `seededRandom()`. */
  readonly random?: () => number;
  /** Preset: the global `fetch`. */
  readonly fetch?: HttpFetch;
  /** Preset: the global `WebSocket`. */
  readonly webSocket?: WebSocketFactory;
}

export interface InMemoryPlatform extends Platform {
  readonly random: () => number;
  readonly documents: InMemoryDocumentStore;
  readonly secrets: SecretStore;
  readonly clock: ManualClock;
  readonly network: InMemoryNetwork;
}

export const inMemoryPlatform = (options: InMemoryPlatformOptions = {}): InMemoryPlatform => {
  const kind = options.kind ?? "tui";
  return {
    documents: options.documents ?? inMemoryDocuments(),
    secrets: options.secrets ?? inMemorySecrets(),
    webSocket: options.webSocket ?? globalWebSocket(),
    fetch: options.fetch ?? globalFetch(),
    clock: options.clock ?? manualClock(),
    random: options.random ?? seededRandom(),
    network: inMemoryNetwork(),
    client: { kind, label: options.label ?? `a ${kind} under test`, version: options.version ?? "0.0.0-test" },
    ...(options.grant !== undefined && { grant: options.grant }),
    ...(options.shell !== undefined && { shell: options.shell }),
  };
};
