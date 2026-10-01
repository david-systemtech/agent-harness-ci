import {
  ContractError,
  MAX_DRAFT_LENGTH,
  SESSION_STREAM_KIND,
  invalidParams,
  type JsonObject,
  type SessionDraftSetPayload,
  type SessionForkedPayload,
  type SessionBrowserSetPayload,
  type SessionRewindUndonePayload,
  type SessionRewoundPayload,
  type SessionTitleGeneratedPayload,
  type TranscriptItem,
} from "@agent-harness/contracts";
import { requireCapability } from "../adapter/capabilities.js";
import type { AdapterDescriptor, RunTarget } from "../adapter/contract.js";
import type { AdapterHost } from "../adapter/host.js";
import type { EventInput, EventLog, Tx } from "../event-log/event-log.js";
import { forkedInstructions } from "../instructions/session-instructions.js";
import { environmentQueue, latestRun, providerQueue, providerSessionOf, readSessionFacts } from "../runs/run-reads.js";
import { sessionTranscript } from "../runs/transcript.js";
import type { Clock } from "../serve/clock.js";
import type { MethodHandler, MethodHandlers } from "../serve/methods.js";
import { PURGED_STATE, decideCreate, sessionNotFound, type FirstBrowser, type SessionState } from "./decider.js";
import { groupExists } from "./group-reads.js";
import { acceptAnyRunParameters, keepSessionMode, type RunParametersCheck, type SessionModeClamp } from "./run-parameters.js";
import { readOrigin, readSessionState, readSummary, type Reader } from "./session-reads.js";
import { sessionStream } from "./streams.js";
import { generatedTitle } from "./titles.js";

/**
 * Fork and rewind (claude-adapter spec, "Wire methods" and "Queue,
 * read-now, fork and rewind on the Claude adapter"; ADR 0022, ADR 0015), and
 * the subagent transcript read on demand: `sessions.fork`, `sessions.rewind`,
 * `sessions.undoRewind` and `sessions.subagentTranscript`, and what a
 * session's next run continues from (`runContinuation`), which the adapter
 * host reads when a run starts.
 *
 * A fork is a new session made through session-state's create
 * (`decideCreate`), with `session.forked` on its own stream naming the
 * source, the message it was taken before, and the provider conversation it
 * continues; the SDK session store's rows of the source are copied under the
 * fork's id in the same transaction, so the fork owns its conversation from
 * the moment it exists and a purge of either never takes the other's. Its
 * first run is a fork of that conversation, on whichever account of this
 * environment it names (the hand-off onto another account). A rewind is
 * `session.rewound` on the session, with `session.draft-set` carrying the
 * message's text, refused while a run is live or messages are queued for the
 * session that a run could still read: the snapshot hides the message and
 * everything after it from its items and carries them with the rewind in
 * its rewinds (`runs/transcript.ts`, #260), and the session's next run
 * resumes the provider's conversation from just before it, on a fresh
 * process (the host stops the session's process when the rewind commits).
 * With no run live, a rewind first waits, for at most `REWIND_WAIT_MS`, for
 * what the host is still handing back to the queue after a run's end (#245),
 * so the refusal names messages the environment holds.
 * An undo is `session.rewind-undone` naming the latest rewind not undone,
 * offered until a run starts on the session after it (ADR 0022, #218): the
 * snapshot shows what that rewind hid again, the draft the rewind replaced
 * comes back when the draft still holds the rewind's text, and the next run
 * continues as though that rewind had not been made. All three are session
 * events, carrying no run id (#119).
 */

/**
 * How long a rewind waits, on the environment's clock, for what the host is
 * still handing back to the session's queue after a run's end (#245) before
 * it decides on the log as it stands. Claude answers an interrupt within its
 * 8 s interrupt timeout (then forces its process down and names nothing), a
 * send at once, and a withdraw within its 15 s control timeout; ten seconds
 * covers the interrupt, the one a rewind straight after a run's end meets,
 * with room for the requeue's append. The wait holds up every later command
 * of the same client (its outbox sends one at a time), so it is not stretched
 * to the withdraw's: a rewind that stops waiting while a message is still
 * being handed back is refused `queued_messages`, since the message is still
 * the provider's on the log, and a retry decides again.
 */
export const REWIND_WAIT_MS = 10_000;

