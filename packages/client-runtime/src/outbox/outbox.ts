import {
  MAX_DRAFT_LENGTH,
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
  type WorkspaceRequest,
} from "@agent-harness/contracts";
import { answerCapability, answerQueuedCommand, type AbsentReason, type CapabilityAnswer } from "../capabilities.js";
import { SocketClosedError } from "../connections/connection.js";
import { LOCAL_PLACEHOLDER_ID, type ConnectionRecord } from "../connections/records.js";
import { NotConnectedError, type ConnectionSeams } from "../connections/registry.js";
import { uuidv4, uuidv7 } from "../ids.js";
import type { Notices } from "../notices.js";
import { writable, type Observable } from "../observable.js";
import type { Clock, DocumentStore, Timer } from "../platform.js";
import type { BrowserChip } from "../projections/new-session.js";
import type { SessionRunsView } from "../projections/runs.js";
import type { SessionProjection } from "../projections/session.js";
import type { VerbReason } from "../projections/verbs.js";
import type { ListData } from "../streams/kinds.js";
import type { StreamState } from "../streams/stream.js";
import { decodeOutbox, encodeOutbox, outboxDocument, type OutboxEntry } from "./entries.js";
import { reachable, type EnvironmentOutbox, type OutboxView, type OverlayRecord } from "./overlay.js";
import { overlayOf, reasonOf, routineOf, targetOf, verbOf, type Target } from "./rules.js";
import { createStopFirst } from "./stop-first.js";

export { STOP_WAIT_MS } from "./stop-first.js";

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
 *   command id applies first) and, for a session the runtime holds a stream
 *   of, that stream's cursor reaches it too: the session's projection reads
 *   its own stream, which can apply the event after the list (#1767). A
 *   rejection removes the entry and its
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
  /**
   * Whether `dispatch` would keep the command now, as it checks it: a
   * connection to the environment with the command's scope and the flag
   * gating it, whatever the phase for a `sessions:write` command, which
   * waits in the outbox while the environment cannot be reached; for a
   * `runs:drive` command, which never waits, the environment reachable now
   * too; an `admin` one, a direct request, as `capability` answers it. A
   * renderer draws a command dim with the answer's line while it is absent.
   */
  admits(environmentId: string, method: CommandMethodName): CapabilityAnswer;
  /**
   * Rewinds a session to one of its user messages (ADR 0022):
   * `sessions.rewind`, once the drafts still waiting their second are sent,
   * so the draft the rewind writes lands after what was typed; and when the
   * environment refuses it
   * `use_new_session` (the session's first message, with nothing before it
   * to go back to), a new session in the same workspace with the message's
   * text as its draft: `sessions.create` with a client-minted id and a
   * `session` request naming the rewound session, so the environment shares
   * its workspace, kind, path and identity (#325), then, once the
   * environment has accepted it, `sessions.setDraft` (none for an empty
   * text). Answers the new session's id with the create's answer; the
   * refusal it answers raises no notice, a create the environment refuses
   * leaves its own, and a draft refused leaves its own. It answers the
   * rewind's own answer, with its notice, for any other refusal, and for
   * this one when it cannot start a session: the message not held, or the
   * connection without the scope (or flag) the create or the draft needs.
   *
   * With `stopFirst` (#390), a run live on the session is stopped first:
   * `runs.interrupt`, then the rewind above once the run is no longer live,
   * waiting at most `STOP_WAIT_MS` after the interrupt was accepted
   * (`onStopping` is called then, with the run's id), else it gives up,
   * having rewound nothing. It is refused at once, dispatching nothing,
   * while messages are queued or while the run is only starting, with no id
   * to interrupt (`stopFirstOffer`); with no run live it is the rewind above.
   */
  rewind(environmentId: string, sessionId: string, messageId: string, options?: RewindOptions): Promise<RewindAnswer>;
  /**
   * Forks a session (ADR 0022; #390): `sessions.fork` through the outbox with
   * a client-minted id, taken before the user message `anchor` (the whole
   * session without one), onto `account` (the source's without one), titled
   * `title` (the source's title carried without one). Answers the fork's id
   * with the fork's answer; a refused fork raises its notice as any refused
   * command does. The environment writes an anchored fork's draft, the
   * message's text, including an inherited anchor (#273). Once an unanchored
   * hand-off is accepted, the source's current draft, as this client shows
   * it when asked (one still waiting its second included), is sent as the
   * fork's (`sessions.setDraft`) when nonempty.
   */
  fork(environmentId: string, sessionId: string, options?: ForkOptions): Promise<ForkAnswer>;
  /**
   * Starts a session on the environment from the new-session card's choice
   * (workspace-picker spec, "The picker in the client runtime"): with a
   * `groupName` (the focused merged heading's), `groups.create` first with a
   * client-minted id when the environment has no group of that name, as
   * `moveToGroup` does; then `sessions.create` with a client-minted id, in
   * that group; then, once the environment has accepted it,
   * `connections.setLastUsed`. The browser chip goes with the create as
   * the session's first browser, chosen by the reach default while the
   * chip holds its preset and by a person once it was changed; a chip
   * holding none sends nothing. Answers the new session's id with the
   * create's answer, a refusal with its reason and data (a workspace's
   * `problem`, a worktree's branch reason); a group create refused leaves its
   * notice and the create its own. The renderer sends the first message once
   * the answer is ok.
   */
  startSession(environmentId: string, choice: StartSessionChoice): Promise<StartSessionAnswer>;
}

