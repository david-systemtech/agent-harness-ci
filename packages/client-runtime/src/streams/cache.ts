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
  /** Drops every pending write under `streams.<environmentId>.` and settles once the writes under way there have: the environment is being forgotten. */
  settle(environmentId: string): Promise<void>;
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
    async settle(environmentId) {
      const prefix = streamDocument(environmentId, "");
      for (const key of [...pending.keys()]) if (key.startsWith(prefix)) take(key);
      await Promise.all([...chains].filter(([key]) => key.startsWith(prefix)).map(([, chain]) => chain));
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

/** The meta as stored: none when there is no document; undefined when there is one this build does not read (another format, or damaged). */
const readMeta = (value: unknown): Meta | undefined => {
  if (value === undefined) return NO_META;
  if (!isRecord(value) || value["format"] !== FORMAT) return undefined;
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
  /** Reads the environment's meta document, once it is read successfully; a read that failed is tried again by the next call. */
  load(environmentId: string): Promise<void>;
  /** The environment's clock skew as last measured: the environment's clock minus this client's, in milliseconds; null when never. */
  skew(environmentId: string): number | null;
  /** Holds the skew at once, and writes it once the meta document is read. */
  setSkew(environmentId: string, skewMs: number): Promise<void>;
  /** The sessions with a snapshot kept, most recently opened first. */
  sessions(environmentId: string): readonly string[];
  /** A handle opened the session: it is the most recent now. Evicts what falls outside the bounds. */
  opened(environmentId: string, sessionId: string): Promise<void>;
  /** The session's snapshot was written at `bytes`. Evicts what falls outside the bounds. */
  wrote(environmentId: string, sessionId: string, bytes: number): Promise<void>;
  /** The session is gone (deleted): its snapshot is dropped. */
  removed(environmentId: string, sessionId: string): Promise<void>;
  /** Deletes every document of the environment the meta names: its streams, its sessions, and the meta last; a meta it could not read (failed, or foreign) is left in place. */
  forget(environmentId: string): Promise<void>;
}

/**
 * Retention's writes keep the meta document from ever naming less than is
 * stored: a snapshot is deleted before the meta that stops counting it is
 * written, so a crash or a failed delete between the two leaves a meta that
 * still counts it (evicted again later, forgotten with the environment),
 * never a document nothing counts. The meta is written only once it has
 * been read, so a read that failed never has an empty index saved over the
 * stored one. Every change runs one after another and reads the meta as the
 * change before it left it.
 *
 * Document storage cannot list its keys, so `forget` deletes what the meta
 * names. What that misses is a session snapshot written after its meta entry
 * was dropped and before the write that counts it again (`wrote` re-adds
 * one it does not know) was saved: the process ending in that window leaves
 * the document behind. A handle records the session opened before its
 * stream is ever written, so the window is a late write racing an eviction.
 */
export const createRetention = (options: RetentionOptions): Retention => {
  const { documents, clock, report } = options;
  const metas = new Map<string, Meta>();
  const loads = new Map<string, Promise<void>>();
  /** Skews measured this run: they hold at once, before the meta is read or written. */
  const skews = new Map<string, number>();
  /** Environments forgotten and not loaded since: a change queued for one writes nothing. */
  const forgotten = new Set<string>();
  /**
   * Environments whose meta is a document this build does not read: held as
   * empty, and never written, so the stored index (a newer build's) is kept
   * as it is. Their snapshots are not counted or evicted this run.
   */
  const foreign = new Set<string>();
  let changes: Promise<void> = Promise.resolve();

  const load = (environmentId: string): Promise<void> => {
    let loading = loads.get(environmentId);
    if (!loading) {
      loading = documents.get(metaDocument(environmentId)).then(
        (value) => {
          if (metas.has(environmentId)) return;
          const meta = readMeta(value);
          if (meta === undefined) {
            foreign.add(environmentId);
            report(new Error(`The cache's retention index for environment ${environmentId} is in a form this build does not read; it is left as it is.`));
          }
          metas.set(environmentId, meta ?? NO_META);
        },
        (error: unknown) => {
          loads.delete(environmentId);
          throw error;
        },
      );
      loads.set(environmentId, loading);
    }
    return loading;
  };

  const write = (environmentId: string, meta: Meta): Promise<void> =>
    documents.set(metaDocument(environmentId), { format: FORMAT, skewMs: meta.skewMs, opened: meta.opened });

  /**
   * Runs `work` on the environment's meta once every change before it has
   * run and the meta has been read, and keeps and writes what it answers.
   * A meta that cannot be read is never written.
   */
  const change = (environmentId: string, work: (meta: Meta) => Promise<Meta>): Promise<void> => {
    const run = async () => {
      if (forgotten.has(environmentId)) return;
      try {
        await load(environmentId);
        const meta = metas.get(environmentId);
        if (!meta || forgotten.has(environmentId) || foreign.has(environmentId)) return;
        const next = await work(meta);
        if (forgotten.has(environmentId)) return;
        metas.set(environmentId, next);
        await write(environmentId, next);
      } catch (error) {
        report(error);
      }
    };
    changes = changes.then(run, run);
    return changes;
  };

  /**
   * Evicts the least recently opened snapshot while there are more than
   * `RETAINED_SESSIONS` or they pass `RETAINED_BYTES`, a held one never:
   * each document is deleted before the meta stops counting it, and one
   * whose delete failed stays counted (to be evicted again) while the next
   * least recent goes in its place.
   */
  const bounded = async (environmentId: string, meta: Meta): Promise<Meta> => {
    const kept = [...meta.opened];
    const gone: string[] = [];
    let bytes = kept.reduce((sum, entry) => sum + entry.bytes, 0);
    for (let i = kept.length - 1; i >= 0 && (kept.length > RETAINED_SESSIONS || bytes > RETAINED_BYTES); i--) {
      const entry = kept[i] as Opened;
      if (options.held(environmentId, entry.sessionId)) continue;
      try {
        await documents.delete(streamDocument(environmentId, `session.${entry.sessionId}`));
      } catch (error) {
        report(error);
        continue;
      }
      kept.splice(i, 1);
      gone.push(entry.sessionId);
      bytes -= entry.bytes;
    }
    for (const sessionId of gone) options.onEvicted?.(environmentId, sessionId);
    return { ...meta, opened: kept };
  };

  return {
    async load(environmentId) {
      forgotten.delete(environmentId);
      await load(environmentId);
    },
    skew: (environmentId) => skews.get(environmentId) ?? metas.get(environmentId)?.skewMs ?? null,
    setSkew(environmentId, skewMs) {
      skews.set(environmentId, skewMs);
      return change(environmentId, async (meta) => ({ ...meta, skewMs }));
    },
    sessions: (environmentId) => (metas.get(environmentId) ?? NO_META).opened.map((entry) => entry.sessionId),
    opened: (environmentId, sessionId) =>
      change(environmentId, (meta) => {
        const before = meta.opened.find((entry) => entry.sessionId === sessionId);
        const entry: Opened = { sessionId, openedAt: clock.now().toISOString(), bytes: before?.bytes ?? 0 };
        return bounded(environmentId, { ...meta, opened: [entry, ...meta.opened.filter((e) => e.sessionId !== sessionId)] });
      }),
    wrote: (environmentId, sessionId, bytes) =>
      change(environmentId, (meta) => {
        // A snapshot written for a session not opened (a late write after an eviction) counts as the least recent.
        const known = meta.opened.some((entry) => entry.sessionId === sessionId);
        const opened = known
          ? meta.opened.map((entry) => (entry.sessionId === sessionId ? { ...entry, bytes } : entry))
          : [...meta.opened, { sessionId, openedAt: clock.now().toISOString(), bytes }];
        return bounded(environmentId, { ...meta, opened });
      }),
    removed: (environmentId, sessionId) =>
      change(environmentId, async (meta) => {
        await documents.delete(streamDocument(environmentId, `session.${sessionId}`));
        return { ...meta, opened: meta.opened.filter((entry) => entry.sessionId !== sessionId) };
      }),
    forget(environmentId) {
      const run = async () => {
        let read = true;
        try {
          await load(environmentId);
        } catch (error) {
          report(error);
          read = false;
        }
        // A meta not read (its read failed, or it is in a form this build does not read) names snapshots this build cannot know: it is
        // left in place, still naming them for a build that reads it, and only the streams are deleted.
        const kept = !read || foreign.has(environmentId);
        const meta = metas.get(environmentId) ?? NO_META;
        forgotten.add(environmentId);
        metas.delete(environmentId);
        loads.delete(environmentId);
        skews.delete(environmentId);
        foreign.delete(environmentId);
        const keys = [
          streamDocument(environmentId, "list"),
          streamDocument(environmentId, "environment"),
          ...meta.opened.map((entry) => streamDocument(environmentId, `session.${entry.sessionId}`)),
        ];
        for (const key of keys) await documents.delete(key);
        // Last, so a forget cut off part way leaves a meta naming what is left.
        if (!kept) await documents.delete(metaDocument(environmentId));
      };
      const forgetting = changes.then(run, run);
      changes = forgetting.catch(() => undefined);
      return forgetting;
    },
  };
};