/** What a session's next run continues from, and the session it was forked from when it is a fork's first. */
export interface RunContinuation {
  readonly target: RunTarget;
  readonly forkedFrom: string | null;
}

/**
 * A fork's own record: its `session.forked`, the first event after its
 * creation, read from the log, where it survives a compaction (#123: not in
 * `COMPACTION_REMOVES`, `sessions/compaction.ts`).
 */
const forkRecord = (log: Pick<EventLog, "read">, sessionId: string): SessionForkedPayload | null => {
  const [row] = log.read<{ payload: string }>(
    `SELECT payload FROM events WHERE stream_kind = '${SESSION_STREAM_KIND}' AND stream_id = ? AND type = 'session.forked' ORDER BY sequence LIMIT 1`,
    sessionId,
  );
  return row === undefined ? null : (JSON.parse(row.payload) as SessionForkedPayload);
};

/** The source's current browser and its chooser; browser events survive compaction. */
const forkBrowser = (log: Pick<EventLog, "read">, sessionId: string): FirstBrowser | null => {
  const [row] = log.read<{ payload: string }>(
    `SELECT payload FROM events WHERE stream_kind = '${SESSION_STREAM_KIND}' AND stream_id = ? AND type = 'session.browser.set' ORDER BY sequence DESC LIMIT 1`,
    sessionId,
  );
  if (row === undefined) return null;
  const { browser, chosenBy } = JSON.parse(row.payload) as SessionBrowserSetPayload;
  return browser === null ? null : { value: browser, chosenBy };
};

/** A rewind as the log holds it: its `session.rewound`'s sequence and command, and its payload. */
interface RewindRecord {
  readonly sequence: number;
  readonly commandId: string | null;
  readonly payload: SessionRewoundPayload;
}

/**
 * The session's latest rewind not undone: the latest `session.rewound` no
 * `session.rewind-undone` names. Undoing it leaves the one before it, if
 * that is not undone too, as the latest, so rewinds are undone one at a
 * time, the latest first. Both events survive a compaction (#123).
 */
const latestRewind = (log: Pick<EventLog, "read">, sessionId: string): RewindRecord | null => {
  const [row] = log.read<{ sequence: number; command_id: string | null; payload: string }>(
    `SELECT r.sequence, r.command_id, r.payload FROM events r
     WHERE r.stream_kind = '${SESSION_STREAM_KIND}' AND r.stream_id = ? AND r.type = 'session.rewound'
       AND NOT EXISTS (SELECT 1 FROM events u WHERE u.stream_kind = r.stream_kind AND u.stream_id = r.stream_id
                         AND u.type = 'session.rewind-undone' AND json_extract(u.payload, '$.rewindSequence') = r.sequence)
     ORDER BY r.sequence DESC LIMIT 1`,
    sessionId,
  );
  return row === undefined ? null : { sequence: row.sequence, commandId: row.command_id, payload: JSON.parse(row.payload) as SessionRewoundPayload };
};

/** The first run started on the session after `sequence`, if any: its id. */
const runStartedAfter = (log: Pick<EventLog, "read">, sessionId: string, sequence: number): string | null => {
  const [row] = log.read<{ runId: string }>(
    `SELECT json_extract(payload, '$.runId') AS runId FROM events
     WHERE stream_kind = '${SESSION_STREAM_KIND}' AND stream_id = ? AND type = 'run.started' AND sequence > ? ORDER BY sequence LIMIT 1`,
    sessionId,
    sequence,
  );
  return row?.runId ?? null;
};

/**
 * The session's latest rewind not undone while it can still be undone: no
 * run has started on the session since (ADR 0022). Stricter than
 * `pendingRewind`'s "continued": a run that linked the provider session and
 * then failed may have written a turn after the rewind's point, which a
 * plain resume after an undo would continue from instead of from what the
 * undo shows again. Compaction leaves such a session out
 * (`sessions/compaction.ts`, #218), though its fold now carries what the
 * rewind hid (#260).
 */
export const undoableRewind = (log: Pick<EventLog, "read">, sessionId: string): RewindRecord | null => {
  const rewind = latestRewind(log, sessionId);
  return rewind === null || runStartedAfter(log, sessionId, rewind.sequence) !== null ? null : rewind;
};

