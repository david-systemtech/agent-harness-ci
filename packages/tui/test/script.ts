import type { GrantReader, HttpFetch, WebSocketFactory } from "@agent-harness/client-runtime";
import type { ManualClock } from "@agent-harness/client-runtime/testing";
import { fakeWire, type FakeAnswer, type FakeServer, type FakeWire } from "@agent-harness/client-runtime/testing/fake-wire";
import {
  AdapterCapabilities,
  Ceiling,
  DISCOVERY_PATH,
  LIST_PATCH_KEY,
  MODES,
  PAIR_PATH,
  SCOPES,
  ENVIRONMENT_STREAM_KIND,
  SESSION_STREAM_KIND,
  WIRE_PATH,
  eventTypeEntry,
  isListEvent,
  registry,
  type AccountUsage,
  type AttachmentInput,
  type ByeReason,
  type CapabilityFlags,
  type CommandEntry,
  type DiscoveryDocument,
  type EventEnvelope,
  type Frame,
  Group,
  type HelloFrame,
  type ModelUsage,
  type QueueHolder,
  type ResultOf,
  type RunEndReason,
  type Scope,
  SessionSummary,
  type SummaryPatch,
} from "@agent-harness/contracts";

/**
 * The scripted fake environment (docs/specs/tui.md, "Testing Decisions"):
 * the #126 fake wire extended with a script, one or two environments, each
 * with its sessions and groups, its client sessions, the receipts its
 * commands answer, how its pairing exchange refuses a code, and what its
 * discovery answers. A test drives it further through its handle: `bye`
 * reasons, a dropped socket, discovery answering `starting` or nothing.
 */

/** How a command is answered: accepted, or rejected with a reason (an error code) and a message. */
export type ScriptedReceipt = "accepted" | { readonly rejected: string; readonly message?: string };

/** What discovery answers: ready, starting, or nothing at all (nothing listens). */
export type ScriptedDiscovery = "ready" | "starting" | "nothing";

/** A client session as `access.sessions.list` lists it. */
export type ClientSessionRow = ResultOf<"access.sessions.list">["sessions"][number];

/** Why the pairing exchange refuses every code, as the environment answers it. */
export type ScriptedPairingRefusal = "expired-code" | "used-code" | "invalid-code";

export interface ScriptedEnvironment {
  readonly name: string;
  /** How this terminal reaches it: `local` through the grant file, `paired` before the first frame, `unpaired` only by `/pair`. */
  readonly reach: "local" | "paired" | "unpaired";
  /** Preset: a fresh UUID. Name one to start again on the same environment. */
  readonly environmentId?: string;
  readonly protocolVersion?: number;
  readonly capabilities?: CapabilityFlags;
  /** The scopes `hello` gives this terminal's client session: preset every scope. */
  readonly scopes?: readonly Scope[];
  /** What discovery answers at first: preset `ready`. */
  readonly discovery?: ScriptedDiscovery;
  readonly sessions?: readonly Partial<SessionSummary>[];
  readonly groups?: readonly Partial<Group>[];
  /** What `access.sessions.list` lists besides this terminal's own client session. */
  readonly clientSessions?: readonly Partial<ClientSessionRow>[];
  /**
   * How each method named is answered: preset accepted. A command's
   * rejection is its receipt; a query's (`access.sessions.list`) is an
   * error response with the reason as its code.
   */
  readonly receipts?: Readonly<Record<string, ScriptedReceipt>>;
  /** How the pairing exchange answers: preset it accepts any code. */
  readonly pairing?: ScriptedPairingRefusal;
  /** What `hello` says differently from discovery: another environment id, other scopes. */
  readonly hello?: Partial<HelloFrame>;
  /** Whether a socket is answered with `hello` as soon as its `auth` arrives: preset true. */
  readonly autoAccept?: boolean;
  /** What `files.list` lists for any session: preset none. */
  readonly files?: readonly string[];
  /** The provider's own slash commands, as `commands.list` answers them: preset none. */
  readonly commands?: readonly CommandEntry[];
  /** The one provider `providers.list` describes, over a Claude-shaped descriptor that neither queues nor steers. */
  readonly provider?: Partial<AdapterCapabilities>;
  /** Who holds a message sent during a live run: preset the environment (ADR 0022). */
  readonly queue?: QueueHolder;
  /** Holds each session's catch-up after `subscribed`, until `releaseSessions`: the stream stays catching up. Preset false. */
  readonly holdSessions?: boolean;
}