/** What the new-session card chose: the workspace request, and each other part only when set. */
export interface StartSessionChoice {
  /**
   * The session's id, minted by the renderer: one that shows what the id
   * names before the session exists (a new worktree branch's preset name,
   * `agent-harness/` and its first eight characters). A fresh version 4 UUID
   * when absent. A create refused leaves it unused, so the card may send it
   * again.
   */
  readonly id?: string;
  readonly workspace: WorkspaceRequest;
  /** The account the session's runs use; the environment's default at each run without one. */
  readonly account?: string;
  /** The model the session's runs use; the account's default without one. */
  readonly model?: string;
  /** The name of the merged heading in focus: the session goes into the environment's group of that name (names equal ignoring case and white space), made first when it has none. */
  readonly groupName?: string;
  /** The browser chip (`projections.newSession`'s `browser`): its value, and why it holds it. */
  readonly browser?: Pick<BrowserChip, "value" | "reason">;
}

/** What `commands.startSession` did: the id minted for the session, with the create's answer. The session stands only when that answer is ok. */
export interface StartSessionAnswer {
  readonly sessionId: string;
  readonly answer: DispatchAnswer<"sessions.create">;
}

/** How `commands.rewind` goes about it. */
export interface RewindOptions {
  /** Stop the live run first (`runs.interrupt`), then rewind once it is over. */
  readonly stopFirst?: boolean;
  /** Called once the stop-first form's interrupt is accepted, with the run it stopped, while the rewind waits for it to end. */
  readonly onStopping?: (runId: string) => void;
}

/** What `commands.fork` makes: each part optional. */
export interface ForkOptions {
  /** The user message of the source the fork is taken before; the whole session without one. */
  readonly anchor?: string;
  /** The account the fork's runs use, one the environment holds and is signed in; the source's without one. */
  readonly account?: string;
  /** The fork's user title; the source's title is carried as its generated title without one. */
  readonly title?: string;
}

/** What `commands.fork` did: the id minted for the fork, with the fork's answer. The session stands only when that answer is ok. */
export interface ForkAnswer {
  readonly sessionId: string;
  readonly answer: DispatchAnswer<"sessions.fork">;
}

/**
 * What `commands.rewind` did. The `rewind` kind is the rewind's own answer; a `use_new_session` refusal stays here
 * only when the runtime could not attempt a session for it (the message not held, or `prepare`
 * refusing the create locally). The `new-session` kind is every attempted create, carrying the create's own answer:
 * the session stands only when that answer is ok, and a refused create names an id no session has.
 */