/**
 * The session's latest rewind not undone (`latestRewind`) while no run has
 * continued from it yet: no run since has linked the provider session and
 * ended `completed` (a run that completed without linking one, which a
 * provider could report, never resumed the rewound history). A run that
 * linked the provider session
 * and then failed does not count: it may have failed before the provider
 * wrote anything, whose latest is then still what the rewind hid, so the
 * next run is a rewind again; where the failed run did write a turn of its
 * own after the rewind's point, the adapter finds the message off its
 * stored chain and continues the chain as it stands (the Claude adapter's
 * `#resumePoint`). Every event read here survives a compaction (#123):
 * `sessions/compaction.ts` removes only `COMPACTION_REMOVES` (the
 * assistant's items, tool calls, commands, usage and plan limits) and all
 * but each run's last `tasks.changed`, keeping `session.rewound`,
 * `session.rewind-undone`, `session.provider-linked` and `run.ended`, so
 * the answer is the same after one. Once the rewind is undone, the one
 * before it, if not undone too, is the one asked about; with none, the
 * next run resumes as it would have before the rewind.
 */
export const pendingRewind = (log: Pick<EventLog, "read">, sessionId: string): SessionRewoundPayload | null => {
  const row = latestRewind(log, sessionId);
  if (row === null) return null;
  const [continued] = log.read(
    `SELECT 1 FROM events ended WHERE ended.stream_kind = '${SESSION_STREAM_KIND}' AND ended.stream_id = ? AND ended.type = 'run.ended' AND ended.sequence > ?
       AND json_extract(ended.payload, '$.reason') = 'completed'
       AND EXISTS (SELECT 1 FROM events linked WHERE linked.stream_kind = ended.stream_kind AND linked.stream_id = ended.stream_id
                     AND linked.type = 'session.provider-linked' AND linked.sequence > ? AND json_extract(linked.payload, '$.runId') = json_extract(ended.payload, '$.runId'))
     LIMIT 1`,
    sessionId,
    row.sequence,
    row.sequence,
  );
  return continued === undefined ? row.payload : null;
};

/**
 * What the session's next run continues from, on an adapter `descriptor`
 * describes: a rewind not yet continued from, when the adapter rewinds;
 * else the provider conversation its runs last linked, when it resumes; for
 * a fork no run of which has linked one yet, a fork of the conversation the
 * source had (a fork of a source with none starts fresh); for an imported
 * session no run of which has linked one yet, the provider session it was
 * imported from, resumed from the account's directory (#579; the adapter's
 * to find there, the Claude one copying it into its store first); else
 * nothing.
 */
export const runContinuation = (log: Pick<EventLog, "read">, reader: Reader, sessionId: string, descriptor: AdapterDescriptor | null): RunContinuation => {
  const fresh: RunContinuation = { target: { kind: "fresh" }, forkedFrom: null };
  if (descriptor === null) return fresh;
  const linked = providerSessionOf(reader, sessionId);
  if (linked !== null) {
    const rewind = descriptor.rewind ? pendingRewind(log, sessionId) : null;
    if (rewind !== null) return { target: { kind: "rewind", providerSessionId: linked, toMessageId: rewind.toMessageId }, forkedFrom: null };
    return descriptor.resume ? { target: { kind: "resume", providerSessionId: linked }, forkedFrom: null } : fresh;
  }
  const origin = readOrigin(reader, sessionId);
  if (origin?.kind === "import") return descriptor.resume ? { target: { kind: "resume", providerSessionId: origin.providerSessionId }, forkedFrom: null } : fresh;
  const fork = forkRecord(log, sessionId);
  if (fork === null) return fresh;
  if (fork.fromProviderSessionId === null || !descriptor.fork) return { target: { kind: "fresh" }, forkedFrom: fork.fromSessionId };
  return {
    target: { kind: "fork", providerSessionId: fork.fromProviderSessionId, atMessageId: fork.atMessageId },
    forkedFrom: fork.fromSessionId,
  };
};

/** The SDK session store as a fork needs it: the source's rows copied under the fork's id, in the fork's transaction. */
export interface ForkStore {
  copySession(tx: Tx, fromSessionId: string, toSessionId: string): void;
}

