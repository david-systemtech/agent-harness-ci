import { LIST_PATCH_KEY, SESSION_STREAM_KIND, type SessionSummary } from "@agent-harness/contracts";
import { uuidv7 } from "../ids.js";
import { PAIRED_CONNECTIONS_DOCUMENT } from "../connections/records.js";
import type { DocumentStore, HttpFetch, WebSocketFactory } from "../platform.js";
import { createRuntime } from "../runtime.js";
import { createStreamCache, streamDocument, type CachedPair } from "../streams/cache.js";
import { fakeWire, flush } from "./fake-wire.js";
import { inMemoryPlatform, manualClock, type InMemoryDocumentStore } from "./in-memory-platform.js";

/**
 * The storage contract (docs/specs/client-runtime.md, "Testing Decisions"):
 * what every platform's document storage (in memory, a state directory,
 * IndexedDB) must hold to for the cursor cache to be durable. Durability is
 * the behaviour here, so the cases read the documents:
 *
 * - a stream's cursor and snapshot are written together, in one document;
 * - a write cut off part way leaves the old pair whole, never a new cursor
 *   with an old snapshot or half of either;
 * - no secret (a client session token, local or paired, the grant's
 *   secret) is ever in document storage, whatever the runtime wrote there:
 *   the saved connections included.
 *
 * It depends on no test framework: `storageContractSuite(makeStore)` answers
 * named cases, each a function that throws on a failure, for a platform's
 * own suite to run: `for (const c of storageContractSuite(make)) it(c.name, c.run)`.
 */

export interface StorageContractCase {
  readonly name: string;
  run(): Promise<void>;
}

export interface StorageContractOptions {
  /**
   * Starts a write of `value` under `key` and cuts it off part way, as a
   * crash or a full disk would; resolves or rejects once it is over. Preset:
   * a write of a value that is not JSON, which a store must refuse whole. A
   * platform whose store takes such a value (IndexedDB's structured clone
   * takes a BigInt) passes its own.
   */
  readonly interrupt?: (store: DocumentStore, key: string, value: unknown) => Promise<void>;
}

const fail = (message: string): never => {
  throw new Error(`Storage contract: ${message}`);
};

