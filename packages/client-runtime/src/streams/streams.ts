import { EnvironmentNotice, type HelloFrame } from "@agent-harness/contracts";
import type { ConnectionRecord } from "../connections/records.js";
import type { ConnectionSeams, RegistryCaches } from "../connections/registry.js";
import type { Notices } from "../notices.js";
import { writable, type Observable } from "../observable.js";
import type { Platform } from "../platform.js";
import { createAttacher, liveStream, type LiveStream } from "./attach.js";
import { createRetention, createStreamCache, streamDocument } from "./cache.js";
import { environmentKind, listKind, sessionKind, type EnvironmentData, type ListData, type SessionData } from "./kinds.js";
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
  /** What the registry reads before connections start, and asks at their start. */
  readonly caches: RegistryCaches;
  /** Each environment's session list stream, by environment id. */
  readonly lists: Observable<ReadonlyMap<string, StreamState<ListData>>>;
  session(environmentId: string, sessionId: string): SessionHandle;
  /** The environment's time now, as this client reckons it from `hello`. */
  now(environmentId: string): Date;
  /** Writes what is pending and lets go of every timer. */
  close(): Promise<void>;
}

export interface StreamsOptions {
  readonly platform: Platform;
  readonly seams: ConnectionSeams;
  readonly records: Observable<readonly ConnectionRecord[]>;
  readonly notices: Notices;
  readonly report: (error: unknown) => void;
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
  const { platform, seams, records, notices, report } = options;
  const { clock } = platform;
  const environments = new Map<string, EnvironmentStreams>();
  let closed = false;
  const lists = writable<ReadonlyMap<string, StreamState<ListData>>>(new Map(), report);

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
  const skew = createSkew(clock, retention);

  const attacher = createAttacher({
    clock,
    random: platform.random ?? Math.random,
    report,
    seams,
    cache,
    ready: (environmentId) => environments.get(environmentId)?.ready === true,
    wanted,
    changed(stream) {
      if (!stream.list) return;
      const state = stream.value.read() as StreamState<ListData>;
      lists.update((current) => new Map(current).set(stream.environmentId, state));
    },
    applied(stream, event, news) {
      // Every start appends `environment.started`, so a replay onto an empty cache holds older updates after one: only news is told.
      if (stream.name !== "environment" || !news) return;
      const notice = EnvironmentNotice.safeParse(event);
      if (!notice.success || notice.data.type !== "environment.updated") return;
      const name = records.read().find((record) => record.environmentId === stream.environmentId)?.descriptor.name ?? "The environment";
      const { fromVersion, toVersion } = notice.data.payload;
      notices.raise(stream.environmentId, { kind: "updated", message: `${name} was updated from ${fromVersion} to ${toVersion}.`, action: null });
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

  /** Puts what the cache holds for `stream` in it, unless it holds something already. */
  const restore = async <D>(stream: LiveStream<D>): Promise<void> => {
    try {
      const pair = await cache.read(stream.key);
      if (!pair || stream.value.read().cursor !== null || stream.attachment !== null) return;
      stream.value.set(cachedStream(pair.cursor, stream.kind.decode(pair.snapshot)));
      if (stream.list) lists.update((current) => new Map(current).set(stream.environmentId, stream.value.read() as StreamState<ListData>));
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
      if (streams.ready && environments.get(stream.environmentId) === streams && wanted(stream) && stream.attachment === null && stream.retry === null) {
        attacher.attach(stream);
      }
    });

  const onReady = (environmentId: string, hello: HelloFrame) => {
    const streams = ensure(environmentId);
    // Read first: an environment forgotten and paired again keeps the skew it measures now.
    const loaded = load(environmentId);
    skew.record(environmentId, hello.serverTime);
    streams.ready = true;
    // Syncing from now, so the connection is never seen ready before its list has caught up.
    seams.setSyncing(environmentId, true);
    void loaded.then(() => {
      if (!streams.ready || environments.get(environmentId) !== streams) return;
      for (const stream of [streams.list, streams.environment] as LiveStream<unknown>[]) {
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
    await retention.load(environmentId);
    const streams = environments.get(environmentId);
    environments.delete(environmentId);
    if (streams) {
      const all = [streams.list, streams.environment, ...[...streams.sessions.values()].map((s) => s.stream)] as LiveStream<unknown>[];
      for (const session of streams.sessions.values()) {
        session.linger?.cancel();
        session.gone = true;
      }
      for (const stream of all) attacher.drop(stream);
      await Promise.all(all.map((stream) => cache.remove(stream.key)));
      lists.update((current) => {
        const next = new Map(current);
        next.delete(environmentId);
        return next;
      });
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
    session: (environmentId, sessionId) => handles.open(environmentId, sessionId),
    now: (environmentId) => skew.now(environmentId),
    async close() {
      closed = true;
      handles.close();
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