export interface Script {
  readonly environments: readonly ScriptedEnvironment[];
}

export interface EnvironmentHandle {
  readonly name: string;
  readonly environmentId: string;
  readonly wire: FakeWire;
  /** The environment's side of the socket the client opened last. */
  readonly server: FakeServer;
  /** What discovery answers from now on. */
  discovery(answer: ScriptedDiscovery | Partial<DiscoveryDocument>): void;
  /** What discovery answers now, as the local service's readiness reads it. */
  readiness(): ScriptedDiscovery;
  /** Says `bye` on the latest socket and closes it. */
  bye(reason: ByeReason, fields?: { readonly protocolVersion?: number; readonly message?: string }): void;
  /** Answers `hello` on the latest socket, for an environment that does not accept on its own. */
  accept(overrides?: Partial<HelloFrame>): Promise<void>;
  /** Stops or restarts answering `auth` on its own. */
  autoAccept(on: boolean): void;
  /** The requests the client sent on its latest socket, by method. */
  requests(method?: string): readonly Extract<Frame, { readonly type: "request" }>[];
  /** The id of the session the script lists `index`th (from 0). */
  sessionId(index?: number): string;
  /** A session's summary as the environment holds it now. */
  summary(sessionId: string): SessionSummary;
  /**
   * Appends an event to the session's stream at the next sequence and sends
   * it to the client's subscriptions: the session's, and the list's when the
   * type is list-flagged or it changes the summary (`fields`, or a whole
   * `patch`). The payload is held to its type's schema when the contracts
   * know the type; an unknown type goes as it is.
   */
  emit(sessionId: string, type: string, payload: Record<string, unknown>, change?: { readonly fields?: Partial<SessionSummary>; readonly patch?: SummaryPatch }): EventEnvelope;
  /** Starts a run as `runs.start` does: `message.sent` (a prompt) then `run.started`, the session running. */
  startRun(sessionId: string, text: string, attachments?: readonly AttachmentInput[]): { readonly runId: string; readonly messageId: string };
  /** Ends a run: `run.ended` with `reason` (preset completed), the session idle. */
  endRun(sessionId: string, runId: string, end?: { readonly reason?: RunEndReason; readonly usage?: readonly ModelUsage[] | null; readonly durationMs?: number }): void;
  /** The run live on the session, as the environment knows it; undefined when none is. */
  liveRun(sessionId: string): string | undefined;
  /** What `accounts.usage` answers from now on, said with a `usage.updated` notice for each reading, as the environment says it. */
  setUsage(readings: readonly AccountUsage[]): void;
  /** Sends the catch-up of every session subscription `holdSessions` held. */
  releaseSessions(): void;
}