const same = (actual: unknown, expected: unknown, what: string): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${what}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}.`);
};

const notJson = async (store: DocumentStore, key: string, value: unknown): Promise<void> => {
  await store.set(key, { ...(value as Record<string, unknown>), cut: BigInt(1) });
};

/** A summary as an environment sends it, for a session created at `at`. */
const summary = (id: string, title: string, at: string): SessionSummary => ({
  id,
  createdAt: at,
  updatedAt: at,
  lastActivityAt: null,
  title,
  titleSource: "user",
  archivedAt: null,
  pinnedAt: null,
  pinOrderKey: null,
  activeOrderKey: null,
  tags: [],
  groupId: null,
  settledAt: null,
  settledOverride: null,
  settledBy: null,
  unsettledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  workspace: { kind: "directory", path: "/work/storage-contract" },
  repositoryIdentity: null,
  workspaceMissingSince: null,
  activity: { state: "idle", since: at },
  parkedPromptCount: 0,
  accountId: null,
  model: null,
  runChoice: null,
  mode: null,
  browser: null,
  pullRequests: [],
  draft: null,
});

/** `store` with every key written remembered, so every document can be read back. */
const remembering = (store: DocumentStore): InMemoryDocumentStore & { readonly keys: ReadonlySet<string> } => {
  const keys = new Set<string>();
  const last = new Map<string, string>();
  return {
    keys,
    get: (key) => store.get(key),
    async set(key, value) {
      keys.add(key);
      last.set(key, JSON.stringify(value));
      await store.set(key, value);
    },
    async delete(key) {
      last.delete(key);
      await store.delete(key);
    },
    entries: () => Object.fromEntries([...last].map(([key, text]) => [key, JSON.parse(text) as unknown])),
  };
};

export const storageContractSuite = (
  makeStore: () => DocumentStore | Promise<DocumentStore>,
  options: StorageContractOptions = {},
): readonly StorageContractCase[] => [
  {
    name: "writes a stream's cursor and its snapshot together, in one document",
    async run() {
      const store = await makeStore();
      const sets: string[] = [];
      const counting: DocumentStore = {
        get: (k) => store.get(k),
        set(k, v) {
          sets.push(k);
          return store.set(k, v);
        },
        delete: (k) => store.delete(k),
      };
      const cache = createStreamCache({ documents: counting, clock: manualClock(), report: (error) => fail(`a write failed: ${String(error)}`) });
      const key = streamDocument("storage-contract", "list");
      const pair: CachedPair = { cursor: 42, snapshot: { sessions: [{ id: "a", title: "Ünïcode ✓" }], groups: [] } };
      await cache.now(key, () => pair);
      same(sets, [key], "the documents written");
      same(await cache.read(key), pair, "the pair read back");
      const raw = (await store.get(key)) as Record<string, unknown> | undefined;
      same([raw?.["sequence"], raw?.["snapshot"]], [pair.cursor, pair.snapshot], "the one document's cursor and snapshot");
    },
  },
  {
    name: "leaves the old pair whole when a write is cut off",
    async run() {
      const store = await makeStore();
      const cache = createStreamCache({ documents: store, clock: manualClock(), report: () => undefined });
      const key = streamDocument("storage-contract", "session.old-pair");
      const old: CachedPair = { cursor: 7, snapshot: { summary: { title: "old" }, events: [] } };
      await cache.now(key, () => old);
      const cut = { format: 1, sequence: 8, snapshot: { summary: { title: "new" }, events: [] } };
      try {
        await (options.interrupt ?? notJson)(store, key, cut);
      } catch {
        // Cut off: what is kept is the question.
      }
      same(await cache.read(key), old, "the pair after a write was cut off");
    },
  },
  {
    name: "never holds a secret: no client session token, local or paired, and no grant secret in any document",
    async run() {
      const store = remembering(await makeStore());
      const clock = manualClock();
      const wire = fakeWire({ clock, name: "storage contract" });
      // A second environment, paired through a link: its token must stay out of the saved connections.
      const paired = fakeWire({ clock, name: "storage contract paired", address: { host: "paired.test", port: 7433 } });
      const route = (url: string) => (url.includes("paired.test") ? paired : wire);
      const fetch: HttpFetch = (url, request) => route(url).fetch(url, request);
      const webSocket: WebSocketFactory = (url, handlers) => route(url).webSocket(url, handlers);
      const platform = inMemoryPlatform({ clock, documents: store, fetch, webSocket, grant: wire.grant });
      const runtime = createRuntime(platform);
      const sessionId = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
      const at = clock.now().toISOString();
      try {
        // The local connection through the grant, then its streams: a list with a session, and that session opened.
        wire.answer("sessions.subscribe", () => undefined);
        wire.answer("sessions.subscribeSession", () => undefined);
        const starting = runtime.start();
        await wire.server.accept();
        const list = await wire.server.request("sessions.subscribe");
        wire.server.send({ type: "subscribed", id: list.id, subscription: "list" });
        wire.server.send({
          type: "event",
          subscription: "list",
          sequence: 1,
          event: {
            sequence: 1,
            eventId: uuidv7(clock.now()),
            streamKind: SESSION_STREAM_KIND,
            streamId: sessionId,
            streamVersion: 1,
            type: "session.created",
            occurredAt: at,
            commandId: null,
            causationId: null,
            correlationId: null,
            actor: { kind: "system", id: "storage-contract" },
            payload: {},
            metadata: { [LIST_PATCH_KEY]: { op: "add", summary: summary(sessionId, "Invoices", at) } },
          },
        });
        wire.server.send({ type: "synchronized", subscription: "list", sequence: 1 });
        await starting;
        const handle = runtime.subscriptions.session(wire.environmentId, sessionId);
        const session = await wire.server.request("sessions.subscribeSession");
        wire.server.send({ type: "subscribed", id: session.id, subscription: "session" });
        wire.server.send({ type: "snapshot", subscription: "session", sequence: 1, payload: { sequence: 1, summary: summary(sessionId, "Invoices", at), runs: [], items: [], parkedPrompts: [], rewinds: [] } });
        wire.server.send({ type: "synchronized", subscription: "session", sequence: 1 });
        await flush();
        handle.release();

        // Its streams are left unanswered (refused, as a method the fake has no responder for): the pairing is what is checked.
        const adding = runtime.connections.add({ link: paired.link });
        await paired.server.accept();
        await adding;
      } finally {
        await runtime.close();
      }
      const secrets = [wire.credential()?.token, (await wire.grant.read())?.secret, paired.credential()?.token].filter((s): s is string => typeof s === "string");
      if (secrets.length !== 3) fail("the runtime never exchanged the grant and a pairing code.");
      if (!store.keys.has(streamDocument(wire.environmentId, "list"))) fail("the runtime wrote no list document, so nothing was checked.");
      if (!store.keys.has(PAIRED_CONNECTIONS_DOCUMENT)) fail("the runtime saved no paired connection, so nothing was checked.");
      for (const key of store.keys) {
        const text = JSON.stringify((await store.get(key)) ?? null);
        for (const secret of secrets) if (text.includes(secret)) fail(`document ${key} holds a secret.`);
      }
    },
  },
];
