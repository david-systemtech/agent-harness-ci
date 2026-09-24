import type { Clock, DocumentStore, Timer } from "../platform.js";

/**
 * The cursor cache (docs/specs/client-runtime.md, "Subscriptions, cursor
 * cache and snapshots"): one document per stream, `streams.<environmentId>.<stream>`,
 * holding the stream's cursor and the snapshot it belongs to, so the two are
 * written in one `set` and a storage that keeps either the old document or
 * the new one never pairs a cursor with another state. A stream asks for a
 * write once an update has applied, never before, and the write reads the
 * committed state when it runs: soon (debounced 500 ms on the platform
 * clock) or now (every `synchronized`, a disconnect). Writes to one document
 * go one after another, so an older pair never lands over a newer one.
 *
 * Retention: the session snapshots of an environment are the 50 most
 * recently opened, under 32 MiB, never one a handle holds; the list and the
 * environment's own stream are always kept. What is opened when, each
 * snapshot's size, and the environment's clock skew live in one more
 * document, `streams.<environmentId>.meta`, since document storage cannot
 * list its keys.
 *
 * The documents are named after streams and cursors, never after a session
 * field (ADR 0003's lint): a cache document is the stream as the
 * environment sent it, not organisation state of the client's own.
 */

/** A stream's pending changes are written at most this long after they applied. A chosen default. */
export const STREAM_WRITE_DEBOUNCE_MS = 500;
/** Session snapshots kept per environment. A chosen default after T3 Code. */
export const RETAINED_SESSIONS = 50;
/** The most the session snapshots of one environment may take, as UTF-8. A chosen default after T3 Code. */
export const RETAINED_BYTES = 32 * 1024 * 1024;

/** The stream document's shape version. */
const FORMAT = 1;

/** The document a stream is cached under: `list`, `environment`, or `session.<sessionId>`. */
export const streamDocument = (environmentId: string, stream: string): string => `streams.${environmentId}.${stream}`;

/** The document an environment's retention and clock skew are kept under. */
export const metaDocument = (environmentId: string): string => `streams.${environmentId}.meta`;

/** A stream as cached: its cursor, and the snapshot (the stream kind's stored form of its state) as of that cursor. */
export interface CachedPair {
  readonly cursor: number;
  readonly snapshot: unknown;
}

