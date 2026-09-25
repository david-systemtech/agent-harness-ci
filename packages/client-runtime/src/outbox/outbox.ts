import {
  SESSION_WRITE_COMMANDS,
  groupNameKey,
  isCommand,
  isMethodName,
  normaliseGroupName,
  registry,
  type CommandMethodName,
  type CommandReceipt,
  type EventEnvelope,
  type ParamsOf,
  type ResponseFrame,
  type ResultOf,
  type SessionWriteMethodName,
} from "@agent-harness/contracts";
import { answerCapability, METHOD_FLAGS, type AbsentReason } from "../capabilities.js";
import { SocketClosedError } from "../connections/connection.js";
import { LOCAL_PLACEHOLDER_ID, type ConnectionRecord } from "../connections/records.js";
import { NotConnectedError, type ConnectionSeams } from "../connections/registry.js";
import { uuidv4, uuidv7 } from "../ids.js";
import type { Notices } from "../notices.js";
import { writable, type Observable } from "../observable.js";
import type { Clock, DocumentStore, Timer } from "../platform.js";
import type { ListData } from "../streams/kinds.js";
import type { StreamState } from "../streams/stream.js";
import { decodeOutbox, encodeOutbox, outboxDocument, type OutboxEntry } from "./entries.js";
import { reachable, type EnvironmentOutbox, type OutboxView, type OverlayRecord } from "./overlay.js";
import { overlayOf, reasonOf, targetOf, verbOf, type Target } from "./rules.js";

export { DRAFT_DEBOUNCE_MS } from "./drafts.js";

/**
 * The outbox (docs/specs/client-runtime.md, "The offline outbox, receipts
 * and optimistic application"; ADR 0003): every `sessions:write` and
 * `runs:drive` command a client makes, each with a command id minted once,
 * so a retry never applies twice.
 *
 * - `dispatch` checks the method, its params against its schema, the
 *   connection's scopes and flags, and refuses absent-with-reason; then it
 *   keeps the entry, lays its optimistic change over the list, writes the
 *   outbox's document, and answers with the command's receipt once it comes.
 * - Entries are sent in order, one in flight per environment, over the
 *   connection's ready socket (the registry's `onReady` seam). A socket that
 *   drops leaves the entry in flight: the next ready sends it again with the
 *   same command id, which the environment answers from its stored receipt.
 * - `sessions:write` commands queue while the environment is unreachable,
 *   and their rows and groups show `pending`. `runs:drive` commands never
 *   queue: dispatched while unreachable they fail at once with `unreachable`,
 *   and one still waiting its turn when the socket goes fails the same way;
 *   one already in flight is sent again, so an answer given as the link
 *   drops applies once; but never on another client session than it was
 *   sent on, whose retry the environment would run a second time: then it
 *   is dropped with a notice. `admin` and `read` commands are direct
 *   requests (`requests.call`), never queued.
 * - An accepted receipt removes the entry, and its overlay stays until the
 *   list's cursor reaches the receipt's sequence (or an event carrying its
 *   command id applies first). A rejection removes the entry and its
 *   overlay and raises one notice. An error answer (no receipt) does the
 *   same, but `unavailable` on a `sessions:write` command, which is sent
 *   again on the next ready.
 * - A `queued` setter (`SESSION_WRITE_COMMANDS`) of the same method and
 *   target as a later one is replaced by it: dropped with its overlay, its
 *   answer the later one's. A command that may be refused for what its
 *   params name (a group's rename, a move to a group, a snooze) is ordered,
 *   never replaced: the later may fail where the earlier would not.
 * - An entry dispatched more than seven days ago is dropped with a notice.
 */

/** How long an entry may wait for its receipt before it is dropped unsent: seven days, inside the environment's 30-day receipt retention. A chosen default. */
export const COMMAND_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** A command's params as a caller gives them: the outbox mints the command id. */
export type CommandParams<N extends CommandMethodName> = Omit<ParamsOf<N>, "commandId">;

export type AcceptedReceipt = Extract<CommandReceipt, { readonly status: "accepted" }>;
export type RejectedReceipt = Extract<CommandReceipt, { readonly status: "rejected" }>;

