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
  AccountRecord,
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
  type InterruptCause,
  type ModelUsage,
  type QueueHolder,
  type ResultOf,
  type RunEndReason,
  type Scope,
  SessionSummary,
  TERMINAL_EXITED_TYPE,
  TERMINAL_OUTPUT_TYPE,
  TERMINAL_STREAM_KIND,
  type SessionDiffFile,
  type SummaryPatch,
  type TerminalExitCause,
  type TerminalInfo,
} from "@agent-harness/contracts";
import { LIST_COMMANDS, scriptedList, type ScriptedList } from "./list-server.js";
import { scriptedPrompts, type ScriptedPrompts } from "./prompts.js";

/**
 * The scripted fake environment (docs/specs/tui.md, "Testing Decisions"):
 * the #126 fake wire extended with a script, one or two environments, each
 * with its sessions and groups, its client sessions, the receipts its
 * commands answer, how its pairing exchange refuses a code, and what its
 * discovery answers. A test drives it further through its handle: `bye`
 * reasons, a dropped socket, discovery answering `starting` or nothing, a
 * notice on the environment's stream, and prompts parked and answered
 * (`prompts.ts`).
 */

/** How a command is answered: accepted, or rejected with a reason (an error code), a message and the error's data. */
export type ScriptedReceipt = "accepted" | { readonly rejected: string; readonly message?: string; readonly data?: Readonly<Record<string, unknown>> };

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
  /** Several providers instead, each over the same descriptor; `provider` is then ignored. */
  readonly providers?: readonly Partial<AdapterCapabilities>[];
  /** What `accounts.list` lists, over an adopted, signed-in account on the first provider: preset none. */
  readonly accounts?: readonly Partial<AccountRecord>[];
  /** Who holds a message sent during a live run: preset the environment (ADR 0022). */
  readonly queue?: QueueHolder;
  /** Holds each session's catch-up after `subscribed`, until `releaseSessions`: the stream stays catching up. Preset false. */
  readonly holdSessions?: boolean;
  /** Whether `files.list` says the workspace holds more than it listed: preset false. */
  readonly filesTruncated?: boolean;
  /** What `files.read` answers, by path: its text, or a file too large or binary; any other path is `not_found`, and a directory of `files` is `not_a_file`. */
  readonly fileContents?: Readonly<Record<string, ScriptedFile>>;
  /** What `diffs.session` answers for any session: preset no files. */
  readonly sessionDiff?: { readonly files: readonly SessionDiffFile[]; readonly truncated?: boolean };
  /** What `diffs.workingTree` answers, or its refusal (a `conflict` with its reason): preset an empty diff in a repository. */
  readonly workingTree?: { readonly diff: string; readonly truncated?: boolean; readonly repository?: boolean } | { readonly refused: string; readonly message: string };
  /** Terminals open on the environment before the first frame, each for the session the script lists at `session` (preset 0). */
  readonly terminals?: readonly ScriptedTerminal[];
  /**
   * What a one-off command (`!`'s or `!!`'s) prints and how it exits, once its line is typed: preset nothing, and 0. With no
   * exit code it runs on until `exitTerminal`.
   */
  readonly oneOff?: (command: string) => { readonly output: string; readonly exitCode?: number };
  /** Whether the login shell runs a one-off's line: preset true; false is a shell that is not POSIX, which refuses the line and exits 127. */
  readonly posixShell?: boolean;
}

/** A file as `files.read` answers it. */
export type ScriptedFile = string | { readonly binary: true; readonly size: number } | { readonly text: string; readonly truncated: true; readonly size: number };

/** A terminal the environment holds from the start. */
export interface ScriptedTerminal {
  readonly id: string;
  readonly session?: number;
  /** Its output so far, one chunk. */
  readonly output?: string;
  readonly cols?: number;
  readonly rows?: number;
  /** Its exit code when its shell has exited; preset it runs. */
  readonly exitCode?: number;
}

/** A terminal as the scripted environment holds it: what was written to it and how it was sized, by the commands that did. */
export interface TerminalRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly cols: number;
  readonly rows: number;
  /** The variables `terminals.open` gave its shell. */
  readonly env: Readonly<Record<string, string>>;
  /** What `terminals.write` wrote to it, one entry a command. */
  readonly writes: readonly string[];
  /** Every `terminals.resize`, in order. */
  readonly resizes: readonly { readonly cols: number; readonly rows: number }[];
  readonly closed: boolean;
}

export interface Script {
  readonly environments: readonly ScriptedEnvironment[];
}

