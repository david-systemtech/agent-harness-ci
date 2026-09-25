import { PROTOCOL_VERSION, type PromptKind, type RunEndedPayload } from "@agent-harness/contracts";
import { answerCapability } from "./capabilities.js";
import { LOCAL_PLACEHOLDER_ID } from "./connections/records.js";
import { createRegistry, type ConnectionSeams, type RegistryCaches } from "./connections/registry.js";
import { createNotices } from "./notices.js";
import { derived, type Observable } from "./observable.js";
import { createDrafts } from "./outbox/drafts.js";
import { createOutbox, type Outbox } from "./outbox/outbox.js";
import { overlaidLists, pendingTargets } from "./outbox/overlay.js";
import type { Platform } from "./platform.js";
import { answerOf, usageProjection, type AccountsAnswer, type ModelsAnswer } from "./projections/accounts.js";
import { createAttention } from "./projections/attention.js";
import { createClientCalls } from "./projections/client-calls.js";
import { environmentsProjection } from "./projections/environments.js";
import { modesProjection, type ModePicker } from "./projections/modes.js";
import { createEnvironmentNotices } from "./projections/notices.js";
import { createRuns } from "./projections/runs.js";
import { sessionProjection, type SessionProjection } from "./projections/session.js";
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
  const report = (error: unknown): void => (platform.reportError ? platform.reportError(error) : void Promise.reject(error));
  // Every notice raised, from any source, is also an attention event; the runtime never takes one to the shell (#142).
  const attention = createAttention(report);
  const notices = createNotices(platform.clock, (notice) => attention.emit({ kind: "notice-arrived", notice }));
  const environmentNotices = createEnvironmentNotices(notices);
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
    report,
    applied(environmentId, stream, event, news) {
      if (stream === "list") {
        outbox.applied(environmentId, event);
        // Every run and prompt event of every session comes on the list: the run states and the parked asks fold them all.
        runs.heard(environmentId, event);
        if (news && event.type === "run.ended") {
          const { runId, reason, cause } = event.payload as RunEndedPayload;
          attention.emit({ kind: "run-ended", environmentId, sessionId: event.streamId.toLowerCase(), runId, reason, cause });
        }
      }
      if (stream !== "environment") return;
      // A resolution settles a parked ask, and takes back its notice, whether or not it is news: an answered prompt never parks
      // again. Only news says how it was settled (`environmentNotices.heard`, below).
      if (event.type === "prompt.resolved") {
        const { sessionId, promptId } = event.payload as { sessionId: string; promptId: string };
        runs.resolved(environmentId, sessionId, promptId);
        if (!news) environmentNotices.settled(environmentId, sessionId, promptId);
      }
      // A notice replayed onto a stream that held nothing is history: every ready fetches the cache again anyway, and it says nothing new.
      if (!news) return;
      requestCache.noticed(environmentId, event.type);
      clientCalls.heard(environmentId, event);
      if (event.type === "prompt.parked") {
        const { sessionId, runId, promptId, kind, title, summary } = event.payload as { sessionId: string; runId: string; promptId: string; kind: PromptKind; title: string; summary: string };
        attention.emit({ kind: "prompt-parked", environmentId, sessionId: sessionId.toLowerCase(), runId, promptId, promptKind: kind, title, summary });
      }
      environmentNotices.heard(environmentId, event, {
        name: registry.record(environmentId)?.descriptor.name ?? "The environment",
        accountLabel: (accountId) => requestCache.peek(environmentId, "accounts.list", {})?.accounts.find((account) => account.id === accountId)?.label ?? null,
        title: (sessionId) => lists.read().get(environmentId)?.data?.sessions.get(sessionId.toLowerCase())?.title ?? null,
      });
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

  // The projections of #142: runs and parked asks, one session's transcript, accounts, models and plan usage, the mode picker,
  // and the calls the environment addresses to this client.
  const runs = createRuns({
    clock: platform.clock,
    records: registry.list,
    lists,
    outbox: outbox.view,
    prompts: (environmentId) => requestCache.cached(environmentId, "permissions.prompts.list", {}),
    promptsAskedAt: (environmentId) => requestCache.askedAt(environmentId, "permissions.prompts.list", {}),
    now: (environmentId) => made.now(environmentId),
  });
  registry.seams.onForget((environmentId) => runs.forget(environmentId));
  const clientCalls = createClientCalls({ seams: registry.seams, record: (environmentId) => registry.record(environmentId), report });
  registry.seams.onForget((environmentId) => clientCalls.forget(environmentId));
  /** One observable per environment (and session), so a renderer reading one twice follows one. */
  const memo = <T>(make: (key: string) => T) => {
    const held = new Map<string, T>();
    registry.seams.onForget((environmentId) => {
      for (const key of held.keys()) if (key === environmentId || key.startsWith(`${environmentId} `)) held.delete(key);
    });
    return (key: string): T => {
      let value = held.get(key);
      if (value === undefined) held.set(key, (value = make(key)));
      return value;
    };
  };
  const sessionProjections = memo((key) => {
    const [environmentId, sessionId] = key.split(" ") as [string, string];
    return sessionProjection({ lease: made.lease, peek: made.peek, outbox: outbox.view, drafts: drafts.waiting }, environmentId, sessionId);
  });
  const accountsProjections = memo((environmentId): Observable<AccountsAnswer> => answerOf(environmentId, requestCache.cached(environmentId, "accounts.list", {}), (result) => result.accounts));
  const modelsProjections = memo((environmentId): Observable<ModelsAnswer> => answerOf(environmentId, requestCache.cached(environmentId, "models.list", {}), (result) => result.catalogues));
  const modesProjections = memo((environmentId): Observable<ModePicker> => modesProjection(registry.list, environmentId));
  const usage = usageProjection({
    environments: derived([registry.list] as const, (list) =>
      list.filter((record) => record.enabled && record.environmentId !== LOCAL_PLACEHOLDER_ID).map((record) => record.environmentId),
    ),
    // The request cache gives the same observable for the same environment and query.
    source: (environmentId) => requestCache.cached(environmentId, "accounts.usage", {}),
  });

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
      session: (environmentId, sessionId): Observable<SessionProjection> => sessionProjections(`${environmentId} ${sessionId.toLowerCase()}`),
      runs: runs.view,
      accounts: (environmentId) => accountsProjections(environmentId),
      models: (environmentId) => modelsProjections(environmentId),
      usage,
      modes: (environmentId) => modesProjections(environmentId),
    },
    attention: { subscribe: (listener) => attention.subscribe(listener) },
    clientCalls: { register: (kind, handler) => clientCalls.register(kind, handler) },
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
        runs.close();
        clientCalls.close();
        requestCache.close();
        await made.close();
      })();
      return closing;
    },
  };
  return { runtime, seams: registry.seams };
};