export type RewindAnswer =
  | { readonly kind: "rewind"; readonly answer: DispatchAnswer<"sessions.rewind"> }
  | { readonly kind: "new-session"; readonly sessionId: string; readonly answer: DispatchAnswer<"sessions.create"> }
  /** The stop-first form, refused at once with nothing dispatched: messages queued, a run starting with no id to interrupt, or the rewind's own reason. */
  | { readonly kind: "refused"; readonly reason: VerbReason; readonly message: string }
  /** The stop-first form's interrupt, refused (with its notice, or at once): nothing was rewound. */
  | { readonly kind: "interrupt"; readonly answer: Extract<DispatchAnswer<"runs.interrupt">, { readonly ok: false }> }
  /** The stop-first form gave up: the run it stopped was still live `STOP_WAIT_MS` after the interrupt was accepted, and nothing was rewound. */
  | { readonly kind: "gave-up"; readonly runId: string };

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
  /** The cursor of the session's own stream while the runtime holds one; null when none is held or it holds nothing yet. */
  sessionCursor(environmentId: string, sessionId: string): number | null;
  /** The environment's list as it shows now, overlay and all: what a command's optimistic change is reckoned against. */
  shown(environmentId: string): ListData | null;
  /** The name of routine `routineId` (in lowercase) as the environment last listed it (the request cache's `routines.list`), read without fetching; null when it is not held. */
  routineName(environmentId: string, routineId: string): string | null;
  /** The environment accepted a `routines.create`, told before its entry leaves: `projections.routines` shows it until the environment's list does (#910). */
  routineCreated(environmentId: string, params: CommandParams<"routines.create">): void;
  /** The environment's time now. */
  now(environmentId: string): Date;
  /** What the runtime holds of a session, read without subscribing anything: its transcript, runs and draft. */
  held(environmentId: string, sessionId: string): SessionProjection;
  /** One session's run state, queue and verbs (`projections.runs.session`): what the stop-first rewind reads and waits on. */
  sessionRuns(environmentId: string, sessionId: string): Observable<SessionRunsView>;
  /** Sends every draft still waiting its second (`drafts.flush`). */
  flushDrafts(): void;
  /** Notes the environment last used (`connections.setLastUsed`): a session was started there. */
  setLastUsed(environmentId: string): Promise<void>;
}