export interface EnvironmentHandle extends ScriptedPrompts {
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
  /** Its session list: what it holds now, a method's answers held, a change of its own accord. */
  readonly list: ScriptedList;
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
  /**
   * Ends a run as the environment does (ADR 0022): at an end other than
   * `completed`, what the provider holds of the run comes back to the
   * environment's queue (`message.requeued`) before `run.ended` (reason preset
   * completed; an interrupt's cause preset `user`), the session idle; after
   * any end but an interrupt, the run of the queue starts with what the
   * environment holds, as the environment's `startFromQueue` does.
   */
  endRun(
    sessionId: string,
    runId: string,
    end?: { readonly reason?: RunEndReason; readonly cause?: InterruptCause; readonly usage?: readonly ModelUsage[] | null; readonly durationMs?: number },
  ): void;
  /** The session's queue as the environment holds it now, in the order sent: what `message.sent` queued and nothing has read, steered, requeued away or withdrawn. */
  queued(sessionId: string): readonly { readonly messageId: string; readonly runId: string; readonly text: string; readonly heldBy: QueueHolder }[];
  /** The run live on the session, as the environment knows it; undefined when none is. */
  liveRun(sessionId: string): string | undefined;
  /** What `accounts.usage` answers from now on, said with a `usage.updated` notice for each reading, as the environment says it. */
  setUsage(readings: readonly AccountUsage[]): void;
  /** Sends the catch-up of every session subscription `holdSessions` held. */
  releaseSessions(): void;
  /** Says a notice on the environment's own stream (`environment.subscribe`), as the environment does. */
  notice(type: string, payload: Record<string, unknown>): void;
  /** The terminals the environment has held, oldest first, closed ones included. */
  terminals(): readonly TerminalRecord[];
  /** A terminal it holds or held; fails for one it never did. */
  terminal(id: string): TerminalRecord;
  /** The terminal's shell writes `data`: a `terminal.output` chunk to its subscriptions. */
  terminalOutput(id: string, data: string): void;
  /** The terminal's shell exits with `exitCode`: `terminal.exited`, then its subscriptions end. */
  exitTerminal(id: string, exitCode: number): void;
  /** The terminal's scrollback loses its oldest `chunks`, as the cap drops them: a cursor before what is kept gets a truncated snapshot. */
  dropScrollback(id: string, chunks: number): void;
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