/** How many bytes `text` takes as UTF-8: what a snapshot costs against the cap. */
export const utf8Length = (text: string): number => {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export interface CacheOptions {
  readonly documents: DocumentStore;
  readonly clock: Clock;
  /** A write that failed: nobody awaits a debounced one. */
  readonly report: (error: unknown) => void;
  /** Hears the size of each document written. */
  readonly onWritten?: (key: string, bytes: number) => void | Promise<void>;
}

export interface StreamCache {
  /** The pair a document holds; undefined when there is none, or one this build cannot read. */
  read(key: string): Promise<CachedPair | undefined>;
  /** Writes `current()`, as it is then, within `STREAM_WRITE_DEBOUNCE_MS`; a later call before then replaces `current`. */
  soon(key: string, current: () => CachedPair | null): void;
  /** Writes `current()` at once, dropping a pending debounce of the same document; resolves once written (a failure is reported). */
  now(key: string, current: () => CachedPair | null): Promise<void>;
  /** Writes every pending document, or those under `streams.<environmentId>.`, at once. */
  flush(environmentId?: string): Promise<void>;
  /** Drops a pending write and deletes the document. */
  remove(key: string): Promise<void>;
  /** Settles once every write under way has. */
  idle(): Promise<void>;
}

export const createStreamCache = (options: CacheOptions): StreamCache => {
  const { documents, clock, report } = options;
  const pending = new Map<string, { readonly timer: Timer; current: () => CachedPair | null }>();
  const chains = new Map<string, Promise<void>>();

  /** Runs `work` after every earlier write to `key`, whatever became of them. */
  const serial = (key: string, work: () => Promise<void>): Promise<void> => {
    const next = (chains.get(key) ?? Promise.resolve()).then(work, work);
    chains.set(key, next);
    void next.finally(() => {
      if (chains.get(key) === next) chains.delete(key);
    });
    return next;
  };

  const write = (key: string, current: () => CachedPair | null): Promise<void> =>
    serial(key, async () => {
      const pair = current();
      if (pair === null) return;
      const document = { format: FORMAT, sequence: pair.cursor, snapshot: pair.snapshot };
      try {
        await documents.set(key, document);
        await options.onWritten?.(key, utf8Length(JSON.stringify(document)));
      } catch (error) {
        report(error);
      }
    });

  const take = (key: string) => {
    const waiting = pending.get(key);
    if (!waiting) return undefined;
    waiting.timer.cancel();
    pending.delete(key);
    return waiting.current;
  };

  return {
    async read(key) {
      // A write under way lands first: a stream read back just after it was let go reads what it wrote.
      await chains.get(key);
      const value = await documents.get(key);
      if (!isRecord(value) || value["format"] !== FORMAT) return undefined;
      const sequence = value["sequence"];
      if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 0 || !("snapshot" in value)) return undefined;
      return { cursor: sequence, snapshot: value["snapshot"] };
    },
    soon(key, current) {
      const waiting = pending.get(key);
      if (waiting) {
        waiting.current = current;
        return;
      }
      const timer = clock.setTimeout(() => {
        const due = take(key);
        if (due) void write(key, due);
      }, STREAM_WRITE_DEBOUNCE_MS);
      pending.set(key, { timer, current });
    },
    now(key, current) {
      take(key);
      return write(key, current);
    },
    async flush(environmentId) {
      const prefix = environmentId === undefined ? undefined : streamDocument(environmentId, "");
      const due = [...pending.keys()].filter((key) => prefix === undefined || key.startsWith(prefix));
      await Promise.all(due.map((key) => write(key, take(key) as () => CachedPair | null)));
    },
    remove(key) {
      take(key);
      return serial(key, () => documents.delete(key));
    },
    async idle() {
      await Promise.all([...chains.values()]);
    },
  };
};

/** One session snapshot as retention counts it. */
interface Opened {
  readonly sessionId: string;
  readonly openedAt: string;
  readonly bytes: number;
}

interface Meta {
  readonly skewMs: number | null;
  /** Most recently opened first. */
  readonly opened: readonly Opened[];
}

const NO_META: Meta = { skewMs: null, opened: [] };

const readMeta = (value: unknown): Meta => {
  if (!isRecord(value) || value["format"] !== FORMAT) return NO_META;
  const skewMs = typeof value["skewMs"] === "number" && Number.isFinite(value["skewMs"]) ? value["skewMs"] : null;
  const opened = Array.isArray(value["opened"])
    ? value["opened"].filter(
        (entry): entry is Opened =>
          isRecord(entry) && typeof entry["sessionId"] === "string" && typeof entry["openedAt"] === "string" && typeof entry["bytes"] === "number",
      )
    : [];
  return { skewMs, opened };
};

export interface RetentionOptions {
  readonly documents: DocumentStore;
  readonly clock: Clock;
  readonly report: (error: unknown) => void;
  /** Whether a handle holds the session now (or its linger has not run out): such a snapshot is never evicted. */
  readonly held: (environmentId: string, sessionId: string) => boolean;
  /** Hears each session whose snapshot was evicted, to drop what it holds in memory. */
  readonly onEvicted?: (environmentId: string, sessionId: string) => void;
}

export interface Retention {
  /** Reads the environment's meta document, once. */
  load(environmentId: string): Promise<void>;
  /** The environment's clock skew as last measured: the environment's clock minus this client's, in milliseconds; null when never. */
  skew(environmentId: string): number | null;
  setSkew(environmentId: string, skewMs: number): Promise<void>;
  /** The sessions with a snapshot kept, most recently opened first. */
  sessions(environmentId: string): readonly string[];
  /** A handle opened the session: it is the most recent now. Evicts what falls outside the bounds. */
  opened(environmentId: string, sessionId: string): Promise<void>;
  /** The session's snapshot was written at `bytes`. Evicts what falls outside the bounds. */
  wrote(environmentId: string, sessionId: string, bytes: number): Promise<void>;
  /** The session is gone (deleted): its snapshot is dropped. */
  removed(environmentId: string, sessionId: string): Promise<void>;
  /** Deletes every document of the environment: its streams, its sessions and its meta. */
  forget(environmentId: string): Promise<void>;
}

