import type { EventEnvelope, HelloFrame } from "@agent-harness/contracts";
import type { ConnectionRecord } from "../connections/records.js";
import type { ConnectionSeams, RegistryCaches } from "../connections/registry.js";
import { writable, type Observable } from "../observable.js";
import type { Platform } from "../platform.js";
import { createAttacher, liveStream, type LiveStream } from "./attach.js";
import { createRetention, createStreamCache, streamDocument } from "./cache.js";
import { ENVIRONMENT_LOOK_NOTICES, environmentKind, listKind, sessionKind, type EnvironmentData, type ListData, type SessionData } from "./kinds.js";
import { createSessionHandles, sessionView, type HeldSession, type SessionHandle } from "./session-handles.js";
import { createSkew } from "./skew.js";
import { cachedStream, type StreamState } from "./stream.js";

/**
 * The runtime's subscriptions (docs/specs/client-runtime.md, "Subscriptions,
 * cursor cache and snapshots"): per environment, the session list and the
 * environment's own stream while its connection is enabled, and one stream
 * per session a handle holds. It reads the cache before any connection
 * starts, so the list renders from it at once (`cached`) and an environment
 * with something cached is unreachable from the start until reached; on each
 * `ready` it measures the environment's clock from `hello` and attaches
 * every stream from its cursor (`catching-up`, then `live`); when the
 * connection leaves `ready` every stream is let go and written at once
 * (`cached`). Removing an environment forgets everything cached for it.
 */

export interface Streams {
  checkpoint(): Promise<void>;
  /** What the registry reads before connections start, and asks at their start. */
  readonly caches: RegistryCaches;
  /** Each environment's session list stream, by environment id. */
  readonly lists: Observable<ReadonlyMap<string, StreamState<ListData>>>;
  /** Each environment's own stream, by environment id: its status and its Set up results (#570). */
  readonly environments: Observable<ReadonlyMap<string, StreamState<EnvironmentData>>>;
  session(environmentId: string, sessionId: string): SessionHandle;
  /**
   * Holds a session as a handle does and hands its stream's state, for
   * `projections.session` (#142) to reduce: the stream itself stays inside
   * the package (ADR 0004).
   */
  lease(environmentId: string, sessionId: string): SessionLease;
  /** The session's stream state while the runtime holds it (a handle, a lease, or the five minutes after); null otherwise. Holds nothing. */
  peek(environmentId: string, sessionId: string): StreamState<SessionData> | null;
  /** The environment's time now, as this client reckons it from `hello`. */
  now(environmentId: string): Date;
  /** Writes what is pending and lets go of every timer. */
  close(): Promise<void>;
}

/** A session held for its stream's state: released as a handle is. */
export interface SessionLease {
  readonly state: Observable<StreamState<SessionData>>;
  release(): void;
}

export interface StreamsOptions {
  readonly platform: Platform;
  readonly seams: ConnectionSeams;
  readonly records: Observable<readonly ConnectionRecord[]>;
  readonly report: (error: unknown) => void;
  /**
   * An event applied to one of an environment's streams (`list`,
   * `environment`, or `session.<id>`), and whether it is news (see
   * `AttachOptions.applied`): the outbox retires the overlay of the command
   * a list event names, the request cache refreshes on a notice, and the
   * projections hear what the list and the environment's notices carry
   * (#142: run states, parked asks, notices, attention, client calls).
   */
  readonly applied?: (environmentId: string, stream: string, event: EventEnvelope, news: boolean) => void;
  /** Authoritative environment status received in a snapshot, never a cached status. */
  readonly environmentSnapshotted?: (environmentId: string, status: EnvironmentData["status"]) => void;
}

/** One environment's streams. */
interface EnvironmentStreams {
  readonly list: LiveStream<ListData>;
  readonly environment: LiveStream<EnvironmentData>;
  readonly sessions: Map<string, HeldSession>;
  /** Its connection has a ready socket, as far as the streams know. */
  ready: boolean;
  loaded: Promise<void> | undefined;
}

const SESSION_DOCUMENT = /^streams\.(.+)\.session\.([^.]+)$/;

