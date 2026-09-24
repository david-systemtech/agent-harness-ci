import { PROTOCOL_VERSION } from "@agent-harness/contracts";
import { answerCapability } from "./capabilities.js";
import { createRegistry, type ConnectionSeams, type RegistryCaches } from "./connections/registry.js";
import { createNotices } from "./notices.js";
import type { Platform } from "./platform.js";
import { environmentsProjection } from "./projections/environments.js";
import { searchProjection } from "./projections/search.js";
import { sessionListProjection } from "./projections/session-list.js";
import type { Runtime } from "./runtime.js";
import { createStreams, type Streams } from "./streams/streams.js";

/**
 * The runtime together with its internal seams: raw frames, socket closes,
 * a socket becoming ready, forgetting, requests and subscriptions on a
 * connection's socket, and the `syncing` phase. Subscriptions (#127,
 * `streams/`) attach here, and the outbox (#128) will, inside the package;
 * renderers never do (ADR 0004). This module is not exported from the
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
    load: (environmentIds) => made.caches.load(environmentIds),
    has: (environmentId) => made.caches.has(environmentId),
  };
  const registry = createRegistry(platform, options.protocolVersion ?? PROTOCOL_VERSION, notices, caches);
  const made: Streams = createStreams({ platform, seams: registry.seams, records: registry.list, notices, report });
  const environments = environmentsProjection(registry.list);
  const sessionList = sessionListProjection({
    records: registry.list,
    lists: made.lists,
    now: (environmentId) => made.now(environmentId),
    clock: platform.clock,
    // The outbox's seam (#128): no command waits in one yet.
    pending: () => false,
  });
  let closing: Promise<void> | undefined;
  let started: Promise<void> | undefined;

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
    notices: { dismiss: (id) => notices.dismiss(id) },
    environmentNow: (environmentId) => made.now(environmentId),
    capability: (environmentId, name) => answerCapability(name, registry.record(environmentId), platform.shell),
    close() {
      closing ??= (async () => {
        registry.close();
        sessionList.stop();
        await made.close();
      })();
      return closing;
    },
  };
  return { runtime, seams: registry.seams };
};