export const createRetention = (options: RetentionOptions): Retention => {
  const { documents, clock, report } = options;
  const metas = new Map<string, Meta>();
  let writes: Promise<void> = Promise.resolve();

  const metaOf = (environmentId: string): Meta => metas.get(environmentId) ?? NO_META;

  /** Keeps `next` and writes it, one write after another. */
  const save = (environmentId: string, next: Meta): Promise<void> => {
    metas.set(environmentId, next);
    const work = async () => {
      try {
        const now = metaOf(environmentId);
        await documents.set(metaDocument(environmentId), { format: FORMAT, skewMs: now.skewMs, opened: now.opened });
      } catch (error) {
        report(error);
      }
    };
    writes = writes.then(work, work);
    return writes;
  };

  /** Drops the least recently opened snapshot while there are more than `RETAINED_SESSIONS` or they pass `RETAINED_BYTES`; a held one always stays. */
  const bounded = async (environmentId: string, meta: Meta): Promise<void> => {
    const kept = [...meta.opened];
    const evicted: Opened[] = [];
    let bytes = kept.reduce((sum, entry) => sum + entry.bytes, 0);
    for (let i = kept.length - 1; i >= 0 && (kept.length > RETAINED_SESSIONS || bytes > RETAINED_BYTES); i--) {
      const entry = kept[i] as Opened;
      if (options.held(environmentId, entry.sessionId)) continue;
      kept.splice(i, 1);
      evicted.push(entry);
      bytes -= entry.bytes;
    }
    await save(environmentId, { ...meta, opened: kept });
    for (const entry of evicted) {
      try {
        await documents.delete(streamDocument(environmentId, `session.${entry.sessionId}`));
      } catch (error) {
        report(error);
      }
      options.onEvicted?.(environmentId, entry.sessionId);
    }
  };

  return {
    async load(environmentId) {
      if (metas.has(environmentId)) return;
      const meta = readMeta(await documents.get(metaDocument(environmentId)));
      if (!metas.has(environmentId)) metas.set(environmentId, meta);
    },
    skew: (environmentId) => metaOf(environmentId).skewMs,
    setSkew: (environmentId, skewMs) => save(environmentId, { ...metaOf(environmentId), skewMs }),
    sessions: (environmentId) => metaOf(environmentId).opened.map((entry) => entry.sessionId),
    opened(environmentId, sessionId) {
      const meta = metaOf(environmentId);
      const before = meta.opened.find((entry) => entry.sessionId === sessionId);
      const entry: Opened = { sessionId, openedAt: clock.now().toISOString(), bytes: before?.bytes ?? 0 };
      return bounded(environmentId, { ...meta, opened: [entry, ...meta.opened.filter((e) => e.sessionId !== sessionId)] });
    },
    wrote(environmentId, sessionId, bytes) {
      const meta = metaOf(environmentId);
      // A snapshot written for a session not opened (a late write after an eviction) counts as the least recent.
      const known = meta.opened.some((entry) => entry.sessionId === sessionId);
      const opened = known
        ? meta.opened.map((entry) => (entry.sessionId === sessionId ? { ...entry, bytes } : entry))
        : [...meta.opened, { sessionId, openedAt: clock.now().toISOString(), bytes }];
      return bounded(environmentId, { ...meta, opened });
    },
    async removed(environmentId, sessionId) {
      const meta = metaOf(environmentId);
      await save(environmentId, { ...meta, opened: meta.opened.filter((entry) => entry.sessionId !== sessionId) });
      await documents.delete(streamDocument(environmentId, `session.${sessionId}`));
    },
    async forget(environmentId) {
      const meta = metaOf(environmentId);
      metas.delete(environmentId);
      await writes;
      const keys = [
        streamDocument(environmentId, "list"),
        streamDocument(environmentId, "environment"),
        ...meta.opened.map((entry) => streamDocument(environmentId, `session.${entry.sessionId}`)),
        metaDocument(environmentId),
      ];
      for (const key of keys) await documents.delete(key);
    },
  };
};