export interface ScriptedWorld {
  readonly environments: readonly EnvironmentHandle[];
  /** Routes to each environment by its origin; nothing else answers. */
  readonly fetch: HttpFetch;
  readonly webSocket: WebSocketFactory;
  /** The local environment's grant reader; undefined when the script has none. */
  readonly grant: GrantReader | undefined;
  environment(name: string): EnvironmentHandle;
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "env";

/** A fixture checked against the contracts' schema, so a script never feeds the runtime what no environment would send. */
const checked = <T,>(schema: { parse(value: unknown): T }, value: T): T => schema.parse(value);

const summaryOf = (clock: ManualClock, partial: Partial<SessionSummary>, index: number): SessionSummary => {
  const at = clock.now().toISOString();
  return checked(SessionSummary, {
    id: `0199aa00-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    createdAt: at,
    updatedAt: at,
    lastActivityAt: null,
    title: "New session",
    titleSource: "default",
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
    workspace: { kind: "directory", path: "/home/seth/code" },
    repositoryIdentity: null,
    activity: { state: "idle", since: at },
    parkedPromptCount: 0,
    accountId: null,
    model: null,
    mode: null,
    pullRequests: [],
    draft: null,
    ...partial,
  });
};

const groupOf = (clock: ManualClock, partial: Partial<Group>, index: number): Group => {
  const at = clock.now().toISOString();
  return checked(Group, {
    id: `0199bb00-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    name: `Group ${index + 1}`,
    orderKey: null,
    createdAt: at,
    updatedAt: at,
    ...partial,
  });
};

/** A client session row's schema: contracts exports none by name, so it is read off `access.sessions.list`'s result. */
const ClientSessionRowSchema = registry["access.sessions.list"].result.shape.sessions.element;

const clientSessionOf = (clock: ManualClock, partial: Partial<ClientSessionRow>, index: number): ClientSessionRow => {
  const at = clock.now().toISOString();
  return checked(ClientSessionRowSchema, {
    id: `0199cc00-0000-7000-8000-${String(index + 1).padStart(12, "0")}`,
    kind: "desktop",
    label: `client ${index + 1}`,
    createdAt: at,
    lastSeenAt: at,
    expiresAt: new Date(clock.now().getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    revokedAt: null,
    scopes: [...SCOPES],
    ceiling: Ceiling.parse("bypassPermissions"),
    local: false,
    ...partial,
  });
};

/** The descriptor `providers.list` answers: Claude-shaped, with `changes` over it. */
const providerOf = (changes: Partial<AdapterCapabilities> = {}): AdapterCapabilities =>
  checked(AdapterCapabilities, {
    provider: "claude",
    displayName: "Claude",
    interactivePrompts: true,
    partialMessages: true,
    providerQueue: false,
    steering: false,
    resume: true,
    fork: true,
    rewind: true,
    sessionListing: false,
    subagents: true,
    subagentTranscripts: false,
    titleRead: false,
    titleWrite: false,
    transcriptDelete: false,
    planUsage: true,
    liveModels: false,
    commands: true,
    imageInput: true,
    fileInput: false,
    modeChange: true,
    containment: false,
    instructionChannel: { kind: "system-prompt-append", maxCharacters: null },
    modes: MODES.map((mode) => ({ mode, available: true as const, reason: null })),
    ...changes,
  });

const PAIRING_REFUSALS: Readonly<Record<ScriptedPairingRefusal, { readonly status: number; readonly code: string }>> = {
  "expired-code": { status: 410, code: "pairing_expired" },
  "used-code": { status: 410, code: "pairing_used" },
  "invalid-code": { status: 401, code: "pairing_invalid" },
};

const later = (step: () => void) => void Promise.resolve().then(step);

const scripted = (clock: ManualClock, spec: ScriptedEnvironment, index: number) => {
  const host = `${slug(spec.name)}.test`;
  const wire = fakeWire({
    clock,
    name: spec.name,
    address: { host, port: 7433 + index },
    ...(spec.environmentId !== undefined && { environmentId: spec.environmentId }),
    ...(spec.protocolVersion !== undefined && { protocolVersion: spec.protocolVersion }),
    ...(spec.capabilities !== undefined && { capabilities: spec.capabilities }),
  });
  let discovery: ScriptedDiscovery = spec.discovery ?? "ready";
  let accepting = spec.autoAccept ?? true;
  const hello: Partial<HelloFrame> = { ...(spec.scopes && { scopes: [...spec.scopes] }), ...spec.hello };
  const setDiscovery = (answer: ScriptedDiscovery | Partial<DiscoveryDocument>) => {
    if (typeof answer === "string") {
      discovery = answer;
      wire.discovery(answer === "nothing" ? "unreachable" : { readiness: answer });
    } else {
      discovery = answer.readiness === "starting" ? "starting" : "ready";
      wire.discovery(answer);
    }
  };
  setDiscovery(discovery);

  const sessions = (spec.sessions ?? []).map((s, i) => summaryOf(clock, s, i));
  const groups = (spec.groups ?? []).map((g, i) => groupOf(clock, g, i));
  let sequence = 100;
  wire.answer("sessions.list", () => ({ result: { sequence, sessions } }));
  wire.answer("groups.list", () => ({ result: { groups } }));
  wire.answer("sessions.get", (params) => {
    const found = sessions.find((s) => s.id === params["sessionId"]);
    return found ? { result: { summary: found } } : { error: { code: "not_found", message: "No such session.", data: {} } };
  });

  // The streams: the session list and each session, answered `subscribed`, then the list as it stands or the session's
  // whole log (a snapshot at its creation and every event since), then `synchronized` at the head. What is emitted later
  // goes to the subscriptions of the latest socket.
  const logs = new Map<string, { readonly base: number; readonly events: EventEnvelope[] }>(sessions.map((s) => [s.id, { base: sequence, events: [] }]));
  let subscriptions = 0;
  let listSubscription: string | undefined;
  const sessionSubscriptions = new Map<string, string>();
  const subscribed = (request: { readonly id: string }): string => {
    const id = `${slug(spec.name)}-sub-${++subscriptions}`;
    wire.server.send({ type: "subscribed", id: request.id, subscription: id });
    return id;
  };
  wire.answer("sessions.subscribe", (_params, request) => {
    listSubscription = subscribed(request);
    wire.server.send({ type: "snapshot", subscription: listSubscription, sequence, payload: { sequence, sessions, groups } });
    wire.server.send({ type: "synchronized", subscription: listSubscription, sequence });
    return undefined;
  });
  wire.answer("sessions.subscribeSession", (params, request) => {
    const sessionId = String(params["sessionId"]).toLowerCase();
    const summary = sessions.find((s) => s.id === sessionId);
    const log = logs.get(sessionId);
    if (!summary || !log) return { error: { code: "not_found", message: "No such session.", data: { kind: "session" } } };
    const id = subscribed(request);
    sessionSubscriptions.set(sessionId, id);
    const catchUp = () => {
      wire.server.send({ type: "snapshot", subscription: id, sequence: log.base, payload: { sequence: log.base, summary: summaryAt(sessionId), runs: [], items: [], parkedPrompts: [] } });
      for (const event of log.events) wire.server.send({ type: "event", subscription: id, sequence: event.sequence, event });
      wire.server.send({ type: "synchronized", subscription: id, sequence });
    };
    if (spec.holdSessions) held.push(catchUp);
    else catchUp();
    return undefined;
  });
  const held: (() => void)[] = [];
  let environmentSubscription: string | undefined;
  wire.answer("environment.subscribe", (_params, request) => {
    environmentSubscription = subscribed(request);
    wire.server.send({ type: "synchronized", subscription: environmentSubscription, sequence });
    return undefined;
  });
  let usage: readonly AccountUsage[] = [];
  wire.answer("accounts.usage", () => ({ result: { readings: [...usage] } }));
  const setUsage = (readings: readonly AccountUsage[]) => {
    usage = readings;
    for (const reading of readings) {
      const at = ++sequence;
      const event: EventEnvelope = {
        sequence: at,
        eventId: `0199fe00-0000-7000-8000-${String(at).padStart(12, "0")}`,
        streamKind: ENVIRONMENT_STREAM_KIND,
        streamId: wire.environmentId,
        streamVersion: at,
        type: "usage.updated",
        occurredAt: clock.now().toISOString(),
        commandId: null,
        causationId: null,
        correlationId: null,
        actor: { kind: "system", id: "script" },
        payload: { accountId: reading.accountId, identity: reading.identity },
        metadata: {},
      };
      if (environmentSubscription) wire.server.send({ type: "event", subscription: environmentSubscription, sequence: at, event });
    }
  };

  /** The summary a session's snapshot holds: its creation's, since everything after is replayed on top of it. */
  const created = new Map<string, SessionSummary>(sessions.map((s) => [s.id, s]));
  const summaryAt = (sessionId: string): SessionSummary => created.get(sessionId) as SessionSummary;
  const summaryNow = (sessionId: string): SessionSummary => {
    const found = sessions.find((s) => s.id === sessionId);
    if (!found) throw new Error(`${spec.name} holds no session ${sessionId}.`);
    return found;
  };
  const setSummary = (summary: SessionSummary) => {
    const at = sessions.findIndex((s) => s.id === summary.id);
    if (at === -1) sessions.push(summary);
    else sessions[at] = summary;
  };

  const emit: EnvironmentHandle["emit"] = (sessionId, type, payload, change = {}) => {
    const entry = eventTypeEntry(SESSION_STREAM_KIND, type);
    const checkedPayload = entry ? (entry.payload.parse(payload) as Record<string, unknown>) : payload;
    const patch: SummaryPatch | undefined = change.patch ?? (change.fields ? { op: "set", sessionId, fields: change.fields } : undefined);
    if (patch?.op === "add") {
      setSummary(patch.summary);
      created.set(patch.summary.id, patch.summary);
      logs.set(patch.summary.id, { base: sequence, events: [] });
    } else if (patch?.op === "set") setSummary(SessionSummary.parse({ ...summaryNow(sessionId), ...patch.fields }));
    const log = logs.get(sessionId);
    if (!log) throw new Error(`${spec.name} holds no session ${sessionId}.`);
    const at = ++sequence;
    const event: EventEnvelope = {
      sequence: at,
      eventId: `0199ff00-0000-7000-8000-${String(at).padStart(12, "0")}`,
      streamKind: SESSION_STREAM_KIND,
      streamId: sessionId,
      streamVersion: log.events.length + 1,
      type,
      occurredAt: clock.now().toISOString(),
      commandId: null,
      causationId: null,
      correlationId: null,
      actor: { kind: "system", id: "script" },
      payload: checkedPayload,
      metadata: patch ? { [LIST_PATCH_KEY]: patch } : {},
    };
    log.events.push(event);
    const own = sessionSubscriptions.get(sessionId);
    if (own) wire.server.send({ type: "event", subscription: own, sequence: at, event });
    if (listSubscription && (patch || isListEvent(SESSION_STREAM_KIND, type))) wire.server.send({ type: "event", subscription: listSubscription, sequence: at, event });
    return event;
  };

  const live = new Map<string, string>();
  const records = (attachments: readonly AttachmentInput[] = []) =>
    attachments.map((a) => ({ kind: a.kind, name: a.name, mediaType: a.mediaType, size: Math.floor((a.data.length * 3) / 4) }));
  let runs = 0;
  const minted = (prefix: string) => `${prefix}-0000-4000-8000-${String(++runs).padStart(12, "0")}`;
  const startRun: EnvironmentHandle["startRun"] = (sessionId, text, attachments) => {
    const runId = minted("0199a100");
    const messageId = minted("0199a200");
    const summary = summaryNow(sessionId);
    emit(sessionId, "message.sent", { runId, messageId, text, attachments: records(attachments), delivery: "prompt", heldBy: null, ceiling: "bypassPermissions" });
    emit(
      sessionId,
      "run.started",
      {
        runId,
        accountId: summary.accountId ?? "account-1",
        identity: null,
        model: summary.model ?? "claude-fake",
        effort: null,
        mode: { requested: null, effective: "acceptEdits", clamped: false },
        workspace: summary.workspace,
        origin: "client",
        promptMessageId: messageId,
        queuedMessageIds: [],
        resumedFrom: null,
        forkedFrom: null,
      },
      { fields: { activity: { state: "running", since: clock.now().toISOString() } } },
    );
    live.set(sessionId, runId);
    return { runId, messageId };
  };
  const endRun: EnvironmentHandle["endRun"] = (sessionId, runId, end = {}) => {
    const reason = end.reason ?? "completed";
    emit(
      sessionId,
      "run.ended",
      {
        runId,
        reason,
        cause: reason === "interrupted" ? "user" : null,
        error: reason === "error" ? { message: "The run failed.", code: null } : null,
        usage: end.usage ?? null,
        durationMs: end.durationMs ?? 1000,
        turnCount: null,
        resultText: null,
      },
      { fields: { activity: { state: "idle", since: clock.now().toISOString() } } },
    );
    if (live.get(sessionId) === runId) live.delete(sessionId);
  };

  // The run commands, as the environment answers them (claude-adapter spec, "Wire methods"; ADR 0022): a start or a send
  // with no run live starts one; a send during a live run is queued, held by whoever the script says holds the queue; an
  // interrupt ends the run. A receipt the script rejects is answered as it is, and nothing is appended.
  const acceptedWith = (result: Record<string, unknown>): FakeAnswer => ({ result: { receipt: { status: "accepted", sequence, changed: true }, result } });
  const rejection = (method: string): FakeAnswer | undefined => {
    const scriptedReceipt = spec.receipts?.[method];
    if (scriptedReceipt === undefined || scriptedReceipt === "accepted") return undefined;
    const message = scriptedReceipt.message ?? `Rejected: ${scriptedReceipt.rejected}.`;
    return { result: { receipt: { status: "rejected", sequence: ++sequence, changed: false, reason: scriptedReceipt.rejected, error: { code: scriptedReceipt.rejected, message, data: {} } } } };
  };
  const attachmentsOf = (params: Record<string, unknown>) => (params["attachments"] as readonly AttachmentInput[] | undefined) ?? [];
  wire.answer("runs.start", (params) => {
    const refused = rejection("runs.start");
    if (refused) return refused;
    const sessionId = String(params["sessionId"]);
    if (live.has(sessionId)) {
      return { result: { receipt: { status: "rejected", sequence: ++sequence, changed: false, reason: "conflict", error: { code: "conflict", message: "A run is live.", data: { reason: "run_active" } } } } };
    }
    return acceptedWith(startRun(sessionId, String(params["text"]), attachmentsOf(params)));
  });
  wire.answer("runs.send", (params) => {
    const refused = rejection("runs.send");
    if (refused) return refused;
    const sessionId = String(params["sessionId"]);
    const runId = live.get(sessionId);
    if (runId === undefined) return acceptedWith({ ...startRun(sessionId, String(params["text"]), attachmentsOf(params)), delivery: "prompt", heldBy: null });
    const messageId = minted("0199a200");
    const heldBy = spec.queue ?? "environment";
    emit(sessionId, "message.sent", { runId, messageId, text: String(params["text"]), attachments: records(attachmentsOf(params)), delivery: "queued", heldBy, ceiling: "bypassPermissions" });
    return acceptedWith({ runId, messageId, delivery: "queued", heldBy });
  });
  wire.answer("runs.interrupt", (params) => {
    const refused = rejection("runs.interrupt");
    if (refused) return refused;
    const runId = String(params["runId"]);
    const sessionId = [...live.entries()].find(([, id]) => id === runId)?.[0];
    if (sessionId === undefined) return acceptedWith({ runId, ended: true });
    endRun(sessionId, runId, { reason: "interrupted" });
    return acceptedWith({ runId, ended: false });
  });
  wire.answer("runs.stopTask", (params) => rejection("runs.stopTask") ?? acceptedWith({ runId: params["runId"], taskId: params["taskId"], ended: false }));
  wire.answer("sessions.setDraft", (params) => {
    const refused = rejection("sessions.setDraft");
    if (refused) return refused;
    const sessionId = String(params["sessionId"]);
    const draft = (params["draft"] as string | null | undefined) || null;
    emit(sessionId, "session.draft-set", { draft }, { fields: { draft } });
    return acceptedWith({ summary: summaryNow(sessionId) });
  });
  wire.answer("sessions.create", (params) => {
    const refused = rejection("sessions.create");
    if (refused) return refused;
    const at = clock.now().toISOString();
    const summary = summaryOf(clock, { id: String(params["id"]), workspace: params["workspace"] as SessionSummary["workspace"], createdAt: at, updatedAt: at }, sessions.length);
    emit(
      summary.id,
      "session.created",
      { title: null, tags: [], groupId: null, workspace: summary.workspace, repositoryIdentity: null, account: null, model: null, mode: null },
      { patch: { op: "add", summary } },
    );
    return acceptedWith({ summary });
  });
  wire.answer("files.list", () => ({ result: { files: [...(spec.files ?? [])], truncated: false, source: "git" } }));
  wire.answer("commands.list", () => ({ result: { accountId: "account-1", commands: [...(spec.commands ?? [])] } }));
  wire.answer("providers.list", () => ({ result: { providers: [providerOf(spec.provider)] } }));

  const others = (spec.clientSessions ?? []).map((c, i) => clientSessionOf(clock, c, i));
  const revoked = new Set<string>();
  wire.answer("access.sessions.list", (params) => {
    const refusal = spec.receipts?.["access.sessions.list"];
    if (refusal !== undefined && refusal !== "accepted") {
      return { error: { code: refusal.rejected, message: refusal.message ?? `Rejected: ${refusal.rejected}.`, data: {} } };
    }
    const own = wire.credential();
    const listed: ClientSessionRow[] = [
      ...others,
      ...(own ? [clientSessionOf(clock, { id: own.clientSessionId, kind: "tui", label: "seth@desk:pts/3", local: spec.reach === "local" }, others.length)] : []),
    ].map((c) => (revoked.has(c.id) ? { ...c, revokedAt: clock.now().toISOString() } : c));
    return { result: { sessions: params["live"] === true ? listed.filter((c) => c.revokedAt === null) : listed } };
  });

  const receiptFor = (method: string): FakeAnswer | undefined => {
    const scriptedReceipt = spec.receipts?.[method] ?? "accepted";
    if (scriptedReceipt === "accepted") return undefined;
    const message = scriptedReceipt.message ?? `Rejected: ${scriptedReceipt.rejected}.`;
    return {
      result: {
        receipt: {
          status: "rejected",
          sequence: ++sequence,
          changed: false,
          reason: scriptedReceipt.rejected,
          error: { code: scriptedReceipt.rejected, message, data: {} },
        },
      },
    };
  };
  const accepted = (result: Record<string, unknown>): FakeAnswer => ({
    result: { receipt: { status: "accepted", sequence: ++sequence, changed: true }, result },
  });
  wire.answer("access.sessions.revoke", (params) => {
    const refusal = receiptFor("access.sessions.revoke");
    if (refusal) return refusal;
    revoked.add(String(params["clientSessionId"]));
    return accepted({ revokedAt: clock.now().toISOString() });
  });
  let pairings = 0;
  wire.answer("access.pairings.create", () => {
    const refusal = receiptFor("access.pairings.create");
    if (refusal) return refusal;
    pairings++;
    const code = `K7Q2MXH4R${"TVWXYZ"[pairings % 6]}`;
    return accepted({
      pairingId: `0199dd00-0000-7000-8000-${String(pairings).padStart(12, "0")}`,
      code,
      link: `${wire.origin}/pair#${code}`,
      expiresAt: new Date(clock.now().getTime() + 10 * 60 * 1000).toISOString(),
      scopes: [...SCOPES],
      ceiling: Ceiling.parse("bypassPermissions"),
    });
  });
  // Every other scripted command, `access.*` ones included, answers its receipt alone, as a retry answered from a stored receipt does.
  const ownResponders = new Set([
    "access.sessions.list",
    "access.sessions.revoke",
    "access.pairings.create",
    "runs.start",
    "runs.send",
    "runs.interrupt",
    "runs.stopTask",
    "sessions.setDraft",
    "sessions.create",
  ]);
  for (const method of Object.keys(spec.receipts ?? {})) {
    if (ownResponders.has(method)) continue;
    wire.answer(method, () => receiptFor(method) ?? { result: { receipt: { status: "accepted", sequence: ++sequence, changed: true } } });
  }

  const fetch: HttpFetch = async (url, request) => {
    if (spec.pairing && url === `${wire.origin}${PAIR_PATH}` && request?.method === "POST" && discovery !== "nothing") {
      const refusal = PAIRING_REFUSALS[spec.pairing];
      const body = { code: refusal.code, message: `Refused: ${refusal.code}.`, data: {} };
      return { status: refusal.status, json: async () => body };
    }
    return wire.fetch(url, request);
  };

  const webSocket: WebSocketFactory = (url, handlers) => {
    const socket = wire.webSocket(url, handlers);
    return {
      send(text) {
        socket.send(text);
        if (!accepting || (JSON.parse(text) as Frame).type !== "auth") return;
        later(() => {
          try {
            wire.server.hello(hello);
          } catch {
            // The socket closed before the answer: nothing to say it on.
          }
        });
      },
      close: (code, reason) => socket.close(code, reason),
    };
  };

  const handle: EnvironmentHandle = {
    name: spec.name,
    environmentId: wire.environmentId,
    wire,
    server: wire.server,
    discovery: setDiscovery,
    readiness: () => discovery,
    bye: (reason, fields) => wire.server.bye(reason, fields),
    accept: async (overrides) => void (await wire.server.accept({ ...hello, ...overrides })),
    autoAccept(on) {
      accepting = on;
    },
    requests: (method) =>
      wire.server
        .received()
        .filter((f): f is Extract<Frame, { readonly type: "request" }> => f.type === "request" && (method === undefined || f.method === method)),
    sessionId(at = 0) {
      const found = sessions[at];
      if (!found) throw new Error(`${spec.name} lists no session at ${at}.`);
      return found.id;
    },
    summary: summaryNow,
    emit,
    startRun,
    endRun,
    liveRun: (sessionId) => live.get(sessionId),
    setUsage,
    releaseSessions: () => held.splice(0).forEach((catchUp) => catchUp()),
  };
  return { handle, fetch, webSocket, wsUrl: `${wire.origin.replace(/^http/, "ws")}${WIRE_PATH}` };
};

/** Builds the script's environments on `clock`, with one `fetch` and one WebSocket factory routing to them by address. */
export const scriptedWorld = (clock: ManualClock, script: Script): ScriptedWorld => {
  const built = script.environments.map((spec, index) => scripted(clock, spec, index));
  const byName = new Map(built.map((b) => [b.handle.name, b.handle]));
  const local = script.environments.findIndex((spec) => spec.reach === "local");
  if (script.environments.filter((spec) => spec.reach === "local").length > 1) throw new Error("A script has at most one local environment.");
  return {
    environments: built.map((b) => b.handle),
    fetch: async (url, request) => {
      const target = built.find((b) => url.startsWith(`${b.handle.wire.origin}/`));
      if (!target) throw new TypeError("fetch failed");
      return target.fetch(url, request);
    },
    webSocket: (url, handlers) => {
      const target = built.find((b) => b.wsUrl === url);
      if (target) return target.webSocket(url, handlers);
      later(() => handlers.onClose(1006, "Nothing answered."));
      return { send: () => undefined, close: () => undefined };
    },
    grant: local === -1 ? undefined : (built[local] as (typeof built)[number]).handle.wire.grant,
    environment(name) {
      const found = byName.get(name);
      if (!found) throw new Error(`The script has no environment named ${name}.`);
      return found;
    },
  };
};

/** The discovery path, for a test that reads it through the world's `fetch`. */
export { DISCOVERY_PATH };
