import {
  ContractError,
  MAX_DRAFT_LENGTH,
  SESSION_STREAM_KIND,
  invalidParams,
  type JsonObject,
  type SessionForkedPayload,
  type SessionRewoundPayload,
  type SessionTitleGeneratedPayload,
  type TranscriptItem,
} from "@agent-harness/contracts";
import { requireCapability } from "../adapter/capabilities.js";
import type { AdapterDescriptor, RunTarget } from "../adapter/contract.js";
import type { AdapterHost } from "../adapter/host.js";
import type { EventInput, EventLog, Tx } from "../event-log/event-log.js";
import { latestRun, providerSessionOf, readSessionFacts } from "../runs/run-reads.js";
import { sessionTranscript } from "../runs/transcript.js";
import type { MethodHandlers } from "../serve/methods.js";
import { PURGED_STATE, decideCreate, sessionNotFound, type SessionState } from "./decider.js";
import { groupExists } from "./group-reads.js";
import { acceptAnyRunParameters, keepSessionMode, type RunParametersCheck, type SessionModeClamp } from "./run-parameters.js";
import { readSessionState, readSummary, type Reader } from "./session-reads.js";
import { sessionStream } from "./streams.js";
import { generatedTitle } from "./titles.js";

/**
 * Fork and rewind (claude-adapter spec, "Wire methods" and "Queue,
 * read-now, fork and rewind on the Claude adapter"; ADR 0022, ADR 0015), and
 * the subagent transcript read on demand: `sessions.fork`, `sessions.rewind`
 * and `sessions.subagentTranscript`, and what a session's next run
 * continues from (`runContinuation`), which the adapter host reads when a
 * run starts.
 *
 * A fork is a new session made through session-state's create
 * (`decideCreate`), with `session.forked` on its own stream naming the
 * source, the message it was taken before, and the provider conversation it
 * continues; the SDK session store's rows of the source are copied under the
 * fork's id in the same transaction, so the fork owns its conversation from
 * the moment it exists and a purge of either never takes the other's. Its
 * first run is a fork of that conversation, on whichever account of this
 * environment it names (the hand-off onto another account). A rewind is
 * `session.rewound` on the session: the snapshot hides the message and
 * everything after it (`runs/transcript.ts`), and the session's next run
 * resumes the provider's conversation from just before it, on a fresh
 * process (the host stops the session's process when the rewind commits).
 * Both are session events, carrying no run id (#119).
 */

/** What a session's next run continues from, and the session it was forked from when it is a fork's first. */
export interface RunContinuation {
  readonly target: RunTarget;
  readonly forkedFrom: string | null;
}

/** A fork's own record: its `session.forked`, the first event after its creation. */
const forkRecord = (log: Pick<EventLog, "read">, sessionId: string): SessionForkedPayload | null => {
  const [row] = log.read<{ payload: string }>(
    `SELECT payload FROM events WHERE stream_kind = '${SESSION_STREAM_KIND}' AND stream_id = ? AND type = 'session.forked' ORDER BY sequence LIMIT 1`,
    sessionId,
  );
  return row === undefined ? null : (JSON.parse(row.payload) as SessionForkedPayload);
};

/**
 * The session's latest rewind while no run has continued from it yet: no
 * provider conversation has been linked since (`session.provider-linked`),
 * so the provider still holds what the rewind hid as its latest.
 */
export const pendingRewind = (log: Pick<EventLog, "read">, sessionId: string): SessionRewoundPayload | null => {
  const [row] = log.read<{ sequence: number; payload: string }>(
    `SELECT sequence, payload FROM events WHERE stream_kind = '${SESSION_STREAM_KIND}' AND stream_id = ? AND type = 'session.rewound' ORDER BY sequence DESC LIMIT 1`,
    sessionId,
  );
  if (row === undefined) return null;
  const [linked] = log.read(
    `SELECT 1 FROM events WHERE stream_kind = '${SESSION_STREAM_KIND}' AND stream_id = ? AND type = 'session.provider-linked' AND sequence > ? LIMIT 1`,
    sessionId,
    row.sequence,
  );
  return linked === undefined ? (JSON.parse(row.payload) as SessionRewoundPayload) : null;
};