/**
 * Why a command has no accepted receipt. Refused at dispatch, with nothing
 * kept or sent: a capability's absent reason (`scope`, `unsupported`,
 * `unreachable` for a `runs:drive` command, or an environment this client
 * has no connection to), `direct` (an `admin` or `read` command, which
 * `requests.call` sends), `invalid_params`. After it was kept: the
 * environment's reason (a rejected receipt's, which the failure carries, or
 * an error answer's code), `malformed` (an answer that is not the method's),
 * `unreachable` (a `runs:drive` command still waiting its turn when the
 * socket went), `unconfirmed` (whether it applied is not known, and it is
 * not sent again: a `runs:drive` command in flight when the client session
 * changed, or a command whose request failed for another reason than its
 * socket), `expired` (seven days unsent), `forgotten` (its environment
 * was removed), `closed` (the runtime closed first: the entry stays in the
 * outbox for the next start).
 */
export type DispatchFailureCode =
  | AbsentReason
  | "direct"
  | "invalid_params"
  | "malformed"
  | "unconfirmed"
  | "expired"
  | "forgotten"
  | "closed"
  | (string & {});

export interface DispatchFailure {
  readonly code: DispatchFailureCode;
  /** One line for people. */
  readonly message: string;
  /** The environment's structured `data`, when the failure is its refusal. */
  readonly data?: Readonly<Record<string, unknown>>;
  /** The rejected receipt, when the environment rejected the command. */
  readonly receipt?: RejectedReceipt;
}

/**
 * What became of a dispatched command: its accepted receipt, with the
 * method's result when the request that applied it answered (a retry
 * answered from the stored receipt carries none); or why not, with the
 * command id when one was minted.
 */
export type DispatchAnswer<N extends CommandMethodName> =
  | { readonly ok: true; readonly commandId: string; readonly receipt: AcceptedReceipt; readonly result?: ResultOf<N> }
  | { readonly ok: false; readonly commandId: string | null; readonly error: DispatchFailure };

/** `commands.*`: the in-process API. None of these is a wire method. */
export interface Commands {
  /**
   * Sends a `sessions:write` or `runs:drive` command to the environment
   * through the outbox and answers with its receipt; see `DispatchAnswer`.
   * Its effect shows in the projections at once.
   */
  dispatch<N extends CommandMethodName>(environmentId: string, method: N, params: CommandParams<N>): Promise<DispatchAnswer<N>>;
  /**
   * Moves a session into the group named `groupName` on its environment
   * (names equal ignoring case and white space, as merged headings are), or
   * out of any with null: `sessions.setGroup`, preceded by `groups.create`
   * with a client-minted id when the environment has no group of that name
   * (session-state spec, "Merged groups by name"). Answers the move.
   */
  moveToGroup(environmentId: string, sessionId: string, groupName: string | null): Promise<DispatchAnswer<"sessions.setGroup">>;
}

export interface OutboxHost {
  readonly clock: Clock;
  readonly documents: DocumentStore;
  readonly seams: Pick<ConnectionSeams, "request" | "onReady" | "onForget">;
  readonly records: Observable<readonly ConnectionRecord[]>;
  record(environmentId: string): ConnectionRecord | undefined;
  readonly notices: Notices;
  readonly report: (error: unknown) => void;
  /** Each environment's session list as the environment confirmed it: its cursor retires an accepted command's overlay. */
  readonly lists: Observable<ReadonlyMap<string, StreamState<ListData>>>;
  /** The environment's list as it shows now, overlay and all: what a command's optimistic change is reckoned against. */
  shown(environmentId: string): ListData | null;
  /** The environment's time now. */
  now(environmentId: string): Date;
}

export interface Outbox extends Commands {
  readonly view: Observable<OutboxView>;
  /** Reads the outboxes of these environments: before their connections start. */
  load(environmentIds: readonly string[]): Promise<void>;
  /** An event applied to an environment's list: an overlay of the command it names leaves. */
  applied(environmentId: string, event: EventEnvelope): void;
  /** Answers every command still waiting `closed` (their entries stay kept) and waits for the outbox's writes. */
  close(): Promise<void>;
}

