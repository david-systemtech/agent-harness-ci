import { sendMessage, isLive } from "./composer/send.js";
import { ChecksChangedPayload, ChecksFailuresResetPayload } from "@agent-harness/contracts";
import { createChecks } from "./checks.js";
import { PROTOCOL_VERSION, type PromptKind, type RunEndedPayload } from "@agent-harness/contracts";
import { answerCapability } from "./capabilities.js";
import { LOCAL_PLACEHOLDER_ID, type ConnectionRecord } from "./connections/records.js";
import { createRegistry, type ConnectionSeams, type RegistryCaches } from "./connections/registry.js";
import { DESKTOP_DOWNLOAD_TIMEOUT_MS, createDesktopUpdate } from "./desktop-update.js";
import { createNotices } from "./notices.js";
import { derived, type Observable } from "./observable.js";
import { createDrafts } from "./outbox/drafts.js";
import { createOutbox, type Outbox } from "./outbox/outbox.js";
import { awaitedTargets, keepingSameTargets, overlaidLists, pendingTargets } from "./outbox/overlay.js";
import type { Platform } from "./platform.js";
import { answerOf, usageProjection, type AccountsAnswer, type ModelsAnswer } from "./projections/accounts.js";
import { createAttention } from "./projections/attention.js";
import { BROWSER_CHROME_CALL, browserChromeHandler } from "./projections/browser-chrome.js";
import { browsersProjection, type BrowsersHost, type BrowsersView } from "./projections/browsers.js";
import { createClientCalls } from "./projections/client-calls.js";
import { documentsProjection, type SessionDocument } from "./projections/documents.js";
import { environmentsProjection } from "./projections/environments.js";
import { hideKnownDirectory, knownDirectoriesProjection, type KnownDirectoriesHost, type KnownDirectory } from "./projections/known-directories.js";
import { modesProjection, type ModePicker } from "./projections/modes.js";
import { PRESET_SETTING_KEYS, newSessionProjection, type NewSessionHost } from "./projections/new-session.js";
import { copyTargetsOf, type CopyTarget } from "./copies.js";
import { createForges } from "./forges.js";
import { createRoutineSettlement } from "./routine-settlement.js";
import { createRoutineMoves } from "./routine-moves.js";
import { createSkillsCopies } from "./skills-copy.js";
import { createKeyManagers } from "./key-managers.js";
import { reportKnownEnvironments } from "./known-environments.js";
import { createForgeNotices } from "./projections/forge-notices.js";
import { createKeyManagerNotices } from "./projections/key-manager-notices.js";
import { createToolRuns } from "./managed-tools/tool-runs.js";
import { createEnvironmentNotices } from "./projections/notices.js";
import { routineHistoryProjection, routinesProjection, type RoutineHistory } from "./projections/routines.js";
import { createRuns, sessionRunsProjection, type RunsProjection } from "./projections/runs.js";
import { sessionProjection, type SessionProjection } from "./projections/session.js";
import { SETUP_CHECK_TIMEOUT_MS, createSetup } from "./projections/setup.js";
import { createRequestCache, createRequests, type Requests } from "./requests.js";
import { searchProjection } from "./projections/search.js";
import { sessionListProjection } from "./projections/session-list.js";
import type { Runtime } from "./runtime.js";
import { createStreams, type Streams } from "./streams/streams.js";
import { createTerminalSubscriptions } from "./streams/terminals.js";

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
    environmentSnapshotted(environmentId, status) {
      if (status?.readiness === "ready") environmentNotices.ready(environmentId);
    },
    applied(environmentId, stream, event, news) {
      // Session completion events refresh diffs even during replay, and when another Client performed the undo.
      if (stream.startsWith("session.") && event.type === "files.undo-finished") requestCache.sessionChanged(environmentId, event.streamId, event.type);
      if (stream === "list") {
        outbox.applied(environmentId, event);
        // Every run and prompt event of every session comes on the list: the run states and the parked asks fold them all.
        runs.heard(environmentId, event);
        if (news) requestCache.sessionChanged(environmentId, event.streamId, event.type);
        if (news && event.type === "run.ended") {
          const { runId, reason, cause } = event.payload as RunEndedPayload;
          attention.emit({ kind: "run-ended", environmentId, sessionId: event.streamId.toLowerCase(), runId, reason, cause });
        }
      }
      if (stream !== "environment") return;
      // The forge's rows read every forge event, history too, for the origins and problems it names (#320); the key managers'
      // every connection's event, for the labels and statuses it names (#384).
      forgeNotices.heard(environmentId, event, news);
      keyManagerNotices.heard(environmentId, event, news);
      // A tool run's start and end, history too, so the run under way and each tool's last are as the stream says (#426).
      toolRuns.heard(environmentId, event);
      // Startup supersedes the preceding drain on this stream, including a replay onto an empty cache.
      if (event.type === "environment.started") environmentNotices.restarted(environmentId, event.sequence);
      // A resolution settles a parked ask, and takes back its notice, whether or not it is news: an answered prompt never parks
      // again. Only news says how it was settled (`environmentNotices.heard`, below).
      if (event.type === "prompt.resolved") {
        const { sessionId, promptId } = event.payload as { sessionId: string; promptId: string };
        runs.resolved(environmentId, sessionId, promptId);
        if (!news) environmentNotices.settled(environmentId, sessionId, promptId);
      }
      if (event.type === "checks.changed") {
        const payload = ChecksChangedPayload.safeParse(event.payload);
        if (payload.success) checks.changed(environmentId, payload.data, event.sequence);
      }
      if (event.type === "checks.failures-reset") {
        const payload = ChecksFailuresResetPayload.safeParse(event.payload);
        if (payload.success) checks.failuresReset(environmentId, payload.data, event.sequence);
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
    routineName: (environmentId, routineId) =>
      requestCache.peek(environmentId, "routines.list", {})?.routines.find((routine) => routine.state.id.toLowerCase() === routineId)?.definition.name ?? null,
    // `routines` is made below: nothing is accepted before the runtime starts.
    routineCreated: (environmentId, params) => routines.created(environmentId, params),
    now: (environmentId) => made.now(environmentId),
    // What the runtime holds of the session, read without subscribing anything.
    held: (environmentId, sessionId) => sessionProjections(`${environmentId} ${sessionId.toLowerCase()}`).read(),
    sessionRuns: (environmentId, sessionId) => sessionRuns(`${environmentId} ${sessionId.toLowerCase()}`),
    flushDrafts: () => drafts.flush(),
    setLastUsed: (environmentId) => registry.setLastUsed(environmentId),
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
    pending: derived([registry.list, outbox.view] as const, keepingSameTargets(pendingTargets)),
    awaiting: derived([outbox.view] as const, keepingSameTargets(awaitedTargets)),
  });
  let closing: Promise<void> | undefined;
  let started: Promise<void> | undefined;
  const capability: Runtime["capability"] = (environmentId, name) => answerCapability(name, registry.record(environmentId), platform.shell);
  const { call } = createRequests({ clock: platform.clock, capability, request: registry.seams.request });
  const requestCache = createRequestCache({ clock: platform.clock, call, records: registry.list, report });
  registry.seams.onForget((environmentId) => requestCache.forget(environmentId));
  // Each environment told of this client's other connections, after each hello and as they change (#382).
  const stopReporting = reportKnownEnvironments({ kind: platform.client.kind, records: registry.list, call, report });
  const requests: Requests = {
    call,
    cached: (environmentId, method, params) => requestCache.cached(environmentId, method, params),
    refresh: (environmentId, method, params) => requestCache.refresh(environmentId, method, params),
  };
  // The desktop's own update and the server it carries (#354): through the local environment, its stage given the time a download takes.
  const desktopUpdate = createDesktopUpdate({
    clock: platform.clock,
    shell: platform.shell,
    records: registry.list,
    call,
    stageCall: createRequests({ clock: platform.clock, capability, request: registry.seams.request, timeoutMs: DESKTOP_DOWNLOAD_TIMEOUT_MS }).call,
    report,
  });
  /** Resolves true once the environment's connection is ready (at once if it is), false once it is forgotten or the runtime closes. */
  const readyAgain = (environmentId: string): Promise<boolean> =>
    new Promise((resolve) => {
      /** True or false once it is known; undefined while the connection is on its way. */
      const known = (records: readonly ConnectionRecord[]): boolean | undefined => {
        const record = records.find((r) => r.environmentId === environmentId);
        if (closing !== undefined || record === undefined) return false;
        return record.phase === "ready" ? true : undefined;
      };
      const now = known(registry.list.read());
      if (now !== undefined) return resolve(now);
      const stop = registry.list.subscribe((records) => {
        const later = known(records);
        if (later === undefined) return;
        stop();
        resolve(later);
      });
    });
  /** Reads what `read` answers once the environment's connection is ready (null once it cannot be): a row heard while catching up after a reconnect comes before it is, when no request may go yet. */
  const whenReady = async <T>(environmentId: string, read: () => Promise<T | null>): Promise<T | null> => ((await readyAgain(environmentId)) ? read() : null);
  const forgeNotices = createForgeNotices({
    notices,
    name: (environmentId) => registry.record(environmentId)?.descriptor.name ?? "The environment",
    held: (environmentId) => requestCache.peek(environmentId, "forge.accounts.list", {})?.accounts ?? null,
    list: (environmentId) =>
      whenReady(environmentId, async () => {
        const answer = await call(environmentId, "forge.accounts.list", {});
        return answer.ok ? answer.result.accounts : null;
      }),
    report,
  });
  registry.seams.onForget((environmentId) => forgeNotices.forget(environmentId));
  const keyManagerNotices = createKeyManagerNotices({
    notices,
    name: (environmentId) => registry.record(environmentId)?.descriptor.name ?? "The environment",
    held: (environmentId) => requestCache.peek(environmentId, "keyManagers.list", {})?.connections ?? null,
    list: (environmentId) =>
      whenReady(environmentId, async () => {
        const answer = await call(environmentId, "keyManagers.list", {});
        return answer.ok ? answer.result.connections : null;
      }),
    report,
  });
  registry.seams.onForget((environmentId) => keyManagerNotices.forget(environmentId));
  const toolRuns = createToolRuns(report);
  registry.seams.onForget((environmentId) => toolRuns.forget(environmentId));

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
  // A terminal's output (#148): a subscription per handle, attached on each `ready`, never cached.
  const terminals = createTerminalSubscriptions({ clock: platform.clock, random: platform.random ?? Math.random, report, seams: registry.seams, records: registry.list });
  const clientCalls = createClientCalls({ seams: registry.seams, record: (environmentId) => registry.record(environmentId), report });
  registry.seams.onForget((environmentId) => clientCalls.forget(environmentId));
  // Every client drives a Chrome paired with its own local environment for a run elsewhere that it started: the browser
  // relay's client half (#554).
  clientCalls.register(
    BROWSER_CHROME_CALL,
    browserChromeHandler({
      record: (environmentId) => registry.record(environmentId),
      request: (environmentId, method, params) => registry.seams.request(environmentId, method, params),
      now: (environmentId) => made.now(environmentId),
    }),
  );
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
  const documentsOf = memo((key): Observable<readonly SessionDocument[]> => documentsProjection(sessionProjections(key)));
  const sessionRuns = memo((key) => {
    const [environmentId, sessionId] = key.split(" ") as [string, string];
    const host = {
      runs: runs.sessions,
      session: sessionProjections(key),
      list: sessionList.view,
      records: registry.list,
      providers: requestCache.cached(environmentId, "providers.list", {}),
      accounts: requestCache.cached(environmentId, "accounts.list", {}),
    };
    return sessionRunsProjection(host, environmentId, sessionId);
  });
  const runsProjection: RunsProjection = {
    read: () => runs.view.read(),
    subscribe: (listener) => runs.view.subscribe(listener),
    session: (environmentId, sessionId) => sessionRuns(`${environmentId} ${sessionId.toLowerCase()}`),
  };
  const accountsProjections = memo((environmentId): Observable<AccountsAnswer> => answerOf(environmentId, requestCache.cached(environmentId, "accounts.list", {}), (result) => result.accounts));
  const modelsProjections = memo((environmentId): Observable<ModelsAnswer> => answerOf(environmentId, requestCache.cached(environmentId, "models.list", {}), (result) => result.catalogues));
  const modesProjections = memo((environmentId): Observable<ModePicker> => modesProjection(registry.list, environmentId));
  const copyTargets = memo((environmentId): Observable<readonly CopyTarget[]> => derived([registry.list] as const, (records) => copyTargetsOf(records, environmentId)));
  const directoriesHost: KnownDirectoriesHost = {
    lists,
    preferences: registry.preferences,
    hide: (environmentId, path, lastUsedAt) => registry.hideDirectory(environmentId, path, lastUsedAt),
  };
  const knownDirectories = memo((environmentId): Observable<readonly KnownDirectory[]> => knownDirectoriesProjection(directoriesHost, environmentId));
  // Set up (#570): each environment's results from its own stream and this client's checks through the request path.
  const setup = createSetup({
    clock: platform.clock,
    records: registry.list,
    environments: made.environments,
    call: createRequests({ clock: platform.clock, capability, request: registry.seams.request, timeoutMs: SETUP_CHECK_TIMEOUT_MS }).call,
    now: (environmentId) => made.now(environmentId),
  });
  registry.seams.onForget((environmentId) => setup.forget(environmentId));
  const usage = usageProjection({
    environments: derived([registry.list] as const, (list) =>
      list.filter((record) => record.enabled && record.environmentId !== LOCAL_PLACEHOLDER_ID).map((record) => record.environmentId),
    ),
    // The request cache gives the same observable for the same environment and query.
    source: (environmentId) => requestCache.cached(environmentId, "accounts.usage", {}),
  });
  // Every enabled environment's routines (#532), the request cache giving the same observable for the same environment.
  const routines = routinesProjection({
    clock: platform.clock,
    records: registry.list,
    outbox: outbox.view,
    source: (environmentId) => requestCache.cached(environmentId, "routines.list", {}),
    askedAt: (environmentId) => requestCache.askedAt(environmentId, "routines.list", {}),
  });
  registry.seams.onForget((environmentId) => routines.forget(environmentId));
  const routineSettlement = createRoutineSettlement({ routines: routines.view, call, dispatch: outbox.dispatch, admits: outbox.admits, report });
  const routineHistories = memo((key): RoutineHistory => {
    const [environmentId, routineId] = key.split(" ") as [string, string];
    const host = {
      newest: requestCache.cached(environmentId, "routines.history", { routineId }),
      page: (before: string) => call(environmentId, "routines.history", { routineId, before }),
    };
    return routineHistoryProjection(host, environmentId, routineId);
  });
  const browsersHost: BrowsersHost = {
    records: registry.list,
    sessionList: sessionList.view,
    chromes: (environmentId) => requestCache.cached(environmentId, "browser.chromes.list", {}),
    status: (environmentId) => requestCache.cached(environmentId, "browser.status", {}),
    webView: answerCapability("shell.webView", undefined, platform.shell),
  };
  const browsers = memo((key): Observable<BrowsersView> => {
    const [environmentId, sessionId] = key.split(" ") as [string, string];
    return browsersProjection(browsersHost, environmentId, sessionId);
  });
  const newSessionHost: NewSessionHost = {
    ...browsersHost,
    environments,
    preferences: registry.preferences,
    usage,
    accounts: accountsProjections,
    models: modelsProjections,
    knownDirectories,
    defaults: (environmentId) => requestCache.cached(environmentId, "settings.get", { keys: [...PRESET_SETTING_KEYS] }),
  };

  const checks = createChecks({ clock: platform.clock, requests, records: registry.list, capability,
    terminal: (environmentId, terminalId, listener) => terminals.open(environmentId, terminalId, listener),
    session: (environmentId, sessionId) => sessionProjections(`${environmentId} ${sessionId.toLowerCase()}`),
    send: (environmentId, sessionId, message, choice) => sendMessage(runtime, environmentId, sessionId, message, isLive(runsProjection.session(environmentId, sessionId).read().state), choice),
  });
  const runtime: Runtime = {
    // A start that failed is not kept: the next call starts again.
    start: () =>
      (started ??= registry.start().then(
        () => desktopUpdate.start(),
        (error: unknown) => {
          started = undefined;
          throw error;
        },
      )),
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
      updateEnvironment: (environmentId) => registry.updateEnvironment(environmentId),
      updateEnvironmentNow: (environmentId) => registry.updateEnvironmentNow(environmentId),
      credential: (environmentId) => registry.credential(environmentId),
    },
    preferences: registry.preferences,
    checks: checks.actions,
    projections: {
      checks: checks.view,
      environments,
      notices: notices.list,
      sessionList: sessionList.view,
      search: (query) => searchProjection(sessionList.view, query),
      session: (environmentId, sessionId): Observable<SessionProjection> => sessionProjections(`${environmentId} ${sessionId.toLowerCase()}`),
      documents: (environmentId, sessionId) => documentsOf(`${environmentId} ${sessionId.toLowerCase()}`),
      runs: runsProjection,
      accounts: (environmentId) => accountsProjections(environmentId),
      models: (environmentId) => modelsProjections(environmentId),
      usage,
      modes: (environmentId) => modesProjections(environmentId),
      copyTargets: (environmentId) => copyTargets(environmentId),
      knownDirectories: (environmentId) => knownDirectories(environmentId),
      newSession: (context) => newSessionProjection(newSessionHost, context),
      setup: (environmentId) => setup.view(environmentId),
      toolRuns: (environmentId) => toolRuns.view(environmentId),
      routines: routineSettlement.view,
      routineHistory: (environmentId, routineId) => routineHistories(`${environmentId} ${routineId.toLowerCase()}`),
      browsers: (environmentId, sessionId) => browsers(`${environmentId} ${sessionId.toLowerCase()}`),
    },
    attention: { subscribe: (listener) => attention.subscribe(listener) },
    clientCalls: { register: (kind, handler) => clientCalls.register(kind, handler) },
    subscriptions: {
      session: (environmentId, sessionId) => made.session(environmentId, sessionId),
      terminal: (environmentId, terminalId, listener) => terminals.open(environmentId, terminalId, listener),
    },
    commands: {
      ...createRoutineMoves({
        capability, admits: outbox.admits, reserve: routineSettlement.reserve, call, dispatch: outbox.dispatch,
        cached: (environmentId, routineId) => requestCache.peek(environmentId, "routines.list", {})?.routines.find(r => r.state.id === routineId) ?? null,
        pendingMove: (environmentId, routineId) => outbox.view.read().get(environmentId)?.entries.some(entry => entry.method === "routines.disable" && String(entry.params["routineId"]).toLowerCase() === routineId && entry.params["movedTo"] !== undefined) ?? false,
      }),
      ...createSkillsCopies({ clock: platform.clock, call, capability, name: (environmentId) => registry.record(environmentId)?.descriptor.name ?? null, targetIds: (environmentId) => copyTargetsOf(registry.list.read(), environmentId).map((target) => target.environmentId) }),
      dispatch: (environmentId, method, params) => outbox.dispatch(environmentId, method, params),
      moveToGroup: (environmentId, sessionId, groupName) => outbox.moveToGroup(environmentId, sessionId, groupName),
      admits: (environmentId, method) => outbox.admits(environmentId, method),
      rewind: (environmentId, sessionId, messageId, options) => outbox.rewind(environmentId, sessionId, messageId, options),
      fork: (environmentId, sessionId, options) => outbox.fork(environmentId, sessionId, options),
      startSession: (environmentId, choice) => outbox.startSession(environmentId, choice),
    },
    drafts: {
      set: (environmentId, sessionId, draft) => drafts.set(environmentId, sessionId, draft),
      flush: () => drafts.flush(),
    },
    notices: { dismiss: (id) => notices.dismiss(id) },
    knownDirectories: { hide: (environmentId, path) => hideKnownDirectory(directoriesHost, environmentId, path) },
    environmentNow: (environmentId) => made.now(environmentId),
    requests,
    desktopUpdate: { view: desktopUpdate.view, restart: () => desktopUpdate.restart(), applyBundledServer: () => desktopUpdate.applyBundledServer() },
    setup: { check: (environmentId, step) => setup.check(environmentId, step) },
    forges: createForges({ clock: platform.clock, shell: platform.shell, capability, call, name: (environmentId) => registry.record(environmentId)?.descriptor.name ?? null }),
    keyManagers: createKeyManagers({ clock: platform.clock, call, name: (environmentId) => registry.record(environmentId)?.descriptor.name ?? null }),
    capability,
    async checkpoint() {
      drafts.flush();
      await outbox.checkpoint();
      await made.checkpoint();
    },
    close() {
      closing ??= (async () => {
        routineSettlement.close();
        desktopUpdate.close();
        registry.close();
        terminals.close();
        // A draft still waiting its second is dispatched, so the outbox keeps it for the next start.
        drafts.close();
        await outbox.close();
        sessionList.stop();
        runs.close();
        clientCalls.close();
        stopReporting();
        forgeNotices.close();
        keyManagerNotices.close();
        setup.close();
        requestCache.close();
        await made.close();
      })();
      return closing;
    },
  };
  return { runtime, seams: registry.seams };
};