  // The streams: the session list (`test/list-server.ts`) and each session, answered `subscribed`, then the list as it
  // stands or the session's whole log (a snapshot at its creation and every event since), then `synchronized` at the
  // head. What is emitted later goes to the subscriptions of the latest socket.
  const logs = new Map<string, { readonly base: number; readonly events: EventEnvelope[] }>(sessions.map((s) => [s.id, { base: sequence, events: [] }]));
  let subscriptions = 0;
  const sessionSubscriptions = new Map<string, string>();
  const subscribed = (request: { readonly id: string }): string => {
    const id = `${slug(spec.name)}-sub-${++subscriptions}`;
    wire.server.send({ type: "subscribed", id: request.id, subscription: id });
    return id;
  };
  wire.answer("sessions.subscribeSession", (params, request) => {
    const sessionId = String(params["sessionId"]).toLowerCase();
    const summary = sessions.find((s) => s.id === sessionId);
    const log = logs.get(sessionId);
    if (!summary || !log) return { error: { code: "not_found", message: "No such session.", data: { kind: "session" } } };
    const id = subscribed(request);
    // Live events go to the subscription only once its catch-up is sent, as an environment catching up sends them after it.
    const catchUp = () => {
      wire.server.send({ type: "snapshot", subscription: id, sequence: log.base, payload: { sequence: log.base, summary: summaryAt(sessionId), runs: [], items: [], parkedPrompts: [] } });
      for (const event of log.events) wire.server.send({ type: "event", subscription: id, sequence: event.sequence, event });
      wire.server.send({ type: "synchronized", subscription: id, sequence });
      sessionSubscriptions.set(sessionId, id);
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
  /** Says a notice on the environment's own stream, as the environment does. */
  const notice = (type: string, payload: Record<string, unknown>) => {
    const at = ++sequence;
    const event: EventEnvelope = {
      sequence: at,
      eventId: `0199fe00-0000-7000-8000-${String(at).padStart(12, "0")}`,
      streamKind: ENVIRONMENT_STREAM_KIND,
      streamId: wire.environmentId,
      streamVersion: at,
      type,
      occurredAt: clock.now().toISOString(),
      commandId: null,
      causationId: null,
      correlationId: null,
      actor: { kind: "system", id: "script" },
      payload,
      metadata: {},
    };
    if (environmentSubscription) wire.server.send({ type: "event", subscription: environmentSubscription, sequence: at, event });
  };
  const setUsage = (readings: readonly AccountUsage[]) => {
    usage = readings;
    for (const reading of readings) notice("usage.updated", { accountId: reading.accountId, identity: reading.identity });
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

  // Each session's queue, kept in step with what its log says (ADR 0022): a message queued by `message.sent`, its holder
  // moved by `message.requeued`, and gone once a run reads it (`message.delivered`, a `run.started` carrying it) or it is
  // withdrawn, when why it is gone is kept for the environment's `not_found`.
  type Queued = { readonly messageId: string; readonly runId: string; readonly text: string; heldBy: QueueHolder };
  const queues = new Map<string, Queued[]>();
  const gone = new Map<string, string>();
  const queueOf = (sessionId: string): Queued[] => {
    let queue = queues.get(sessionId);
    if (queue === undefined) queues.set(sessionId, (queue = []));
    return queue;
  };
  const followQueue = (sessionId: string, type: string, payload: Record<string, unknown>) => {
    const queue = queueOf(sessionId);
    const drop = (ids: readonly unknown[], why: string) => {
      for (const id of ids) gone.set(String(id), why);
      queues.set(sessionId, queue.filter((message) => !ids.includes(message.messageId)));
    };
    if (type === "message.sent" && payload["delivery"] === "queued") {
      queue.push({ messageId: String(payload["messageId"]), runId: String(payload["runId"]), text: String(payload["text"]), heldBy: (payload["heldBy"] as QueueHolder | null) ?? "environment" });
    } else if (type === "message.requeued") {
      const message = queue.find((m) => m.messageId === payload["messageId"]);
      if (message) message.heldBy = "environment";
    } else if (type === "message.withdrawn") drop([payload["messageId"]], "it was withdrawn already");
    else if (type === "message.delivered") drop([payload["messageId"]], "a run has read it");
    else if (type === "run.started") drop(payload["queuedMessageIds"] as readonly unknown[], "a run has read it");
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
    followQueue(sessionId, type, checkedPayload);
    const own = sessionSubscriptions.get(sessionId);
    if (own) wire.server.send({ type: "event", subscription: own, sequence: at, event });
    if (patch || isListEvent(SESSION_STREAM_KIND, type)) list.publish(event);
    return event;
  };

  const live = new Map<string, string>();
  const records = (attachments: readonly AttachmentInput[] = []) =>
    attachments.map((a) => ({ kind: a.kind, name: a.name, mediaType: a.mediaType, size: Math.floor((a.data.length * 3) / 4) }));
  let runs = 0;
  const minted = (prefix: string) => `${prefix}-0000-4000-8000-${String(++runs).padStart(12, "0")}`;
  /** Starts a run with a prompt, or (`text` null) a run of the queue carrying `queued`, as the environment starts one after a read-now. */
  const beginRun = (sessionId: string, text: string | null, attachments: readonly AttachmentInput[] | undefined, queued: readonly string[]) => {
    const runId = minted("0199a100");
    const messageId = text === null ? null : minted("0199a200");
    const summary = summaryNow(sessionId);
    if (text !== null) emit(sessionId, "message.sent", { runId, messageId, text, attachments: records(attachments), delivery: "prompt", heldBy: null, ceiling: "bypassPermissions" });
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
        queuedMessageIds: [...queued],
        resumedFrom: null,
        forkedFrom: null,
      },
      { fields: { activity: { state: "running", since: clock.now().toISOString() } } },
    );
    for (const id of queued) emit(sessionId, "message.delivered", { runId, messageId: id, delivery: "prompt" });
    live.set(sessionId, runId);
    return { runId, messageId };
  };
  const startRun: EnvironmentHandle["startRun"] = (sessionId, text, attachments) => {
    const { runId, messageId } = beginRun(sessionId, text, attachments, []);
    return { runId, messageId: messageId as string };
  };
  const endRun: EnvironmentHandle["endRun"] = (sessionId, runId, end = {}) => {
    const reason = end.reason ?? "completed";
    // The environment takes back what the provider holds of a run it did not see complete, in the transaction of its end.
    if (reason !== "completed") {
      for (const message of queueOf(sessionId).filter((m) => m.heldBy === "provider" && m.runId === runId)) {
        emit(sessionId, "message.requeued", { runId, messageId: message.messageId });
      }
    }
    emit(
      sessionId,
      "run.ended",
      {
        runId,
        reason,
        cause: reason === "interrupted" ? (end.cause ?? "user") : null,
        error: reason === "error" ? { message: "The run failed.", code: null } : null,
        usage: end.usage ?? null,
        durationMs: end.durationMs ?? 1000,
        turnCount: null,
        resultText: null,
      },
      { fields: { activity: { state: "idle", since: clock.now().toISOString() } } },
    );
    if (live.get(sessionId) === runId) live.delete(sessionId);
    // The run of the queue: what the environment holds, read as the next run's prompt. After an interrupt nothing starts
    // (a read-now starts its run itself), and what the provider holds is read by a turn the provider opens, not modelled here.
    if (reason !== "interrupted") startFromQueue(sessionId);
  };
  /** The messages the environment holds for the session, in the order sent: what a run of the queue reads. */
  const environmentHeld = (sessionId: string) => queueOf(sessionId).filter((m) => m.heldBy === "environment").map((m) => m.messageId);
  /** Starts the run of the environment's queue, when it holds anything; the run's id, else undefined. */
  const startFromQueue = (sessionId: string): string | undefined => {
    const queued = environmentHeld(sessionId);
    return queued.length === 0 ? undefined : beginRun(sessionId, null, undefined, queued).runId;
  };

  // Parked prompts and their answers (`test/prompts.ts`).
  const { prompts, answer: answerPrompt } = scriptedPrompts({
    clock,
    wire,
    emit,
    notice,
    summary: summaryNow,
    liveRun: (sessionId) => live.get(sessionId),
    nextSequence: () => ++sequence,
  });
  wire.answer("permissions.prompts.answer", (params) => answerPrompt(params));

  // The run commands, as the environment answers them (claude-adapter spec, "Wire methods"; ADR 0022): a start or a send
  // with no run live starts one; a send during a live run is queued, held by whoever the script says holds the queue; an
  // interrupt ends the run. A receipt the script rejects is answered as it is, and nothing is appended.
  const acceptedWith = (result: Record<string, unknown>): FakeAnswer => ({ result: { receipt: { status: "accepted", sequence, changed: true }, result } });
  /** A scripted rejection of `method`; its receipt carries a new head, or the head it found (`advance` false) as a terminal command's does. */
  const rejection = (method: string, advance = true): FakeAnswer | undefined => {
    const scriptedReceipt = spec.receipts?.[method];
    if (scriptedReceipt === undefined || scriptedReceipt === "accepted") return undefined;
    const message = scriptedReceipt.message ?? `Rejected: ${scriptedReceipt.rejected}.`;
    const at = advance ? ++sequence : sequence;
    return {
      result: {
        receipt: { status: "rejected", sequence: at, changed: false, reason: scriptedReceipt.rejected, error: { code: scriptedReceipt.rejected, message, data: { ...scriptedReceipt.data } } },
      },
    };
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
  // Read now (ADR 0022): with a run live, it ends interrupted with cause read-now (its end hands back what the provider held),
  // and the next run starts carrying the whole queue in order; with none live, the run of what the environment holds starts
  // at once, and what the provider holds is left to the turn it opens; with nothing to read, nothing happens.
  wire.answer("runs.readNow", (params) => {
    const refused = rejection("runs.readNow");
    if (refused) return refused;
    const sessionId = String(params["sessionId"]);
    const liveRun = live.get(sessionId);
    if (liveRun === undefined) return acceptedWith({ sessionId, interruptedRunId: null, runId: startFromQueue(sessionId) ?? null });
    if (queueOf(sessionId).length === 0) return acceptedWith({ sessionId, interruptedRunId: null, runId: null });
    endRun(sessionId, liveRun, { reason: "interrupted", cause: "read-now" });
    startFromQueue(sessionId);
    return acceptedWith({ sessionId, interruptedRunId: liveRun, runId: null });
  });
  // Withdraw (ADR 0022): a queued message taken back, a provider's requeued first; its text goes to the draft, in place of
  // an empty one, else after it on a paragraph of its own. One not queued, or one the provider holds with no run live (a
  // turn it opens reads it), is not_found, in the environment's words.
  const notFound = (messageId: string, why: string): FakeAnswer => ({
    result: {
      receipt: {
        status: "rejected",
        sequence: ++sequence,
        changed: false,
        reason: "not_found",
        error: { code: "not_found", message: `No queued message ${messageId} is on this environment: ${why}.`, data: { kind: "message", messageId } },
      },
    },
  });
  wire.answer("runs.withdraw", (params) => {
    const refused = rejection("runs.withdraw");
    if (refused) return refused;
    const messageId = String(params["messageId"]);
    const found = [...queues.entries()].flatMap(([sessionId, queue]) => queue.filter((m) => m.messageId === messageId).map((m) => ({ sessionId, message: m })))[0];
    if (found === undefined) return notFound(messageId, gone.get(messageId) ?? "it was never sent here, or its session was purged");
    if (found.message.heldBy === "provider" && !live.has(found.sessionId)) return notFound(messageId, "the provider has read it");
    const { sessionId, message } = found;
    const heldBy = message.heldBy;
    if (heldBy === "provider") emit(sessionId, "message.requeued", { runId: message.runId, messageId });
    emit(sessionId, "message.withdrawn", { runId: message.runId, messageId, heldBy });
    const before = summaryNow(sessionId).draft;
    const draft = before === null || before.length === 0 ? message.text : `${before}\n\n${message.text}`;
    emit(sessionId, "session.draft-set", { draft }, { fields: { draft } });
    return acceptedWith({ messageId, sessionId, heldBy });
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
  wire.answer("files.list", () => ({ result: { files: [...(spec.files ?? [])], truncated: spec.filesTruncated ?? false, source: "git" } }));
  wire.answer("files.read", (params) => {
    const path = String(params["path"]);
    const file = spec.fileContents?.[path];
    if (file === undefined) {
      if ((spec.files ?? []).some((f) => f.startsWith(`${path}/`))) {
        return { error: { code: "invalid_params", message: `${path} is not a file.`, data: { reason: "not_a_file" } } };
      }
      return { error: { code: "not_found", message: `No file ${path} in the workspace.`, data: { kind: "file" } } };
    }
    if (typeof file === "string") return { result: { path, size: Buffer.byteLength(file), binary: false, truncated: false, text: file } };
    if ("binary" in file) return { result: { path, size: file.size, binary: true, truncated: false, text: null } };
    return { result: { path, size: file.size, binary: false, truncated: true, text: file.text } };
  });
  wire.answer("diffs.session", () => ({ result: { files: [...(spec.sessionDiff?.files ?? [])], truncated: spec.sessionDiff?.truncated ?? false } }));
  wire.answer("diffs.workingTree", () => {
    const tree = spec.workingTree ?? { diff: "" };
    if ("refused" in tree) return { error: { code: "conflict", message: tree.message, data: { reason: tree.refused } } };
    return { result: { diff: tree.diff, truncated: tree.truncated ?? false, repository: tree.repository ?? true } };
  });

  // Terminals (#124's vocabulary), as the environment answers them: a terminal is opened with the client's id, sized, written
  // to and closed by commands; its output is a chunk sequence of its own, which a subscription gets as a snapshot from cursor
  // 0 (or from one before what it keeps), else as the chunks after the cursor, then live; its exit ends every subscription.
  interface HeldTerminal {
    readonly id: string;
    readonly sessionId: string;
    readonly openedAt: string;
    cols: number;
    rows: number;
    readonly env: Readonly<Record<string, string>>;
    readonly chunks: { readonly sequence: number; readonly data: string }[];
    /** The newest chunk's sequence, and whether the cap has dropped any: neither goes back when the chunks kept are emptied. */
    last: number;
    cut: boolean;
    readonly writes: string[];
    readonly resizes: { readonly cols: number; readonly rows: number }[];
    exit: { readonly exitCode: number; readonly signal: number | null; readonly cause: TerminalExitCause; readonly sequence: number } | null;
    closed: boolean;
    readonly subscriptions: Set<string>;
  }
  const terminals = new Map<string, HeldTerminal>();
  const infoOf = (t: HeldTerminal): TerminalInfo => ({ id: t.id, sessionId: t.sessionId, openedAt: t.openedAt, cols: t.cols, rows: t.rows, exitCode: t.exit?.exitCode ?? null, signal: t.exit?.signal ?? null });
  const lastOf = (t: HeldTerminal) => t.last;
  const terminalEnvelope = (t: HeldTerminal, at: number, type: string, payload: Record<string, unknown>): EventEnvelope => ({
    sequence: at,
    eventId: `0199fd00-0000-7000-8000-${String(at).padStart(12, "0")}`,
    streamKind: TERMINAL_STREAM_KIND,
    streamId: t.id,
    streamVersion: at,
    type,
    occurredAt: clock.now().toISOString(),
    commandId: null,
    causationId: null,
    correlationId: null,
    actor: { kind: "system", id: "script" },
    payload,
    metadata: {},
  });
  const exitedEnvelope = (t: HeldTerminal) => {
    const exit = t.exit as NonNullable<HeldTerminal["exit"]>;
    return terminalEnvelope(t, exit.sequence, TERMINAL_EXITED_TYPE, { exitCode: exit.exitCode, signal: exit.signal, cause: exit.cause });
  };
  const hold = (id: string, sessionId: string, fields: { readonly cols?: number | undefined; readonly rows?: number | undefined; readonly env?: Record<string, string> | undefined }): HeldTerminal => {
    const t: HeldTerminal = {
      id,
      sessionId,
      openedAt: clock.now().toISOString(),
      cols: fields.cols ?? 80,
      rows: fields.rows ?? 24,
      env: fields.env ?? {},
      chunks: [],
      last: 0,
      cut: false,
      writes: [],
      resizes: [],
      exit: null,
      closed: false,
      subscriptions: new Set(),
    };
    terminals.set(id, t);
    return t;
  };
  /** Sends on the client's socket; with none open (dropped) a chunk is only kept, for the replay after the reconnect. */
  const toSubscriber = (frame: Frame) => {
    try {
      wire.server.send(frame);
    } catch {
      // No socket: nothing to say it on.
    }
  };
  const terminalOutput = (id: string, data: string) => {
    const t = terminals.get(id);
    if (!t || t.exit) throw new Error(`${spec.name} holds no running terminal ${id}.`);
    const at = lastOf(t) + 1;
    t.last = at;
    t.chunks.push({ sequence: at, data });
    for (const subscription of t.subscriptions) toSubscriber({ type: "event", subscription, sequence: at, event: terminalEnvelope(t, at, TERMINAL_OUTPUT_TYPE, { data }) });
  };
  const exitTerminal = (id: string, exitCode: number, cause: TerminalExitCause = "exited", signal: number | null = null) => {
    const t = terminals.get(id);
    if (!t || t.exit) return;
    t.exit = { exitCode, signal, cause, sequence: lastOf(t) + 1 };
    const event = exitedEnvelope(t);
    for (const subscription of t.subscriptions) {
      toSubscriber({ type: "event", subscription, sequence: event.sequence, event });
      toSubscriber({ type: "end", subscription, reason: cause === "deleted" ? "deleted" : "closed" });
    }
    t.subscriptions.clear();
  };
  for (const held of spec.terminals ?? []) {
    const t = hold(held.id.toLowerCase(), sessions[held.session ?? 0]?.id ?? "", { cols: held.cols, rows: held.rows });
    if (held.output !== undefined) {
      t.chunks.push({ sequence: 1, data: held.output });
      t.last = 1;
    }
    if (held.exitCode !== undefined) t.exit = { exitCode: held.exitCode, signal: null, cause: "exited", sequence: lastOf(t) + 1 };
  }
  const terminalReceipt = (method: string, result: Record<string, unknown>): FakeAnswer =>
    rejection(method, false) ?? { result: { receipt: { status: "accepted", sequence, changed: false }, result } };
  const conflict = (reason: string, message: string): FakeAnswer => ({
    result: { receipt: { status: "rejected", sequence, changed: false, reason: "conflict", error: { code: "conflict", message, data: { reason } } } },
  });
  const unknownTerminal = (id: string): FakeAnswer => ({
    result: { receipt: { status: "rejected", sequence, changed: false, reason: "not_found", error: { code: "not_found", message: `No terminal ${id} is open.`, data: { kind: "terminal" } } } },
  });
  /**
   * A one-off's line typed (`typed`), as a login shell and then `sh` would take it: the shell's prompt and its echo of the
   * line, then (a POSIX shell) the script run: each `printf '%s\n' '…'` line it prints (`!!`'s marker), the harness's own
   * lines (no input, no pager) passed over, and the rest the command, which the script's `oneOff` answers; then the exit.
   */
  const runOneOff = (t: HeldTerminal, typed: string) => {
    const script = t.env["AGENT_HARNESS_ONE_OFF"] ?? "";
    const printed: string[] = [];
    const command: string[] = [];
    for (const line of script.split("\n")) {
      const said = /^printf '%s\\n' '(.*)'$/.exec(line);
      if (said) printed.push(`${said[1] as string}\r\n`);
      else if (line !== "exec </dev/null" && !/^PAGER=cat .*; export /.test(line)) command.push(line);
    }
    later(() => {
      terminalOutput(t.id, `$ ${typed.replace(/\r$/, "")}\r\n`);
      if (spec.posixShell === false) {
        terminalOutput(t.id, "nu: unknown command: exec\r\n");
        exitTerminal(t.id, 127);
        return;
      }
      const ran = spec.oneOff?.(command.join("\n")) ?? { output: "", exitCode: 0 };
      terminalOutput(t.id, `${printed.join("")}${ran.output.replace(/\r?\n/g, "\r\n")}`);
      if (ran.exitCode !== undefined) exitTerminal(t.id, ran.exitCode);
    });
  };
  wire.answer("terminals.open", (params) => {
    const refused = rejection("terminals.open", false);
    if (refused) return refused;
    const id = String(params["id"]).toLowerCase();
    if (terminals.has(id)) return conflict("exists", `A terminal ${id} was opened on this environment already.`);
    const t = hold(id, String(params["sessionId"]).toLowerCase(), {
      cols: params["cols"] as number | undefined,
      rows: params["rows"] as number | undefined,
      env: params["env"] as Record<string, string> | undefined,
    });
    // The login shell's prompt, a moment after it starts.
    if (t.env["AGENT_HARNESS_ONE_OFF"] === undefined) later(() => t.exit === null && t.chunks.length === 0 && terminalOutput(id, "$ "));
    return terminalReceipt("terminals.open", { terminal: infoOf(t) });
  });
  wire.answer("terminals.list", (params) => ({
    result: { terminals: [...terminals.values()].filter((t) => !t.closed && t.sessionId === String(params["sessionId"]).toLowerCase()).map(infoOf) },
  }));
  wire.answer("terminals.write", (params) => {
    const id = String(params["id"]).toLowerCase();
    const t = terminals.get(id);
    if (!t || t.closed) return unknownTerminal(id);
    if (t.exit) return conflict("exited", "The terminal's shell has exited.");
    const data = String(params["data"]);
    t.writes.push(data);
    if (t.env["AGENT_HARNESS_ONE_OFF"] !== undefined && data.includes("AGENT_HARNESS_ONE_OFF")) runOneOff(t, data);
    return terminalReceipt("terminals.write", { id });
  });
  wire.answer("terminals.resize", (params) => {
    const id = String(params["id"]).toLowerCase();
    const t = terminals.get(id);
    if (!t || t.closed) return unknownTerminal(id);
    if (t.exit) return conflict("exited", "The terminal's shell has exited.");
    t.cols = Number(params["cols"]);
    t.rows = Number(params["rows"]);
    t.resizes.push({ cols: t.cols, rows: t.rows });
    return terminalReceipt("terminals.resize", { terminal: infoOf(t) });
  });
  wire.answer("terminals.close", (params) => {
    const id = String(params["id"]).toLowerCase();
    const t = terminals.get(id);
    if (!t || t.closed) return unknownTerminal(id);
    // Out of the list at once, as the environment drops it; its subscribers hear the hang-up after.
    t.closed = true;
    later(() => exitTerminal(id, 0, "closed", 1));
    return terminalReceipt("terminals.close", { id });
  });
  wire.answer("terminals.subscribe", (params, request) => {
    const id = String(params["id"]).toLowerCase();
    const t = terminals.get(id);
    if (!t || t.closed) return { error: { code: "not_found", message: `No terminal ${id} is open on this environment.`, data: { kind: "terminal", id } } };
    const subscription = subscribed(request);
    const after = Number(params["afterSequence"] ?? 0);
    const last = lastOf(t);
    const first = t.chunks[0]?.sequence ?? 0;
    if (after > 0 && after >= (t.chunks.length === 0 ? last : first - 1) && after <= last) {
      for (const chunk of t.chunks.filter((c) => c.sequence > after)) {
        wire.server.send({ type: "event", subscription, sequence: chunk.sequence, event: terminalEnvelope(t, chunk.sequence, TERMINAL_OUTPUT_TYPE, { data: chunk.data }) });
      }
    } else {
      // Truncated once the cap has dropped any chunk, as the environment's ring says.
      const payload = { terminal: infoOf(t), scrollback: t.chunks.map((c) => c.data).join(""), firstSequence: first, lastSequence: last, truncated: t.cut };
      wire.server.send({ type: "snapshot", subscription, sequence: last, payload });
    }
    if (t.exit) {
      const event = exitedEnvelope(t);
      wire.server.send({ type: "event", subscription, sequence: event.sequence, event });
      wire.server.send({ type: "end", subscription, reason: "closed" });
      return undefined;
    }
    wire.server.send({ type: "synchronized", subscription, sequence: last });
    t.subscriptions.add(subscription);
    return undefined;
  });
  wire.answer("commands.list", () => ({ result: { accountId: "account-1", commands: [...(spec.commands ?? [])] } }));
  wire.answer("providers.list", () => ({ result: { providers: (spec.providers ?? [spec.provider ?? {}]).map((p) => providerOf(p)) } }));
  wire.answer("accounts.list", () => ({
    result: {
      accounts: (spec.accounts ?? []).map((account, i) =>
        checked(AccountRecord, {
          id: `account-${i + 1}`,
          provider: "claude",
          label: `account ${i + 1}`,
          directory: { kind: "adopted", path: `/home/seth/.account-${i + 1}` },
          identity: null,
          status: { state: "signed-in", checkedAt: null, detail: null },
          createdAt: clock.now().toISOString(),
          ...account,
        }),
      ),
    },
  }));

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
          error: { code: scriptedReceipt.rejected, message, data: { ...scriptedReceipt.data } },
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
    "runs.readNow",
    "runs.withdraw",
    "runs.stopTask",
    "sessions.setDraft",
    "permissions.prompts.answer",
    "terminals.open",
    "terminals.write",
    "terminals.resize",
    "terminals.close",
    ...LIST_COMMANDS,
  ]);
  for (const method of Object.keys(spec.receipts ?? {})) {
    if (ownResponders.has(method)) continue;
    wire.answer(method, () => receiptFor(method) ?? { result: { receipt: { status: "accepted", sequence: ++sequence, changed: true } } });
  }
  // The session list and the organisation commands (`sessions.create` among them), applied with their patches to the
  // sessions the session streams read; a rejection the script names still stands.
  const list = scriptedList({
    wire,
    clock,
    store: {
      all: () => sessions,
      get: (id) => sessions.find((s) => s.id === id),
      put: (summary) => {
        if (!logs.has(summary.id)) {
          created.set(summary.id, summary);
          logs.set(summary.id, { base: sequence, events: [] });
        }
        setSummary(summary);
      },
      remove: (id) => {
        const at = sessions.findIndex((s) => s.id === id);
        if (at !== -1) sessions.splice(at, 1);
      },
    },
    groups,
    next: () => ++sequence,
    head: () => sequence,
    refusal: receiptFor,
  });

  const fetch: HttpFetch = async (url, request) => {
    if (spec.pairing && url === `${wire.origin}${PAIR_PATH}` && request?.method === "POST" && discovery !== "nothing") {
      const refusal = PAIRING_REFUSALS[spec.pairing];
      const body = { code: refusal.code, message: `Refused: ${refusal.code}.`, data: {} };
      return { status: refusal.status, json: async () => body };
    }
    return wire.fetch(url, request);
  };

  const webSocket: WebSocketFactory = (url, handlers) => {
    // A socket that closes takes its terminal subscriptions with it, as the environment drops a connection's subscriptions.
    const socket = wire.webSocket(url, {
      ...handlers,
      onClose: (code, reason) => {
        for (const t of terminals.values()) t.subscriptions.clear();
        handlers.onClose(code, reason);
      },
    });
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
    list,
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
    queued: (sessionId) => queueOf(sessionId).map((m) => ({ ...m })),
    setUsage,
    releaseSessions: () => held.splice(0).forEach((catchUp) => catchUp()),
    notice,
    ...prompts,
    terminals: () => [...terminals.values()],
    terminal(id) {
      const found = terminals.get(id.toLowerCase());
      if (!found) throw new Error(`${spec.name} never held a terminal ${id}.`);
      return found;
    },
    terminalOutput: (id, data) => terminalOutput(id.toLowerCase(), data),
    exitTerminal(id, exitCode) {
      if (!terminals.has(id.toLowerCase())) throw new Error(`${spec.name} never held a terminal ${id}.`);
      exitTerminal(id.toLowerCase(), exitCode);
    },
    dropScrollback(id, chunks) {
      const t = terminals.get(id.toLowerCase());
      if (!t) throw new Error(`${spec.name} never held a terminal ${id}.`);
      if (t.chunks.splice(0, chunks).length > 0) t.cut = true;
    },
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