export const createStreams = (options: StreamsOptions): Streams => {
  const { platform, seams, records, report } = options;
  const { clock } = platform;
  const environments = new Map<string, EnvironmentStreams>();
  let closed = false;
  const lists = writable<ReadonlyMap<string, StreamState<ListData>>>(new Map(), report);
  const environmentStates = writable<ReadonlyMap<string, StreamState<EnvironmentData>>>(new Map(), report);
  /** Publishes the state of `stream` when it is an environment's list or own stream, which projections read across environments. */
  const published = (stream: LiveStream<unknown>): void => {
    if (stream.list) {
      const state = stream.value.read() as StreamState<ListData>;
      lists.update((current) => new Map(current).set(stream.environmentId, state));
    } else if (stream.name === "environment") {
      const state = stream.value.read() as StreamState<EnvironmentData>;
      environmentStates.update((current) => new Map(current).set(stream.environmentId, state));
    }
  };

  const held = (environmentId: string, sessionId: string): HeldSession | undefined => environments.get(environmentId)?.sessions.get(sessionId);
  const wanted = (stream: LiveStream<unknown>): boolean => {
    if (!stream.name.startsWith("session.")) return true;
    const session = held(stream.environmentId, stream.name.slice("session.".length));
    return session !== undefined && session.stream === stream && !session.gone && (session.holders > 0 || session.linger !== null);
  };

  const retention = createRetention({
    documents: platform.documents,
    clock,
    report,
    held: (environmentId, sessionId) => {
      const session = held(environmentId, sessionId);
      return session !== undefined && wanted(session.stream as LiveStream<unknown>);
    },
    onEvicted: (environmentId, sessionId) => {
      const session = held(environmentId, sessionId);
      if (session && !wanted(session.stream as LiveStream<unknown>)) environments.get(environmentId)?.sessions.delete(sessionId);
    },
  });
  const cache = createStreamCache({
    documents: platform.documents,
    clock,
    report,
    onWritten(key, bytes) {
      const session = SESSION_DOCUMENT.exec(key);
      if (session) return retention.wrote(session[1] as string, session[2] as string, bytes);
    },
  });
  const skew = createSkew(clock, retention, report);

  const attacher = createAttacher({
    clock,
    random: platform.random ?? Math.random,
    report,
    seams,
    cache,
    ready: (environmentId) => environments.get(environmentId)?.ready === true,
    wanted,
    changed: published,
    // What an event means beyond its stream (the notices it raises, the caches it refreshes) is the runtime's composition's (`internal.ts`).
    applied(stream, event, news) {
      if (ENVIRONMENT_LOOK_NOTICES.has(event.type)) describe(stream);
      options.applied?.(stream.environmentId, stream.name, event, news);
    },
    snapshotted(stream) {
      describe(stream);
      if (stream.name === "environment") {
        options.environmentSnapshotted?.(stream.environmentId, (stream.value.read() as StreamState<EnvironmentData>).data?.status ?? null);
      }
    },
    ended(stream) {
      const sessionId = stream.name.slice("session.".length);
      const session = held(stream.environmentId, sessionId);
      if (!session || session.stream !== stream) return;
      session.gone = true;
      // After the write the end asked for, in the document's own order, so the deleted session's snapshot does not come back.
      void cache
        .remove(stream.key)
        .then(() => retention.removed(stream.environmentId, sessionId))
        .catch(report);
    },
  });

  /**
   * The connection descriptor takes the environment's name, icon and colour
   * as its own stream says them now (#323), after a snapshot or one of their
   * notices: never from the cache, which `hello` is newer than. A replay
   * moves it through each value in turn to where the environment stands.
   */
  const describe = (stream: LiveStream<unknown>): void => {
    if (stream.name !== "environment") return;
    const look = (stream.value.read() as StreamState<EnvironmentData>).data?.look;
    if (look !== undefined && Object.keys(look).length > 0) seams.describe(stream.environmentId, look);
  };

  /** Puts what the cache holds for `stream` in it, unless it holds something already. */
  const restore = async <D>(stream: LiveStream<D>): Promise<void> => {
    try {
      const pair = await cache.read(stream.key);
      if (!pair || stream.value.read().cursor !== null || stream.attachment !== null) return;
      stream.value.set(cachedStream(pair.cursor, stream.kind.decode(pair.snapshot)));
      published(stream as LiveStream<unknown>);
    } catch (error) {
      // A cache this build cannot read is no cache.
      report(error);
    }
  };

  const ensure = (environmentId: string): EnvironmentStreams => {
    let streams = environments.get(environmentId);
    if (!streams) {
      streams = {
        list: liveStream(
          { environmentId, name: "list", key: streamDocument(environmentId, "list"), kind: listKind(), method: "sessions.subscribe", params: {}, list: true },
          report,
        ),
        environment: liveStream(
          {
            environmentId,
            name: "environment",
            key: streamDocument(environmentId, "environment"),
            kind: environmentKind(),
            method: "environment.subscribe",
            params: {},
            list: false,
          },
          report,
        ),
        sessions: new Map(),
        ready: false,
        loaded: undefined,
      };
      environments.set(environmentId, streams);
    }
    return streams;
  };

  const load = (environmentId: string): Promise<void> => {
    const streams = ensure(environmentId);
    return (streams.loaded ??= (async () => {
      // A meta that cannot be read leaves retention unwritten (it tries again), not the streams uncached.
      await retention.load(environmentId).catch(report);
      await Promise.all([restore(streams.list), restore(streams.environment)]);
    })().catch(report));
  };

  /** Subscribes a held session once its cache is read, if it is still wanted and its environment still ready. */
  const attachSession = (streams: EnvironmentStreams, session: HeldSession) =>
    void session.loaded.then(() => {
      const stream = session.stream as LiveStream<unknown>;
      // A runtime closed while the cache was read attaches nothing.
      const current = !closed && streams.ready && environments.get(stream.environmentId) === streams;
      if (current && wanted(stream) && stream.attachment === null && stream.retry === null) attacher.attach(stream);
    });

  const onReady = (environmentId: string, hello: HelloFrame) => {
    const streams = ensure(environmentId);
    // The meta's read starts first, which also marks an environment forgotten and paired again as known, so the skew measured now
    // is kept. `skew.record` need not wait for the read: retention holds the skew in memory at once and writes it only once the
    // meta has been read (`change` in cache.ts), so it is neither lost nor written over an unread index.
    const loaded = load(environmentId);
    skew.record(environmentId, hello.serverTime);
    streams.ready = true;
    // Syncing from now, so the connection is never seen ready before its list has caught up.
    seams.setSyncing(environmentId, true);
    void loaded.then(() => {
      if (closed || !streams.ready || environments.get(environmentId) !== streams) return;
      for (const stream of [streams.list, streams.environment] as LiveStream<unknown>[]) {
        // A new socket: whatever the stream was subscribed on is gone, so it is let go without an `unsubscribe` sent on this one.
        if (stream.attachment !== null || stream.retry !== null) attacher.drop(stream);
        stream.recovering = false;
        stream.trimming = false;
        attacher.attach(stream);
      }
      for (const session of streams.sessions.values()) {
        // A new socket: whatever the session was subscribed on is gone, whether or not a phase in between said so.
        if (session.stream.attachment !== null || session.stream.retry !== null) attacher.drop(session.stream);
        session.stream.recovering = false;
        session.stream.trimming = false;
        if (!session.gone) attachSession(streams, session);
      }
    });
  };

  const detachAll = (streams: EnvironmentStreams) => {
    for (const stream of [streams.list, streams.environment, ...[...streams.sessions.values()].map((s) => s.stream)] as LiveStream<unknown>[]) {
      const freshness = stream.value.read().freshness;
      if (stream.attachment !== null || stream.retry !== null || freshness === "catching-up" || freshness === "live") attacher.detach(stream);
    }
  };

  const stopReady = seams.onReady(onReady);
  const stopRecords = records.subscribe((list) => {
    for (const [environmentId, streams] of environments) {
      const record = list.find((r) => r.environmentId === environmentId);
      const up = record !== undefined && (record.phase === "ready" || record.phase === "syncing");
      if (!up && streams.ready) {
        streams.ready = false;
        detachAll(streams);
      }
    }
  });

  const stopForget = seams.onForget(async (environmentId) => {
    // A meta that cannot be read stops nothing: the streams are let go and deleted all the same, and `retention.forget` keeps that meta.
    await retention.load(environmentId).catch(report);
    const streams = environments.get(environmentId);
    environments.delete(environmentId);
    if (streams) {
      const all = [streams.list, streams.environment, ...[...streams.sessions.values()].map((s) => s.stream)] as LiveStream<unknown>[];
      for (const session of streams.sessions.values()) {
        session.linger?.cancel();
        session.gone = true;
      }
      for (const stream of all) attacher.drop(stream);
      // A delete that fails is reported and the forget goes on: the in-memory entry is gone already, so nothing would retry it.
      await Promise.all(all.map((stream) => cache.remove(stream.key).catch(report)));
      // A write of a stream no longer held (a session let go, evicted or ended) may still be under way: it lands before the forget, not after.
      await cache.settle(environmentId);
      const without = <T>(current: ReadonlyMap<string, T>): ReadonlyMap<string, T> => {
        const next = new Map(current);
        next.delete(environmentId);
        return next;
      };
      lists.update(without);
      environmentStates.update(without);
    }
    await retention.forget(environmentId);
  });

  const handles = createSessionHandles({
    clock,
    hold(environmentId, sessionId) {
      const streams = ensure(environmentId);
      let session = streams.sessions.get(sessionId);
      if (!session) {
        const stream = liveStream<SessionData>(
          {
            environmentId,
            name: `session.${sessionId}`,
            key: streamDocument(environmentId, `session.${sessionId}`),
            kind: sessionKind(),
            method: "sessions.subscribeSession",
            params: { sessionId },
            list: false,
          },
          report,
        );
        session = { stream, holders: 0, linger: null, gone: false, loaded: restore(stream), view: sessionView(stream) };
        streams.sessions.set(sessionId, session);
      }
      return session;
    },
    opened(environmentId, sessionId, session) {
      void retention.opened(environmentId, sessionId).catch(report);
      const streams = ensure(environmentId);
      if (!session.gone) attachSession(streams, session);
    },
    expired(environmentId, sessionId, session) {
      const streams = environments.get(environmentId);
      const current = streams?.sessions.get(sessionId) === session;
      // A session gone, forgotten with its environment, or outliving the runtime is let go with nothing written.
      if (!current || session.gone || closed) attacher.drop(session.stream);
      else attacher.release(session.stream);
      if (current) streams?.sessions.delete(sessionId);
    },
  });

  return {
    caches: {
      load: async (environmentIds) => {
        await Promise.all(environmentIds.map(load));
      },
      has: (environmentId) => (environments.get(environmentId)?.list.value.read().cursor ?? null) !== null,
    },
    lists,
    environments: environmentStates,
    session: (environmentId, sessionId) => handles.open(environmentId, sessionId),
    lease(environmentId, sessionId) {
      const handle = handles.open(environmentId, sessionId);
      const session = held(environmentId, handle.sessionId) as HeldSession;
      return { state: session.stream.value, release: () => handle.release() };
    },
    // Held sessions are keyed by the lowercased id `handles.open` holds them under, which also names their streams (`session.<id>`).
    peek: (environmentId, sessionId) => held(environmentId, sessionId.toLowerCase())?.stream.value.read() ?? null,
    now: (environmentId) => skew.now(environmentId),
    async checkpoint() { await cache.flush(); await cache.idle(); },
    async close() {
      closed = true;
      handles.close();
      // Nothing is ready any more: an attach scheduled before the close (a cache read in flight) finds nothing to attach to.
      for (const streams of environments.values()) streams.ready = false;
      stopReady();
      stopRecords();
      stopForget();
      for (const streams of environments.values()) {
        for (const session of streams.sessions.values()) session.linger?.cancel();
        for (const stream of [streams.list, streams.environment, ...[...streams.sessions.values()].map((s) => s.stream)] as LiveStream<unknown>[]) {
          attacher.drop(stream);
        }
      }
      await cache.flush();
      await cache.idle();
    },
  };
};