/** One environment's sending, in memory. */
interface Sender {
  /** The connection has a ready socket, as far as the outbox knows. */
  ready: boolean;
  /** The command id of the request under way; null when none is. */
  sending: string | null;
  /** An answer said `unavailable`: nothing more is sent until the next ready. */
  stalled: boolean;
  loaded: Promise<void> | undefined;
  isLoaded: boolean;
  /** The document is in a form this build does not read: it is left as it is, and nothing is written over it this run. */
  unreadable: boolean;
  /** The environment was removed: nothing more is kept, sent or written for this sender. */
  forgotten: boolean;
  /** The client session of the ready socket, from its hello: what an entry sent on it is stamped with. */
  session: string | null;
  /** The command ids of dispatches waiting on the read to be kept: a removal first answers them `forgotten`. */
  keeping: Set<string>;
  /** The document's writes, one after another. */
  writes: Promise<void>;
}

const EMPTY: EnvironmentOutbox = { entries: [], overlays: [] };

type Answer = DispatchAnswer<CommandMethodName>;

const sameTarget = (a: Target | null, b: Target | null) => a !== null && b !== null && a.kind === b.kind && a.id === b.id;

/** Whether the scope's commands go through the outbox. */
const queuedScope = (scope: string): scope is "sessions:write" | "runs:drive" => scope === "sessions:write" || scope === "runs:drive";

/** What a notice will call the command's target: its title or name as the list shows it now; what a create names. */
const labelAtDispatch = (method: string, params: Readonly<Record<string, unknown>>, target: Target | null, shown: ListData | null): string | null => {
  if (method === "sessions.create") return typeof params["title"] === "string" ? params["title"] : "a new session";
  if (method === "groups.create") return typeof params["name"] === "string" ? normaliseGroupName(params["name"]) : null;
  if (target === null) return null;
  return (target.kind === "session" ? shown?.sessions.get(target.id)?.title : shown?.groups.get(target.id)?.name) ?? null;
};

/** A command checked and ready to keep, or refused with nothing kept. */
type Prepared = { readonly refused: Answer } | { readonly commandId: string; enqueue(): Promise<Answer> };