/**
 * What the session's next run continues from, on an adapter `descriptor`
 * describes: a rewind not yet continued from, when the adapter rewinds;
 * else the provider conversation its runs last linked, when it resumes; for
 * a fork no run of which has linked one yet, a fork of the conversation the
 * source had (a fork of a source with none starts fresh); else nothing.
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
}

type UserMessage = Extract<TranscriptItem, { kind: "user-message" }>;

/** A message a command names that is not a user message of the session's visible transcript. */
const messageNotFound = (sessionId: string, messageId: string) => ({
  code: "not_found" as const,
  message: `No message ${messageId} is in the visible transcript of session ${sessionId}.`,
  data: { kind: "message", sessionId, messageId },
});

export const forkRewindMethods = (options: ForkRewindMethodsOptions): MethodHandlers => {
  const { log, host } = options;
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

  /** The descriptor of the adapter that holds the session's conversation: its latest run's account's. */
  const descriptorOf = (sessionId: string): AdapterDescriptor | null => {
    const run = latestRun(reader, sessionId);
    return run === null ? null : (host.account(run.accountId)?.descriptor ?? null);
  };

  return {
    "sessions.fork": (params, context) => {
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
      const atMessageId = anchor?.messageId ?? pendingRewind(log, sourceId)?.toMessageId ?? null;
      const linked = providerSessionOf(reader, sourceId);
      // Nothing of the provider's comes before the anchor when it is the source's first message: the fork starts fresh.
      const fromProviderSessionId = linked !== null && (atMessageId === null || historyBefore(sourceId, messages, atMessageId)) ? linked : null;

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
      const mode = facts.mode === null ? null : clampSessionMode(facts.mode, account, context.clientSession);

      const created = decideCreate(
        stateOf(id),
        { id, title: params.title ?? null, tags: source.tags, groupId: source.groupId, workspace: facts.workspace, account, model, mode },
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
      const forked: SessionForkedPayload = { fromSessionId: sourceId, atMessageId, fromProviderSessionId };
      events.push({ type: "session.forked", payload: forked });
      log.append(aggregate, events, { tx: context.tx, actor: context.actor, commandId: context.commandId });
      if (fromProviderSessionId !== null) options.store?.copySession(context.tx, sourceId, id);
      const summary = readSummary(reader, id);
      if (summary === null) throw new Error(`The fork ${id} is not in the list after its creation.`);
      return { aggregate, result: { summary } };
    },

    "sessions.rewind": (params, context) => {
      const id = params.sessionId.toLowerCase();
      const messageId = params.messageId.toLowerCase();
      const aggregate = sessionStream(id);
      const state = stateOf(id);
      if (state === null || state.deleted) return { aggregate, rejected: sessionNotFound(id) };
      const live = host.live(id);
      if (live !== null) {
        return {
          aggregate,
          rejected: { code: "conflict", message: `A run of the session ${id} is live; interrupt it before rewinding.`, data: { reason: "run_active", sessionId: id, runId: live.runId } },
        };
      }
      const messages = visibleMessages(id);
      if (!messages.some((message) => message.messageId === messageId && message.heldBy === null)) return { aggregate, rejected: messageNotFound(id, messageId) };
      if (!historyBefore(id, messages, messageId)) {
        return {
          aggregate,
          rejected: {
            code: "conflict",
            message: `The message ${messageId} is the session's first: start a new session with its text instead.`,
            data: { reason: "use_new_session", sessionId: id, messageId },
          },
        };
      }
      const descriptor = descriptorOf(id);
      if (descriptor !== null) requireCapability(descriptor, "rewind", ["messageId"], "rewind a session");
      const payload: SessionRewoundPayload = { toMessageId: messageId };
      log.append(aggregate, [{ type: "session.rewound", payload }], { tx: context.tx, actor: context.actor, commandId: context.commandId });
      return { aggregate, result: { sessionId: id, messageId } };
    },

    "sessions.subagentTranscript": async (params) => {
      const id = params.sessionId.toLowerCase();
      if (readSummary(reader, id) === null) throw new ContractError(sessionNotFound(id));
      const messages: readonly JsonObject[] = await host.subagentTranscript(id, params.agentId);
      return { sessionId: id, agentId: params.agentId, messages: [...messages] };
    },
  };
};