export interface Outbox extends Commands {
  /** Waits for loading and every queued durable write without stopping dispatch. */
  checkpoint(): Promise<void>;
  readonly view: Observable<OutboxView>;
  /** Reads the outboxes of these environments: before their connections start. */
  load(environmentIds: readonly string[]): Promise<void>;
  /** An event applied to an environment's list: an overlay of the command it names leaves, once its session's own stream has it too. */
  applied(environmentId: string, event: EventEnvelope): void;
  /** An event applied to a session's own stream: an overlay waiting on that stream may leave. */
  sessionApplied(environmentId: string): void;
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

/**
 * Whether the connection `record` takes the command now (`commands.admits`):
 * the scope and the flag whatever the phase for a `sessions:write` command,
 * which queues; the connection ready now too for a `runs:drive` one, which
 * never does; `capability`'s answer for any other, a direct request.
 */
const admission = (method: CommandMethodName, record: ConnectionRecord | undefined): CapabilityAnswer => {
  const { scope } = registry[method];
  if (!queuedScope(scope)) return answerCapability(method, record, undefined);
  const admitted = answerQueuedCommand(method, record);
  return admitted.status === "absent" || scope !== "runs:drive" ? admitted : answerCapability(method, record, undefined);
};

/** What a notice will call the command's target: its title or name as the list shows it now; what a create names. */
const labelAtDispatch = (method: string, params: Readonly<Record<string, unknown>>, target: Target | null, shown: ListData | null): string | null => {
  if (method === "sessions.create") return typeof params["title"] === "string" ? params["title"] : "a new session";
  if (method === "groups.create") return typeof params["name"] === "string" ? normaliseGroupName(params["name"]) : null;
  if (method === "routines.create") return (params["definition"] as ParamsOf<"routines.create">["definition"]).name;
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
  /**
   * Refusals a composed command answers itself, by the command id they would
   * refuse: such a refusal raises no notice, but leaves the notice it would
   * have raised (`notice`) for the composed command to raise when it cannot
   * answer it after all.
   */
  const answeredByCaller = new Map<string, { readonly answers: (error: DispatchFailure) => boolean; notice?: () => void }>();

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

  /**
   * What a notice calls the entry's target: its title or name as the list confirms it now, else as it was when dispatched;
   * a routine's name as last listed, else as its create named it; else the environment's name (an import making routines).
   */
  const labelOf = (entry: OutboxEntry): string => {
    const data = host.lists.read().get(entry.environmentId)?.data;
    const { target } = entry;
    if (target?.kind === "session") return data?.sessions.get(target.id)?.title ?? entry.label ?? "a session";
    if (target?.kind === "group") return data?.groups.get(target.id)?.name ?? entry.label ?? "a group";
    const routineId = routineOf(entry.method, entry.params);
    if (routineId !== null) return host.routineName(entry.environmentId, routineId) ?? entry.label ?? nameOf(entry.environmentId);
    return nameOf(entry.environmentId);
  };

  /** Takes the entry and its overlay out of the outbox. */
  const remove = (entry: OutboxEntry, keepOverlay?: (overlay: OverlayRecord) => OverlayRecord) =>
    change(entry.environmentId, (current) => ({
      entries: current.entries.filter((e) => e.commandId !== entry.commandId),
      overlays: current.overlays.flatMap((o) => (o.commandId !== entry.commandId ? [o] : keepOverlay ? [keepOverlay(o)] : [])),
    }));

  /** Whether an overlay can leave: the list's cursor has reached its sequence, and so has its session's own stream when one is held. */
  const settledIn = (environmentId: string) => {
    const cursor = host.lists.read().get(environmentId)?.cursor ?? null;
    return (o: OverlayRecord): boolean => {
      if (cursor === null || o.sequence === null || o.sequence > cursor) return false;
      const own = o.change.target.kind === "session" ? host.sessionCursor(environmentId, o.change.target.id) : null;
      return own === null || o.sequence <= own;
    };
  };

  /** Drops the overlays that can leave. */
  const settleOverlays = (environmentId: string) => {
    const settled = settledIn(environmentId);
    if (!outboxOf(environmentId).overlays.some(settled)) return;
    change(environmentId, (current) => ({ ...current, overlays: current.overlays.filter((o) => !settled(o)) }));
  };

  /**
   * The entry leaves the outbox refused: its overlay goes, one notice says
   * why unless a composed command answers the refusal itself (which is left
   * the notice to raise if it cannot), and its caller hears it.
   */
  const fail = (entry: OutboxEntry, error: DispatchFailure) => {
    const label = labelOf(entry);
    remove(entry);
    const raise = () =>
      notices.raise(entry.environmentId, {
        kind: "command-rejected",
        message: `${verbOf(entry.method)} on ${label} was rejected: ${reasonOf(error.code, error.data, entry.target)}.`,
        action: null,
      });
    const caller = answeredByCaller.get(entry.commandId);
    if (caller?.answers(error) === true) caller.notice = raise;
    else raise();
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
    if (entry.method === "groups.create" || entry.method === "sessions.create" || entry.method === "routines.create") {
      return receipt.reason === "conflict" && receipt.error.data?.["reason"] === "exists";
    }
    return (entry.method === "sessions.delete" || entry.method === "sessions.purge" || entry.method === "groups.delete" || entry.method === "routines.delete") && receipt.reason === "not_found";
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
    if (entry.method === "routines.create") host.routineCreated(entry.environmentId, entry.params as CommandParams<"routines.create">);
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
    // The scope and the flag, whatever the phase: a sessions:write command queues; a runs:drive one needs the connection ready now.
    const admitted = admission(method, record);
    if (admitted.status === "absent") return { refused: failure(null, admitted.reason === "not-ready" ? "unreachable" : admitted.reason, admitted.message) };
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
      const routineId = routineOf(method, stored);
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
        label: labelAtDispatch(method, stored, target, shown) ?? (routineId === null ? null : host.routineName(environmentId, routineId)),
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

  /** The text of a user message of a session the runtime holds, as its transcript shows it; null when it is not held. */
  const messageText = (environmentId: string, sessionId: string, messageId: string): string | null => {
    const message = host.held(environmentId, sessionId).items.find((item) => item.kind === "user-message" && item.messageId.toLowerCase() === messageId.toLowerCase());
    return message?.kind === "user-message" ? message.text : null;
  };

  /** The session's draft as this client shows it, including one still waiting its second. */
  const handOffDraft = (environmentId: string, sessionId: string): string | null => {
    const held = host.held(environmentId, sessionId);
    // The list's, which lays a waiting draft over as the held session's does; the held session's only for one the list lacks.
    const listed = host.shown(environmentId)?.sessions.get(sessionId.toLowerCase());
    const own = listed !== undefined ? listed.draft : held.draft;
    return own !== null && own.length > 0 ? own : null;
  };

  const rewind = async (environmentId: string, sessionId: string, messageId: string): Promise<RewindAnswer> => {
    // Read now: the session's transcript may move on while the rewind is under way.
    const text = messageText(environmentId, sessionId, messageId);
    // What was typed goes first, so the draft the rewind writes lands after it, and an undo can put it back (#232).
    host.flushDrafts();
    const rewound = prepare(environmentId, "sessions.rewind", { sessionId, messageId });
    if ("refused" in rewound) return { kind: "rewind", answer: rewound.refused as DispatchAnswer<"sessions.rewind"> };
    const startsOver = (error: DispatchFailure) => error.code === "conflict" && error.data?.["reason"] === "use_new_session";
    // The refusal is answered here only when a new session can be started from it: the message is held, and
    // the connection admits the create and the draft. Else it is the caller's, with its notice.
    const record = host.record(environmentId);
    const admitted = ["sessions.create", "sessions.setDraft"].every((method) => answerQueuedCommand(method as CommandMethodName, record).status === "present");
    const caller: { readonly answers: (error: DispatchFailure) => boolean; notice?: () => void } = { answers: startsOver };
    if (text !== null && admitted) answeredByCaller.set(rewound.commandId, caller);
    let answer: DispatchAnswer<"sessions.rewind">;
    try {
      answer = (await rewound.enqueue()) as DispatchAnswer<"sessions.rewind">;
    } finally {
      answeredByCaller.delete(rewound.commandId);
    }
    if (answer.ok || caller.notice === undefined || text === null) return { kind: "rewind", answer };
    const id = uuidv4();
    // In the rewound session's workspace, as the environment has it now: a session request, never a copy of the summary's (#325).
    const create = prepare(environmentId, "sessions.create", { id, workspace: { kind: "session", sessionId } });
    if ("refused" in create) {
      // Refused on the spot after all (the runtime closing, the environment removed): no session is started, and the rewind's
      // refusal is the caller's, with the notice it would have raised.
      caller.notice();
      return { kind: "rewind", answer };
    }
    const created = (await create.enqueue()) as DispatchAnswer<"sessions.create">;
    // The draft holds at most MAX_DRAFT_LENGTH characters: a longer message is cut to it, as a fork's anchored draft is (#137).
    // Sent only once the session exists, so a create the environment refused leaves one notice, its own.
    const draft = text.slice(0, MAX_DRAFT_LENGTH);
    if (created.ok && draft.length > 0) void dispatch(environmentId, "sessions.setDraft", { sessionId: id, draft });
    return { kind: "new-session", sessionId: id, answer: created };
  };

  const stopFirst = createStopFirst({
    clock,
    held: (environmentId, sessionId) => host.held(environmentId, sessionId),
    sessionRuns: (environmentId, sessionId) => host.sessionRuns(environmentId, sessionId),
    interrupt: (environmentId, runId) => dispatch(environmentId, "runs.interrupt", { runId }),
    rewind,
  });

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

  /**
   * The environment's group named `groupName` (names equal ignoring case and
   * white space, as merged headings are), or a `groups.create` for one with
   * a client-minted id, checked and not yet kept: the caller keeps it just
   * before the command that names the group, so it is sent first.
   */
  const groupNamed = (environmentId: string, groupName: string): { readonly groupId: string; readonly create: Prepared | null } => {
    const name = normaliseGroupName(groupName);
    const held = [...(host.shown(environmentId)?.groups.values() ?? [])].find((group) => groupNameKey(group.name) === groupNameKey(name));
    if (held) return { groupId: held.id, create: null };
    const groupId = uuidv4();
    return { groupId, create: prepare(environmentId, "groups.create", { id: groupId, name }) };
  };

  return {
    view,
    dispatch,
    admits: (environmentId, method) => admission(method, host.record(environmentId)),
    moveToGroup(environmentId, sessionId, groupName) {
      if (groupName === null) return dispatch(environmentId, "sessions.setGroup", { sessionId, groupId: null });
      const { groupId, create } = groupNamed(environmentId, groupName);
      if (create !== null && "refused" in create) return Promise.resolve(create.refused as DispatchAnswer<"sessions.setGroup">);
      const move = prepare(environmentId, "sessions.setGroup", { sessionId, groupId });
      if ("refused" in move) return Promise.resolve(move.refused as DispatchAnswer<"sessions.setGroup">);
      // In this order, so the create is sent first; the move is answered, the create's answer is its notice if refused.
      void create?.enqueue();
      return move.enqueue() as Promise<DispatchAnswer<"sessions.setGroup">>;
    },
    async startSession(environmentId, choice) {
      const { workspace, account, model, groupName, browser } = choice;
      const sessionId = choice.id ?? uuidv4();
      const group = groupName === undefined ? null : groupNamed(environmentId, groupName);
      if (group?.create != null && "refused" in group.create) return { sessionId, answer: group.create.refused as DispatchAnswer<"sessions.create"> };
      const create = prepare(environmentId, "sessions.create", {
        id: sessionId,
        workspace,
        ...(account !== undefined && { account }),
        ...(model !== undefined && { model }),
        ...(group !== null && { groupId: group.groupId }),
        ...(browser?.value != null && { browser: { value: browser.value, chosenBy: browser.reason === "chosen" ? "person" : "reach" } }),
      });
      if ("refused" in create) return { sessionId, answer: create.refused as DispatchAnswer<"sessions.create"> };
      // In this order, so the group is made first; the create is answered, the group's answer is its notice if refused.
      void group?.create?.enqueue();
      const answer = (await create.enqueue()) as DispatchAnswer<"sessions.create">;
      if (answer.ok) await host.setLastUsed(environmentId).catch(report);
      return { sessionId, answer };
    },
    rewind(environmentId, sessionId, messageId, options = {}) {
      return options.stopFirst === true ? stopFirst.rewind(environmentId, sessionId, messageId, options.onStopping) : rewind(environmentId, sessionId, messageId);
    },
    async fork(environmentId, sessionId, options = {}) {
      const { anchor, account, title } = options;
      const id = uuidv4();
      // Read now: the source's draft may move on while the fork is under way.
      const carried = account !== undefined && anchor === undefined ? handOffDraft(environmentId, sessionId) : null;
      const answer = await dispatch(environmentId, "sessions.fork", {
        sessionId,
        id,
        ...(anchor !== undefined && { atMessageId: anchor }),
        ...(account !== undefined && { account }),
        ...(title !== undefined && { title }),
      });
      if (answer.ok) {
        // Sent only once the fork exists, so a fork the environment refused leaves one notice, its own.
        if (carried !== null) void dispatch(environmentId, "sessions.setDraft", { sessionId: id, draft: carried.slice(0, MAX_DRAFT_LENGTH) });
      }
      return { sessionId: id, answer };
    },
    async load(environmentIds) {
      await Promise.all(environmentIds.map(load));
    },
    applied(environmentId, event) {
      const commandId = event.commandId?.toLowerCase();
      if (commandId === undefined || !outboxOf(environmentId).overlays.some((o) => o.commandId === commandId)) return;
      // The event's sequence stands for the receipt's, which may not have come yet.
      const settled = settledIn(environmentId);
      change(environmentId, (current) => ({
        ...current,
        overlays: current.overlays.map((o) => (o.commandId === commandId ? { ...o, sequence: event.sequence } : o)).filter((o) => !settled(o)),
      }));
    },
    sessionApplied(environmentId) {
      settleOverlays(environmentId);
    },
    async checkpoint() {
      await Promise.all([...senders.values()].map(sender => sender.loaded));
      await Promise.all([...senders.values()].map(sender => sender.writes));
    },
    async close() {
      // A command kept after a read still under way is kept before the close: its read's continuation runs first.
      await Promise.all([...senders.values()].map((sender) => sender.loaded));
      closed = true;
      // A stop-first rewind still waiting goes on to its rewind, which is now refused closed.
      stopFirst.close();
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