export const createOutbox = (host: OutboxHost): Outbox => {
  const { clock, documents, notices, report } = host;
  const view = writable<OutboxView>(new Map(), report);
  const senders = new Map<string, Sender>();
  const waiters = new Map<string, ((answer: Answer) => void)[]>();
  let closed = false;
  let expiry: { readonly due: number; readonly timer: Timer } | undefined;
  /** A sweep is under way: it sets the next timer once it is done. */
  let sweeping = false;

  const senderOf = (environmentId: string): Sender => {
    let sender = senders.get(environmentId);
    if (!sender) {
      sender = {
        ready: false,
        sending: null,
        stalled: false,
        loaded: undefined,
        isLoaded: false,
        unreadable: false,
        forgotten: false,
        session: null,
        keeping: new Set(),
        writes: Promise.resolve(),
      };
      senders.set(environmentId, sender);
    }
    return sender;
  };

  const outboxOf = (environmentId: string): EnvironmentOutbox => view.read().get(environmentId) ?? EMPTY;

  const change = (environmentId: string, next: (current: EnvironmentOutbox) => EnvironmentOutbox) => {
    view.update((current) => {
      const updated = next(current.get(environmentId) ?? EMPTY);
      const map = new Map(current);
      if (updated.entries.length === 0 && updated.overlays.length === 0) map.delete(environmentId);
      else map.set(environmentId, updated);
      return map;
    });
    scheduleExpiry();
  };

  const answer = (commandId: string, result: Answer) => {
    const waiting = waiters.get(commandId);
    waiters.delete(commandId);
    for (const resolve of waiting ?? []) resolve(result);
  };

  const failure = (commandId: string | null, code: DispatchFailureCode, message: string, extra: Partial<DispatchFailure> = {}): Answer => ({
    ok: false,
    commandId,
    error: { code, message, ...extra },
  });

  /**
   * Writes the entries still waiting, after the writes before it; nothing
   * when the document is not this build's or the environment was forgotten,
   * whose document is deleted: a late caller finds no sender, and none is
   * made for it, so nothing is written back.
   */
  const persist = (environmentId: string): Promise<void> => {
    const sender = senders.get(environmentId);
    if (!sender) return Promise.resolve();
    sender.writes = sender.writes
      .then(async () => {
        if (sender.forgotten || sender.unreadable) return;
        const { entries } = outboxOf(environmentId);
        if (entries.length === 0) await documents.delete(outboxDocument(environmentId));
        else await documents.set(outboxDocument(environmentId), encodeOutbox(entries));
      })
      .catch(report);
    return sender.writes;
  };

  const nameOf = (environmentId: string) => host.record(environmentId)?.descriptor.name ?? "the environment";

  const forgottenAnswer = (commandId: string, environmentId: string): Answer =>
    failure(commandId, "forgotten", `${nameOf(environmentId)} was removed from this client, and its outbox with it.`);

  /** What a notice calls the entry's target: its title or name as the list confirms it now, else as it was when dispatched. */
  const labelOf = (entry: OutboxEntry): string => {
    const data = host.lists.read().get(entry.environmentId)?.data;
    const { target } = entry;
    if (target?.kind === "session") return data?.sessions.get(target.id)?.title ?? entry.label ?? "a session";
    if (target?.kind === "group") return data?.groups.get(target.id)?.name ?? entry.label ?? "a group";
    return nameOf(entry.environmentId);
  };

  /** Takes the entry and its overlay out of the outbox. */
  const remove = (entry: OutboxEntry, keepOverlay?: (overlay: OverlayRecord) => OverlayRecord) =>
    change(entry.environmentId, (current) => ({
      entries: current.entries.filter((e) => e.commandId !== entry.commandId),
      overlays: current.overlays.flatMap((o) => (o.commandId !== entry.commandId ? [o] : keepOverlay ? [keepOverlay(o)] : [])),
    }));

  /** Drops overlays whose receipt's sequence the list's cursor has reached. */
  const settleOverlays = (environmentId: string) => {
    const cursor = host.lists.read().get(environmentId)?.cursor ?? null;
    const { overlays } = outboxOf(environmentId);
    if (cursor === null || !overlays.some((o) => o.sequence !== null && o.sequence <= cursor)) return;
    change(environmentId, (current) => ({ ...current, overlays: current.overlays.filter((o) => o.sequence === null || o.sequence > cursor) }));
  };

  /** The entry leaves the outbox refused: its overlay goes, one notice says why, and its caller hears it. */
  const fail = (entry: OutboxEntry, error: DispatchFailure) => {
    const label = labelOf(entry);
    remove(entry);
    notices.raise(entry.environmentId, {
      kind: "command-rejected",
      message: `${verbOf(entry.method)} on ${label} was rejected: ${reasonOf(error.code, error.data)}.`,
      action: null,
    });
    answer(entry.commandId, failure(entry.commandId, error.code, error.message, error));
  };

  /** The entry leaves the outbox unsent: seven days old. */
  const expire = (entry: OutboxEntry) => {
    const label = labelOf(entry);
    remove(entry);
    notices.raise(entry.environmentId, {
      kind: "command-dropped",
      message: `${verbOf(entry.method)} on ${label} was dropped: it could not reach ${nameOf(entry.environmentId)} within seven days.`,
      action: null,
    });
    answer(entry.commandId, failure(entry.commandId, "expired", "The command could not reach its environment within seven days, so it was dropped."));
  };

  const scheduleExpiry = () => {
    let due: number | undefined;
    for (const { entries } of view.read().values()) {
      for (const entry of entries) {
        const at = Date.parse(entry.createdAt) + COMMAND_EXPIRY_MS;
        if (due === undefined || at < due) due = at;
      }
    }
    if (sweeping || expiry?.due === due) return;
    expiry?.timer.cancel();
    expiry = undefined;
    if (due === undefined || closed) return;
    const timer = clock.setTimeout(sweep, Math.max(0, due - clock.now().getTime()));
    expiry = { due, timer };
  };

  /** Drops every entry seven days old. */
  function sweep() {
    expiry?.timer.cancel();
    expiry = undefined;
    sweeping = true;
    const cutoff = clock.now().getTime() - COMMAND_EXPIRY_MS;
    const touched = new Set<string>();
    for (const [environmentId, { entries }] of view.read()) {
      for (const entry of entries) {
        if (Date.parse(entry.createdAt) > cutoff) continue;
        expire(entry);
        touched.add(environmentId);
      }
    }
    for (const environmentId of touched) void persist(environmentId);
    sweeping = false;
    scheduleExpiry();
  }

  /** A `runs:drive` command never queues: one still waiting its turn when the socket goes fails `unreachable`. */
  const failWaitingRuns = (environmentId: string) => {
    const waiting = outboxOf(environmentId).entries.filter((entry) => entry.state === "queued" && registry[entry.method].scope === "runs:drive");
    if (waiting.length === 0) return;
    for (const entry of waiting) {
      remove(entry);
      answer(entry.commandId, failure(entry.commandId, "unreachable", `${nameOf(environmentId)} could not be reached before the command was sent; run commands never queue.`));
    }
    void persist(environmentId);
  };

  /**
   * A `runs:drive` command in flight when the client session changed: the
   * environment would run a retry under the new one again (a message sent
   * twice), so it leaves unsent, and a notice says it may not have applied.
   */
  const unconfirmed = (entry: OutboxEntry) => {
    const label = labelOf(entry);
    const name = nameOf(entry.environmentId);
    remove(entry);
    notices.raise(entry.environmentId, {
      kind: "command-dropped",
      message: `${verbOf(entry.method)} on ${label} was dropped: it was sent before this client reconnected to ${name} as a new client session, so whether it applied is not known, and it is not sent again.`,
      action: null,
    });
    answer(entry.commandId, failure(entry.commandId, "unconfirmed", `It was sent before this client reconnected to ${name} as a new client session, which would run it again; it may or may not have applied.`));
  };

  /** Sends the environment's next entry, if its socket is ready and nothing is under way. */
  const kick = (environmentId: string): void => {
    const sender = senders.get(environmentId);
    if (!sender || closed || !sender.ready || !sender.isLoaded || sender.sending !== null || sender.stalled) return;
    const next = outboxOf(environmentId).entries.find((entry) => entry.state === "queued" || entry.state === "in-flight");
    if (!next) return;
    // The socket's own client session, from its hello: the record is written from the same hello, but after the ready seam fires.
    const session = sender.session;
    if (next.state === "in-flight" && next.sentOn !== session && registry[next.method].scope === "runs:drive") {
      unconfirmed(next);
      void persist(environmentId);
      return kick(environmentId);
    }
    const sending: OutboxEntry = { ...next, state: "in-flight", attempts: next.attempts + 1, sentOn: session };
    change(environmentId, (current) => ({ ...current, entries: current.entries.map((e) => (e.commandId === next.commandId ? sending : e)) }));
    sender.sending = next.commandId;
    void persist(environmentId);
    let request: Promise<ResponseFrame>;
    try {
      request = host.seams.request(environmentId, next.method, { ...next.params, commandId: next.commandId });
    } catch (error) {
      request = Promise.reject(error);
    }
    request.then(
      (response) => answered(environmentId, next.commandId, response),
      (error: unknown) => lost(environmentId, next.commandId, error),
    );
  };

  /**
   * A command whose request failed for another reason than its socket (the
   * platform's socket refused the frame): whether it went is not known, and
   * it would fail the same way again, so it leaves unsent, a notice says it
   * may not have applied, and the queue moves on.
   */
  const unsendable = (entry: OutboxEntry, error: unknown) => {
    const label = labelOf(entry);
    const name = nameOf(entry.environmentId);
    const why = error instanceof Error ? error.message : String(error);
    remove(entry);
    notices.raise(entry.environmentId, {
      kind: "command-dropped",
      message: `${verbOf(entry.method)} on ${label} was dropped: sending it to ${name} failed (${why}), so whether it applied is not known, and it is not sent again.`,
      action: null,
    });
    answer(entry.commandId, failure(entry.commandId, "unconfirmed", `Sending it to ${name} failed: ${why}. It may or may not have applied.`));
  };

  /**
   * The request failed. With its socket: the entry stays in flight, and the
   * next ready sends it again with its id. Otherwise the fault is reported
   * and the entry is dropped `unconfirmed` (`unsendable`), so it does not
   * hold the environment's queue on a socket that stays ready.
   */
  const lost = (environmentId: string, commandId: string, error: unknown) => {
    const sender = senders.get(environmentId);
    const current = sender?.sending === commandId;
    if (sender && current) sender.sending = null;
    if (error instanceof SocketClosedError || error instanceof NotConnectedError) return;
    report(error);
    const entry = current ? outboxOf(environmentId).entries.find((e) => e.commandId === commandId) : undefined;
    if (!entry) return;
    unsendable(entry, error);
    void persist(environmentId);
    kick(environmentId);
  };

  /**
   * A retry refused for what its own earlier attempt did: a create answered
   * `exists`, a delete or purge answered `not_found`. The environment keys
   * receipts by client session, so a retry under another one (the local
   * connection's is new on every start; a re-pair makes a new one) is run
   * again rather than answered from the receipt. The command's intent holds,
   * so it counts as accepted, changing nothing.
   */
  const ownEarlierAttempt = (entry: OutboxEntry, receipt: RejectedReceipt) => {
    if (entry.attempts < 2) return false;
    if (entry.method === "groups.create" || entry.method === "sessions.create") return receipt.reason === "conflict" && receipt.error.data?.["reason"] === "exists";
    return (entry.method === "sessions.delete" || entry.method === "sessions.purge" || entry.method === "groups.delete") && receipt.reason === "not_found";
  };

  const answered = (environmentId: string, commandId: string, response: ResponseFrame) => {
    const sender = senders.get(environmentId);
    if (sender?.sending === commandId) sender.sending = null;
    const entry = outboxOf(environmentId).entries.find((e) => e.commandId === commandId);
    // Dropped meanwhile (forgotten, expired): nothing waits for it.
    if (!entry) return kick(environmentId);
    const spec = registry[entry.method];
    if (response.error) {
      if (response.error.code === "unavailable" && spec.scope === "sessions:write") {
        // The environment cannot take it yet: it is sent again on the next ready.
        if (sender) sender.stalled = true;
        return;
      }
      fail(entry, { code: response.error.code, message: response.error.message, data: response.error.data });
    } else {
      const parsed = isCommand(spec) ? spec.response.safeParse(response.result) : undefined;
      if (!parsed?.success) {
        fail(entry, { code: "malformed", message: `The environment's answer to ${entry.method} is not the method's.` });
      } else {
        const { receipt, result } = parsed.data as { receipt: CommandReceipt; result?: unknown };
        if (receipt.status === "accepted") acknowledge(entry, receipt, result);
        else if (ownEarlierAttempt(entry, receipt)) acknowledge(entry, { status: "accepted", sequence: receipt.sequence, changed: false }, undefined);
        else fail(entry, { code: receipt.reason, message: receipt.error.message, data: receipt.error.data, receipt });
      }
    }
    void persist(environmentId);
    kick(environmentId);
  };

  /** Accepted: the entry leaves, its overlay stays until the list's cursor reaches the receipt's sequence. */
  const acknowledge = (entry: OutboxEntry, receipt: AcceptedReceipt, result: unknown) => {
    remove(entry, (overlay) => ({ ...overlay, sequence: receipt.sequence }));
    settleOverlays(entry.environmentId);
    answer(entry.commandId, { ok: true, commandId: entry.commandId, receipt, ...(result !== undefined && { result: result as ResultOf<CommandMethodName> }) });
  };

  const load = (environmentId: string): Promise<void> => {
    const sender = senderOf(environmentId);
    return (sender.loaded ??= (async () => {
      let stored: unknown;
      try {
        stored = await documents.get(outboxDocument(environmentId));
      } catch (error) {
        // Unread, it is not written over: whatever it holds stays for a start that reads it.
        report(error);
        sender.unreadable = true;
      }
      // Removed while it was read: what it held went with the environment, and nothing comes back.
      if (sender.forgotten) return;
      const decoded = sender.unreadable ? undefined : decodeOutbox(stored, environmentId);
      if (decoded && !decoded.readable) {
        report(new Error(decoded.why));
        sender.unreadable = true;
      }
      const entries = decoded?.readable ? decoded.entries : [];
      if (decoded?.readable && decoded.skipped > 0) report(new Error(`${decoded.skipped} entries of the outbox of ${environmentId} could not be read and were dropped.`));
      // A run command kept but never sent (the runtime ended first) does not wait for a later start: it never queues.
      const unsent = entries.filter((entry) => entry.state === "queued" && registry[entry.method].scope === "runs:drive");
      const kept = entries.filter((entry) => !unsent.includes(entry));
      if (kept.length > 0 || unsent.length > 0) {
        change(environmentId, (current) => ({
          entries: [...kept, ...current.entries],
          overlays: [...kept.flatMap((entry) => (entry.overlay ? [{ commandId: entry.commandId, change: entry.overlay, sequence: null }] : [])), ...current.overlays],
        }));
      }
      for (const entry of unsent) {
        notices.raise(environmentId, {
          kind: "command-dropped",
          message: `${verbOf(entry.method)} on ${entry.label ?? nameOf(environmentId)} was dropped: this client closed before ${nameOf(environmentId)} answered it, and run commands never queue, so it may not have applied.`,
          action: null,
        });
      }
      sender.isLoaded = true;
      if (decoded?.readable && (decoded.skipped > 0 || unsent.length > 0)) void persist(environmentId);
      sweep();
      kick(environmentId);
    })().catch(report));
  };

  const prepare = (environmentId: string, method: CommandMethodName, params: Readonly<Record<string, unknown>>): Prepared => {
    if (closed) return { refused: failure(null, "closed", "The client runtime is closed.") };
    const spec = isMethodName(method) ? registry[method] : undefined;
    if (!spec || !isCommand(spec)) return { refused: failure(null, "unsupported", `${method} is not a command.`) };
    if (!queuedScope(spec.scope)) {
      return { refused: failure(null, "direct", `${method} is a ${spec.scope} call: a direct request through requests.call, never queued.`) };
    }
    const record = host.record(environmentId);
    if (!record || record.environmentId === LOCAL_PLACEHOLDER_ID) {
      return { refused: failure(null, "unreachable", "This client has no connection to that environment.") };
    }
    const commandId = uuidv7(clock.now());
    const checked = spec.params.safeParse({ ...params, commandId });
    if (!checked.success) {
      return { refused: failure(null, "invalid_params", `The params are not ${method}'s: ${checked.error.issues.map((i) => i.message).join("; ")}`) };
    }
    const name = record.descriptor.name;
    if (!record.scopes.includes(spec.scope)) return { refused: failure(null, "scope", `This client was paired with ${name} without the ${spec.scope} scope.`) };
    const flag = METHOD_FLAGS[method];
    if (flag !== undefined && !record.descriptor.capabilities.includes(flag)) {
      return { refused: failure(null, "unsupported", `${name} does not offer ${flag}; a version that does is needed.`) };
    }
    if (spec.scope === "runs:drive") {
      // Run commands never queue: the connection must be ready now.
      const capability = answerCapability(method, record, undefined);
      if (capability.status === "absent") return { refused: failure(null, capability.reason === "not-ready" ? "unreachable" : capability.reason, capability.message) };
    }
    // Kept without its command id, which every attempt adds back as it was minted.
    const stored: Record<string, unknown> = { ...(checked.data as Record<string, unknown>) };
    delete stored["commandId"];

    const keep = (sender: Sender) => {
      sender.keeping.delete(commandId);
      // Removed while the command waited on the outbox's read: nothing is kept for an environment the client no longer has.
      if (sender.forgotten || !host.record(environmentId)) return answer(commandId, forgottenAnswer(commandId, environmentId));
      if (closed) return answer(commandId, failure(commandId, "closed", "The client runtime closed before the command was kept."));
      const shown = host.shown(environmentId);
      const target = targetOf(method, stored);
      const entry: OutboxEntry = {
        commandId,
        environmentId,
        method,
        params: stored,
        target,
        createdAt: clock.now().toISOString(),
        attempts: 0,
        sentOn: null,
        state: "queued",
        overlay: spec.scope === "sessions:write" ? overlayOf(method, stored, shown, host.now(environmentId).toISOString()) : null,
        label: labelAtDispatch(method, stored, target, shown),
      };
      const kind = (SESSION_WRITE_COMMANDS as Readonly<Record<string, (typeof SESSION_WRITE_COMMANDS)[SessionWriteMethodName]>>)[method];
      const queue = outboxOf(environmentId).entries;
      const replaced =
        kind !== undefined && "setter" in kind
          ? queue.filter((e) => e.state === "queued" && e.method === method && sameTarget(e.target, target))
          : [];
      const gone = new Set(replaced.map((e) => e.commandId));
      change(environmentId, (current) => ({
        entries: [...current.entries.filter((e) => !gone.has(e.commandId)), entry],
        overlays: [
          ...current.overlays.filter((o) => !gone.has(o.commandId)),
          ...(entry.overlay ? [{ commandId, change: entry.overlay, sequence: null }] : []),
        ],
      }));
      // A replaced command's caller hears what becomes of the one that replaced it.
      for (const { commandId: old } of replaced) {
        const waiting = waiters.get(old) ?? [];
        waiters.delete(old);
        waiters.set(commandId, [...(waiters.get(commandId) ?? []), ...waiting]);
      }
      void persist(environmentId).then(() => kick(environmentId));
    };

    return {
      commandId,
      enqueue() {
        const result = new Promise<Answer>((resolve) => waiters.set(commandId, [...(waiters.get(commandId) ?? []), resolve]));
        const sender = senderOf(environmentId);
        // Kept at once when the outbox is read, so its effect shows in the same step; else once it is.
        if (sender.isLoaded) keep(sender);
        else {
          sender.keeping.add(commandId);
          void load(environmentId).then(() => keep(sender));
        }
        return result;
      },
    };
  };

  const dispatch = <N extends CommandMethodName>(environmentId: string, method: N, params: CommandParams<N>): Promise<DispatchAnswer<N>> => {
    const prepared = prepare(environmentId, method, params as Readonly<Record<string, unknown>>);
    return ("refused" in prepared ? Promise.resolve(prepared.refused) : prepared.enqueue()) as Promise<DispatchAnswer<N>>;
  };

  const stopReady = host.seams.onReady((environmentId, hello) => {
    const sender = senderOf(environmentId);
    // A new socket: whatever was under way went with the old one, and stays in flight to be sent again.
    sender.ready = true;
    sender.session = hello.clientSessionId;
    sender.sending = null;
    sender.stalled = false;
    void load(environmentId).then(() => kick(environmentId));
  });

  const stopRecords = host.records.subscribe((records) => {
    for (const [environmentId, sender] of senders) {
      if (!sender.ready || reachable(records.find((record) => record.environmentId === environmentId))) continue;
      sender.ready = false;
      failWaitingRuns(environmentId);
    }
  });

  const stopLists = host.lists.subscribe((lists) => {
    for (const environmentId of lists.keys()) settleOverlays(environmentId);
  });

  const stopForget = host.seams.onForget(async (environmentId) => {
    const sender = senders.get(environmentId);
    senders.delete(environmentId);
    const { entries } = outboxOf(environmentId);
    const keeping = [...(sender?.keeping ?? [])];
    if (sender) {
      sender.forgotten = true;
      sender.keeping.clear();
    }
    change(environmentId, () => EMPTY);
    // What was kept, and what still waited on the read to be kept.
    for (const commandId of [...entries.map((entry) => entry.commandId), ...keeping]) answer(commandId, forgottenAnswer(commandId, environmentId));
    await sender?.writes;
    await documents.delete(outboxDocument(environmentId)).catch(report);
  });

  return {
    view,
    dispatch,
    moveToGroup(environmentId, sessionId, groupName) {
      if (groupName === null) return dispatch(environmentId, "sessions.setGroup", { sessionId, groupId: null });
      const name = normaliseGroupName(groupName);
      const held = [...(host.shown(environmentId)?.groups.values() ?? [])].find((group) => groupNameKey(group.name) === groupNameKey(name));
      if (held) return dispatch(environmentId, "sessions.setGroup", { sessionId, groupId: held.id });
      const groupId = uuidv4();
      const create = prepare(environmentId, "groups.create", { id: groupId, name });
      if ("refused" in create) return Promise.resolve(create.refused as DispatchAnswer<"sessions.setGroup">);
      const move = prepare(environmentId, "sessions.setGroup", { sessionId, groupId });
      if ("refused" in move) return Promise.resolve(move.refused as DispatchAnswer<"sessions.setGroup">);
      // In this order, so the create is sent first; the move is answered, the create's answer is its notice if refused.
      void create.enqueue();
      return move.enqueue() as Promise<DispatchAnswer<"sessions.setGroup">>;
    },
    async load(environmentIds) {
      await Promise.all(environmentIds.map(load));
    },
    applied(environmentId, event) {
      const commandId = event.commandId?.toLowerCase();
      if (commandId === undefined || !outboxOf(environmentId).overlays.some((o) => o.commandId === commandId)) return;
      change(environmentId, (current) => ({ ...current, overlays: current.overlays.filter((o) => o.commandId !== commandId) }));
    },
    async close() {
      // A command kept after a read still under way is kept before the close: its read's continuation runs first.
      await Promise.all([...senders.values()].map((sender) => sender.loaded));
      closed = true;
      stopReady();
      stopRecords();
      stopLists();
      stopForget();
      expiry?.timer.cancel();
      expiry = undefined;
      for (const commandId of [...waiters.keys()]) {
        answer(commandId, failure(commandId, "closed", "The client runtime closed first; the command stays in the outbox and is sent after the next start."));
      }
      await Promise.all([...senders.values()].map((sender) => sender.writes));
    },
  };
};
