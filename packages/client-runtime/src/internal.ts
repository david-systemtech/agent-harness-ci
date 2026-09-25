import { PROTOCOL_VERSION } from "@agent-harness/contracts";
import { answerCapability } from "./capabilities.js";
import { createRegistry, type ConnectionSeams, type RegistryCaches } from "./connections/registry.js";
import { createNotices } from "./notices.js";
import { derived } from "./observable.js";
import { createDrafts } from "./outbox/drafts.js";
import { createOutbox, type Outbox } from "./outbox/outbox.js";
import { overlaidLists, pendingTargets } from "./outbox/overlay.js";
import type { Platform } from "./platform.js";
import { environmentsProjection } from "./projections/environments.js";
import { createRequestCache, createRequests, type Requests } from "./requests.js";
import { searchProjection } from "./projections/search.js";
import { sessionListProjection } from "./projections/session-list.js";
import type { Runtime } from "./runtime.js";
import { createStreams, type Streams } from "./streams/streams.js";

/**
 * The runtime together with its internal seams: raw frames, socket closes,
 * a socket becoming ready, forgetting, requests and subscriptions on a
 * connection's socket, and the `syncing` phase. Subscriptions (#127,
 * `streams/`) and the outbox (#128, `outbox/`) attach here, inside the
 * package; renderers never do (ADR 0004). This module is not exported from the
 * package, so a renderer cannot import it.
 */
export interface RuntimeWithSeams {
  readonly runtime: Runtime;
  readonly seams: ConnectionSeams;
}

export interface InternalOptions {
  /** The protocol version the runtime speaks: `PROTOCOL_VERSION`; a test names another to be the newer side of a mismatch. */
  readonly protocolVersion?: number;
}

export const createRuntimeWithSeams = (platform: Platform, options: InternalOptions = {}): RuntimeWithSeams => {
  const notices = createNotices(platform.clock);
  const report = (error: unknown): void => (platform.reportError ? platform.reportError(error) : void Promise.reject(error));
  // The registry reads the cache before connections start; the streams attach to the registry's seams, so they are made after it
  // and the registry reaches them only once it runs.
  const caches: RegistryCaches = {
    // The outbox is read with the cache, before any connection starts, so what waits in it is sent on the first ready.
    load: async (environmentIds) => {
      await Promise.all([made.caches.load(environmentIds), outbox.load(environmentIds)]);
    },
    has: (environmentId) => made.caches.has(environmentId),
  };
  const registry = createRegistry(platform, options.protocolVersion ?? PROTOCOL_VERSION, notices, caches);
  const made: Streams = createStreams({
    platform,
    seams: registry.seams,
    records: registry.list,
    notices,
    report,
    applied(environmentId, stream, event, news) {
      if (stream === "list") outbox.applied(environmentId, event);
      // A notice replayed onto a stream that held nothing is history: every ready fetches the cache again anyway.
      if (stream === "environment" && news) requestCache.noticed(environmentId, event.type);
    },
  });
  const outbox: Outbox = createOutbox({
    clock: platform.clock,
    documents: platform.documents,
    seams: registry.seams,
    records: registry.list,
    record: (environmentId) => registry.record(environmentId),
    notices,
    report,
    lists: made.lists,
    shown: (environmentId) => lists.read().get(environmentId)?.data ?? null,
    now: (environmentId) => made.now(environmentId),
  });
  const drafts = createDrafts({
    clock: platform.clock,
    dispatch: (environmentId, sessionId, draft) => void outbox.dispatch(environmentId, "sessions.setDraft", { sessionId, draft }),
    report,
  });
  registry.seams.onForget((environmentId) => drafts.forget(environmentId));
  // The overlay sits between the streams' lists and the projections: what a renderer reads is the confirmed list with every
  // command still on its way laid over it.
  const lists = derived([made.lists, outbox.view, drafts.waiting] as const, overlaidLists);
  const environments = environmentsProjection(registry.list, outbox.view);
  const sessionList = sessionListProjection({
    records: registry.list,
    lists,
    now: (environmentId) => made.now(environmentId),
    clock: platform.clock,
    pending: derived([registry.list, outbox.view] as const, pendingTargets),
  });
  let closing: Promise<void> | undefined;
  let started: Promise<void> | undefined;
  const capability: Runtime["capability"] = (environmentId, name) => answerCapability(name, registry.record(environmentId), platform.shell);
  const { call } = createRequests({ clock: platform.clock, capability, request: registry.seams.request });
  const requestCache = createRequestCache({ clock: platform.clock, call, records: registry.list, report });
  registry.seams.onForget((environmentId) => requestCache.forget(environmentId));
  const requests: Requests = { call, cached: (environmentId, method, params) => requestCache.cached(environmentId, method, params) };

  const runtime: Runtime = {
    // A start that failed is not kept: the next call starts again.
    start: () =>
      (started ??= registry.start().catch((error: unknown) => {
        started = undefined;
        throw error;
      })),
    local: registry.local,
    connections: {
      list: registry.list,
      add: (input, pairing) => registry.add(input, pairing),
      setAddress: (environmentId, address) => registry.setAddress(environmentId, address),
      setEnabled: (environmentId, enabled) => registry.setEnabled(environmentId, enabled),
      setOrder: (environmentIds) => registry.setOrder(environmentIds),
      setLastUsed: (environmentId) => registry.setLastUsed(environmentId),
      remove: (environmentId) => registry.remove(environmentId),
      retryNow: (environmentId) => registry.retryNow(environmentId),
      startService: (environmentId) => registry.startService(environmentId),
    },
    preferences: registry.preferences,
    projections: {
      environments,
      notices: notices.list,
      sessionList: sessionList.view,
      search: (query) => searchProjection(sessionList.view, query),
    },
    subscriptions: { session: (environmentId, sessionId) => made.session(environmentId, sessionId) },
    commands: {
      dispatch: (environmentId, method, params) => outbox.dispatch(environmentId, method, params),
      moveToGroup: (environmentId, sessionId, groupName) => outbox.moveToGroup(environmentId, sessionId, groupName),
    },
    drafts: {
      set: (environmentId, sessionId, draft) => drafts.set(environmentId, sessionId, draft),
      flush: () => drafts.flush(),
    },
    notices: { dismiss: (id) => notices.dismiss(id) },
    environmentNow: (environmentId) => made.now(environmentId),
    requests,
    capability,
    close() {
      closing ??= (async () => {
        registry.close();
        // A draft still waiting its second is dispatched, so the outbox keeps it for the next start.
        drafts.close();
        await outbox.close();
        sessionList.stop();
        requestCache.close();
        await made.close();
      })();
      return closing;
    },
  };
  return { runtime, seams: registry.seams };
};