export interface ForkRewindMethodsOptions {
  readonly log: EventLog;
  readonly host: AdapterHost;
  /** The SDK session store (`provider-transcripts/store.ts`); preset: none, as with an adapter that keeps its own. */
  readonly store?: ForkStore;
  /** `sessions.create`'s account, model and mode check (the host's `validateSessionInput`); preset: every value accepted. */
  readonly validateRunParameters?: RunParametersCheck;
  /** `sessions.create`'s mode clamp (#129); preset: kept as given. */
  readonly clampSessionMode?: SessionModeClamp;
  /** The environment's clock, which bounds a rewind's wait (`REWIND_WAIT_MS`). */
  readonly clock: Clock;
}

type UserMessage = Extract<TranscriptItem, { kind: "user-message" }>;

/** A message a command names that is not a user message of the session's visible transcript. */
const messageNotFound = (sessionId: string, messageId: string) => ({
  code: "not_found" as const,
  message: `No message ${messageId} is in the visible transcript of session ${sessionId}.`,
  data: { kind: "message", sessionId, messageId },
});

export const forkRewindMethods = (options: ForkRewindMethodsOptions): MethodHandlers => {
  const { log, host, clock } = options;
  const validateRunParameters = options.validateRunParameters ?? acceptAnyRunParameters;
  const clampSessionMode = options.clampSessionMode ?? keepSessionMode;
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  /** The session's state; a purged one, whose stream holds its tombstone, reads as deleted. */
  const stateOf = (id: string): SessionState | null =>
    readSessionState(reader, id) ?? (log.readStream(sessionStream(id), 0, 1).length > 0 ? PURGED_STATE : null);

  /** The user messages of the session's visible transcript, the rewound ones left out, oldest first. */
  const visibleMessages = (sessionId: string): UserMessage[] =>
    sessionTranscript(log, sessionId).items.filter((item): item is UserMessage => item.kind === "user-message");

  /**
   * Whether the provider's conversation holds anything before `messageId`:
   * not when it is the session's first message, unless the session is a fork
   * that carried the source's conversation in.
   */
  const historyBefore = (sessionId: string, messages: readonly UserMessage[], messageId: string): boolean =>
    messages[0]?.messageId !== messageId || (forkRecord(log, sessionId)?.fromProviderSessionId ?? null) !== null;

  /** A `session.draft-set` row's draft. */
  const draftOf = (row: { payload: string } | undefined): SessionDraftSetPayload | null => (row === undefined ? null : (JSON.parse(row.payload) as SessionDraftSetPayload));

  /**
   * The draft an undo of `rewind` puts back, or undefined to leave the
   * draft as it is: the draft from before the rewind (its latest
   * `session.draft-set` before the rewind, else none), when the draft still
   * holds the text the rewind wrote into it (the rewind's own
   * `session.draft-set`, in its append); a draft changed since, by a
   * client or anything else that writes it, is the user's and stays, as
   * does one the rewind did not write (a message with no text).
   */
  const draftBefore = (sessionId: string, rewind: RewindRecord, current: string | null): string | null | undefined => {
    // Every `session.rewound` is appended by `sessions.rewind`, a command, so it carries its command id (the completions
    // surface's `rewindToMessageId` goes through that command too); one without, appended outside any command as nothing
    // here does, has no `session.draft-set` that is surely its own, so the draft is left as it is.
    if (rewind.commandId === null) return undefined;
    const draftSets = `SELECT payload FROM events WHERE stream_kind = '${SESSION_STREAM_KIND}' AND stream_id = ? AND type = 'session.draft-set'`;
    const wrote = draftOf(log.read<{ payload: string }>(`${draftSets} AND sequence > ? AND command_id = ? ORDER BY sequence LIMIT 1`, sessionId, rewind.sequence, rewind.commandId)[0]);
    if (wrote === null || wrote.draft !== current) return undefined;
    const before = draftOf(log.read<{ payload: string }>(`${draftSets} AND sequence < ? ORDER BY sequence DESC LIMIT 1`, sessionId, rewind.sequence)[0])?.draft ?? null;
    return before === current ? undefined : before;
  };

  /** The descriptor of the adapter that holds the session's conversation: its latest run's account's. */
  const descriptorOf = (sessionId: string): AdapterDescriptor | null => {
    const run = latestRun(reader, sessionId);
    return run === null ? null : (host.account(run.accountId)?.descriptor ?? null);
  };

  /**
   * `sessions.rewind`'s decision, in its transaction, once what the host was
   * handing back to the session's queue has come, or the wait for it has run
   * out (its `prepare`, #245).
   */
  const rewindNow = (storedHistory: boolean | null = null): MethodHandler<"sessions.rewind"> => (params, context) => {
    const id = params.sessionId.toLowerCase();
    const messageId = params.messageId.toLowerCase();
    const aggregate = sessionStream(id);
    const state = stateOf(id);
    if (state === null || state.deleted) return { aggregate, rejected: sessionNotFound(id) };
    // A turn the provider opened after the run, waiting on its mode change, counts too: it is adopted as a run after the
    // rewind, or let go with its messages requeued after it.
    const active = host.runActive(id);
    if (active !== null) {
      // The turn waiting on its mode change cannot be interrupted, and the run it followed has ended: what a client
      // can do is wait for the change to resolve, so the message says which case this is.
      const message =
        host.live(id) !== null
          ? `A run of the session ${id} is live; interrupt it before rewinding.`
          : `A turn the provider opened on the session ${id} is waiting on its mode change; it is taken on as a run, or let go, before a rewind can land.`;
      return { aggregate, rejected: { code: "conflict", message, data: { reason: "run_active", sessionId: id, runId: active.runId } } };
    }
    // The next run reads the environment's queue before its prompt: a message queued before the rewind would reach the
    // provider after a history that hides what it was sent after, so the rewind waits for the queue to be read or withdrawn.
    // So does a message the provider still holds after the run's end, while its process runs (a provider reading its queue
    // opens a turn with it, adopted after the rewind) or the host may still hand it back (the wait ran out): a stopped
    // process's, with nothing handing back, reaches no run.
    const providerHeld = host.processes.running(id) || host.handingBack(id) ? providerQueue(reader, id) : [];
    const queued = [...providerHeld, ...environmentQueue(reader, id).map((message) => message.messageId)];
    if (queued.length > 0) {
      return {
        aggregate,
        rejected: {
          code: "conflict",
          message: `The session ${id} has queued messages the next run would read; withdraw them or let a run read them before rewinding.`,
          data: { reason: "queued_messages", sessionId: id, messageIds: queued },
        },
      };
    }
    const messages = visibleMessages(id);
    const target = messages.find((message) => message.messageId === messageId && message.heldBy === null);
    if (target === undefined) return { aggregate, rejected: messageNotFound(id, messageId) };
    if (!historyBefore(id, messages, messageId) || storedHistory === false) {
      return {
        aggregate,
        rejected: {
          code: "conflict",
          message: `No provider history comes before message ${messageId}: start a new session with its text instead.`,
          data: { reason: "use_new_session", sessionId: id, messageId },
        },
      };
    }
    const descriptor = descriptorOf(id);
    if (descriptor !== null) requireCapability(descriptor, "rewind", ["messageId"], "rewind a session");
    const payload: SessionRewoundPayload = { toMessageId: messageId };
    const events: EventInput[] = [{ type: "session.rewound", payload }];
    // The message's text becomes the draft (ADR 0022), in the same append.
    const draft = target.text.slice(0, MAX_DRAFT_LENGTH);
    if (draft !== "") events.push({ type: "session.draft-set", payload: { draft } });
    log.append(aggregate, events, { tx: context.tx, actor: context.actor, commandId: context.commandId });
    return { aggregate, result: { sessionId: id, messageId } };
  };

  const forkNow = (storedHistory: boolean | null = null): MethodHandler<"sessions.fork"> => (params, context) => {
    const sourceId = params.sessionId.toLowerCase();
    const id = params.id.toLowerCase();
    const aggregate = sessionStream(id);
    const source = stateOf(sourceId);
    const facts = readSessionFacts(log, reader, sourceId);
    if (source === null || source.deleted || facts === null) return { aggregate, rejected: sessionNotFound(sourceId) };

    // The anchor: the message asked for, else a rewind the source has not continued from, whose hidden part is no more the fork's than the source's.
    const messages = visibleMessages(sourceId);
    let anchor: UserMessage | null = null;
    if (params.atMessageId !== undefined) {
      const asked = params.atMessageId.toLowerCase();
      anchor = messages.find((message) => message.messageId === asked && message.heldBy === null) ?? null;
      if (anchor === null) return { aggregate, rejected: messageNotFound(sourceId, asked) };
    }
    const linked = providerSessionOf(reader, sourceId);
    let atMessageId: string | null;
    let fromProviderSessionId: string | null;
    if (linked !== null) {
      atMessageId = anchor?.messageId ?? pendingRewind(log, sourceId)?.toMessageId ?? null;
      // Nothing of the provider's comes before the anchor when it is the source's first message: the fork starts fresh.
      fromProviderSessionId = atMessageId === null || historyBefore(sourceId, messages, atMessageId) ? linked : null;
    } else {
      // A source no run of which has linked a provider session: a fork continues what the source's own fork named
      // (its copy of those rows is the source's), since nothing the source was sent since reached the provider.
      const inherited = forkRecord(log, sourceId);
      fromProviderSessionId = inherited?.fromProviderSessionId ?? null;
      atMessageId = inherited !== null && fromProviderSessionId !== null ? inherited.atMessageId : (anchor?.messageId ?? null);
    }

    // The source's account unless another is named; its model only on the same account, whose catalogue it came from.
    const account = params.account ?? facts.account;
    const model = params.account === undefined || params.account === facts.account ? facts.model : null;
    const verdict = validateRunParameters({ account, model, mode: facts.mode });
    if (verdict.unavailable !== undefined) {
      const { accountId, message } = verdict.unavailable;
      return { aggregate, rejected: { code: "conflict", message, data: { reason: "account_unavailable", accountId } } };
    }
    if (verdict.issues.length > 0) throw new ContractError(invalidParams(verdict.issues, "The account, model or mode is not one this environment offers."));
    if (fromProviderSessionId !== null) {
      const descriptor = host.account(account)?.descriptor;
      if (descriptor !== undefined) requireCapability(descriptor, "fork", params.account === undefined ? ["sessionId"] : ["account"], "fork a session");
    }
    if (fromProviderSessionId !== null && atMessageId !== null && storedHistory === false) {
      return {
        aggregate,
        rejected: { code: "conflict", message: `No provider history comes before message ${atMessageId}: start a new session with its text instead.`, data: { reason: "use_new_session", sessionId: sourceId, messageId: atMessageId } },
      };
    }
    const mode = facts.mode === null ? null : clampSessionMode(facts.mode, account, context.clientSession);

    const created = decideCreate(
      stateOf(id),
      // The source's workspace, shared whatever its kind, with its repository identity as recorded (#324): nothing is read again.
      { id, title: params.title ?? null, tags: source.tags, groupId: source.groupId, workspace: facts.workspace, repositoryIdentity: facts.repositoryIdentity, account, model, mode, browser: forkBrowser(log, sourceId) },
      { groupExists: source.groupId !== null && groupExists(reader, source.groupId) },
    );
    if (created.rejected !== undefined) return { aggregate, rejected: created.rejected };
    const events: EventInput[] = [...created.events];
    // The source's title, carried as the fork's generated title until the provider's summary replaces it.
    const carried = params.title === undefined ? generatedTitle(source.userTitle ?? source.generatedTitle ?? "") : null;
    if (carried !== null) {
      const payload: SessionTitleGeneratedPayload = { title: carried, source: "prompt" };
      events.push({ type: "session.title-generated", payload });
    }
    const draft = anchor?.text.slice(0, MAX_DRAFT_LENGTH) ?? "";
    if (draft !== "") events.push({ type: "session.draft-set", payload: { draft } });
    // The source's own instructions, which the fork keeps (#506).
    events.push(...forkedInstructions(reader, sourceId));
    const forked: SessionForkedPayload = { fromSessionId: sourceId, atMessageId, fromProviderSessionId };
    events.push({ type: "session.forked", payload: forked });
    log.append(aggregate, events, { tx: context.tx, actor: context.actor, commandId: context.commandId });
    if (fromProviderSessionId !== null) options.store?.copySession(context.tx, sourceId, id);
    const summary = readSummary(reader, id);
    if (summary === null) throw new Error(`The fork ${id} is not in the list after its creation.`);
    return { aggregate, result: { summary } };
  };

  /** Ask the adapter about the anchor it will actually resume; first-message forks still start fresh. */
  const storedHistoryBefore = (sessionId: string, messageId: string | null): Promise<boolean | null> => {
    const linked = providerSessionOf(reader, sessionId);
    if (linked === null) {
      const inherited = forkRecord(log, sessionId);
      if (inherited?.fromProviderSessionId == null || inherited.atMessageId === null) return Promise.resolve(null);
      return host.hasHistoryBefore(sessionId, inherited.fromProviderSessionId, inherited.atMessageId);
    }
    if (messageId === null) return Promise.resolve(null);
    const messages = visibleMessages(sessionId);
    if (!messages.some((message) => message.messageId === messageId && message.heldBy === null) || !historyBefore(sessionId, messages, messageId)) return Promise.resolve(null);
    return host.hasHistoryBefore(sessionId, linked, messageId);
  };

  return {
    "sessions.fork": {
      prepare: (params) => {
        const id = params.sessionId.toLowerCase();
        const anchor = params.atMessageId?.toLowerCase() ?? pendingRewind(log, id)?.toMessageId ?? null;
        return storedHistoryBefore(id, anchor).then((history) => forkNow(history));
      },
    },

    "sessions.rewind": {
      // What the host may still hand back to the queue after the run's end (an interrupt's answer, a send or a withdraw
      // the provider has not answered) is waited for first, so the queue the check reads holds it and the refusal names
      // messages the environment holds (#245). Not while a run is active, which refuses the rewind whatever comes back,
      // and for at most `REWIND_WAIT_MS`: then the transaction decides on the log as it stands.
      prepare: async (params) => {
        const id = params.sessionId.toLowerCase();
        if (host.runActive(id) !== null) return rewindNow();
        if (host.handingBack(id)) await new Promise<void>((resolve) => {
          const timer = clock.setTimeout(resolve, REWIND_WAIT_MS);
          void host.handedBack(id).then(() => {
            timer.cancel();
            resolve();
          });
        });
        return rewindNow(await storedHistoryBefore(id, params.messageId.toLowerCase()));
      },
    },

    "sessions.undoRewind": (params, context) => {
      const id = params.sessionId.toLowerCase();
      const aggregate = sessionStream(id);
      const state = stateOf(id);
      if (state === null || state.deleted) return { aggregate, rejected: sessionNotFound(id) };
      const live = host.live(id);
      if (live !== null) {
        return {
          aggregate,
          rejected: { code: "conflict", message: `A run of the session ${id} is live; interrupt it before undoing its rewind.`, data: { reason: "run_active", sessionId: id, runId: live.runId } },
        };
      }
      const rewind = latestRewind(log, id);
      if (rewind === null) return { aggregate, rejected: { code: "not_found", message: `The session ${id} has no rewind to undo.`, data: { kind: "rewind", sessionId: id } } };
      // Offered until a run starts on the session after the rewind (ADR 0022); after that the rewound branch stays hidden.
      const since = runStartedAfter(log, id, rewind.sequence);
      if (since !== null) {
        return {
          aggregate,
          rejected: {
            code: "conflict",
            message: `A run has started on the session ${id} since its rewind; what the rewind hid stays hidden.`,
            data: { reason: "run_started", sessionId: id, runId: since },
          },
        };
      }
      const { toMessageId } = rewind.payload;
      const payload: SessionRewindUndonePayload = { toMessageId, rewindSequence: rewind.sequence };
      const events: EventInput[] = [{ type: "session.rewind-undone", payload }];
      const draft = draftBefore(id, rewind, state.draft);
      if (draft !== undefined) {
        const restored: SessionDraftSetPayload = { draft };
        events.push({ type: "session.draft-set", payload: restored });
      }
      log.append(aggregate, events, { tx: context.tx, actor: context.actor, commandId: context.commandId });
      return { aggregate, result: { sessionId: id, messageId: toMessageId, rewindSequence: rewind.sequence } };
    },

    "sessions.subagentTranscript": async (params) => {
      const id = params.sessionId.toLowerCase();
      if (readSummary(reader, id) === null) throw new ContractError(sessionNotFound(id));
      const messages: readonly JsonObject[] = await host.subagentTranscript(id, params.agentId);
      return { sessionId: id, agentId: params.agentId, messages: [...messages] };
    },
  };
};
