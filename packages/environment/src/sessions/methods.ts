import {
  ContractError,
  GROUP_STREAM_KIND,
  SESSION_STREAM_KIND,
  invalidParams,
  listEventTypes,
  type SessionDeletedPayload,
  type SessionSummary,
} from "@agent-harness/contracts";
import type { EventLog, StreamRef } from "../event-log/event-log.js";
import type { CommandAnswer, CommandContext, MethodHandlers } from "../serve/methods.js";
import {
  PURGED_STATE,
  decideArchive,
  decideCreate,
  decideDelete,
  decidePin,
  decidePurge,
  decideRename,
  decideReorderActive,
  decideReorderPinned,
  decideRestore,
  decideSetDraft,
  decideTag,
  decideUnarchive,
  decideUnpin,
  decideUntag,
  sessionNotFound,
  type Decision,
  type Refusal,
  type SessionState,
} from "./decider.js";
import { createDeletion, type Deletion } from "./deletion.js";
import { acceptAnyRunParameters, type RunParametersCheck } from "./run-parameters.js";
import { groupExists, listDeleted, listGroups, listSummaries, readSessionState, readSummary, type Reader } from "./session-reads.js";

/**
 * The session-organisation handlers on the method table (session-state
 * spec, "Commands" and "Subscriptions"): each session command runs its
 * decider over the projection and appends what it decides through the
 * command's transaction (create and rename; archive, pin and the reorders,
 * tags and the draft; delete, restore and purge, the purge carried out by
 * `deletion.ts`); `sessions.list`, `sessions.get`, `sessions.listDeleted`
 * and `sessions.subscribe` read the session-list projection, and
 * `sessions.subscribeSession` follows one session's stream. The other
 * session and group methods are registered in the contracts and served by
 * #116 and #117 (`OWED_HANDLERS`).
 */

export interface SessionMethodsOptions {
  readonly log: EventLog;
  /** The account, model and mode check `sessions.create` runs; preset: every value accepted, until #119 and the permissions workstream fill it. */
  readonly validateRunParameters?: RunParametersCheck;
  /** The environment's clock, which stamps the times a command records (`archivedAt`, `pinnedAt`); preset: the system's. */
  readonly clock?: () => Date;
  /** The purge `sessions.purge` runs; preset: one over `log` whose adapter cannot delete a transcript. The environment shares its own with the sweep. */
  readonly deletion?: Deletion;
}

/** The streams and event types the session list carries: the `list`-flagged events of every session and group stream. */
export const SESSION_LIST_SELECTOR = {
  kinds: [SESSION_STREAM_KIND, GROUP_STREAM_KIND],
  types: listEventTypes([SESSION_STREAM_KIND, GROUP_STREAM_KIND]),
} as const;

const sessionStream = (id: string): StreamRef => ({ kind: SESSION_STREAM_KIND, id });

export const sessionMethods = (options: SessionMethodsOptions): MethodHandlers => {
  const { log } = options;
  const validateRunParameters = options.validateRunParameters ?? acceptAnyRunParameters;
  const clock = options.clock ?? (() => new Date());
  const deletion = options.deletion ?? createDeletion({ log });
  // The log's query-only read: inside a command it reads that command's own transaction.
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  /**
   * The session's state for the decider. A session with no row but events on
   * its stream was purged: its id stays used, so it reads as deleted.
   */
  const stateOf = (id: string): SessionState | null =>
    readSessionState(reader, id) ?? (log.readStream(sessionStream(id), 0, 1).length > 0 ? PURGED_STATE : null);

  /** The summary a command leaves, read after it appended; a command is only answered for a session in the list. */
  const summaryAfter = (id: string): SessionSummary => {
    const summary = readSummary(reader, id);
    if (summary === null) throw new Error(`The session ${id} is not in the list after a command applied to it.`);
    return summary;
  };

  /**
   * Carries out a decision in the command's transaction: a refusal is the
   * rejected answer; events are appended with the command's id and actor, so
   * the projector writes the summary and its patch before the answer reads it.
   */
  const carryOut = (id: string, decision: Decision, context: CommandContext): CommandAnswer<{ summary: SessionSummary }, Refusal["code"]> => {
    const aggregate = sessionStream(id);
    if (decision.rejected !== undefined) return { aggregate, rejected: decision.rejected };
    if (decision.events.length > 0) {
      log.append(aggregate, decision.events, { tx: context.tx, actor: context.actor, commandId: context.commandId });
    }
    return { aggregate, result: { summary: summaryAfter(id) } };
  };

  /**
   * Runs a command on one existing session: its id in lowercase, the time
   * now for the decider to record, and its events stamped with that same
   * time, so a time in a payload and the event's `occurredAt` (the summary's
   * `updatedAt`) are one instant.
   */
  const onSession = (
    sessionId: string,
    context: CommandContext,
    decide: (state: SessionState | null, id: string, at: string) => Decision,
  ): CommandAnswer<{ summary: SessionSummary }, Refusal["code"]> => {
    const id = sessionId.toLowerCase();
    const at = clock().toISOString();
    const decision = decide(stateOf(id), id, at);
    const stamped: Decision = decision.rejected === undefined ? { events: decision.events.map((event) => ({ ...event, occurredAt: at })) } : decision;
    return carryOut(id, stamped, context);
  };

  return {
    "sessions.create": (params, context) => {
      const id = params.id.toLowerCase();
      const run = { account: params.account ?? null, model: params.model ?? null, mode: params.mode ?? null };
      const issues = validateRunParameters(run);
      if (issues.length > 0) throw new ContractError(invalidParams(issues, "The account, model or mode is not one this environment offers."));
      const groupId = params.groupId?.toLowerCase() ?? null;
      const command = { id, title: params.title ?? null, tags: params.tags ?? [], groupId, workspace: params.workspace, ...run };
      return carryOut(id, decideCreate(stateOf(id), command, { groupExists: groupId !== null && groupExists(reader, groupId) }), context);
    },

    "sessions.rename": (params, context) => {
      const id = params.sessionId.toLowerCase();
      return carryOut(id, decideRename(stateOf(id), { sessionId: id, title: params.title }), context);
    },

    "sessions.archive": (params, context) =>
      onSession(params.sessionId, context, (state, sessionId, at) => decideArchive(state, { sessionId, at })),

    "sessions.unarchive": (params, context) => onSession(params.sessionId, context, (state, sessionId) => decideUnarchive(state, { sessionId })),

    "sessions.pin": (params, context) =>
      onSession(params.sessionId, context, (state, sessionId, at) => decidePin(state, { sessionId, orderKey: params.orderKey ?? null, at })),

    "sessions.unpin": (params, context) => onSession(params.sessionId, context, (state, sessionId) => decideUnpin(state, { sessionId })),

    "sessions.reorderPinned": (params, context) =>
      onSession(params.sessionId, context, (state, sessionId) => decideReorderPinned(state, { sessionId, orderKey: params.orderKey })),

    "sessions.reorderActive": (params, context) =>
      onSession(params.sessionId, context, (state, sessionId) => decideReorderActive(state, { sessionId, orderKey: params.orderKey })),

    "sessions.tag": (params, context) => onSession(params.sessionId, context, (state, sessionId) => decideTag(state, { sessionId, tag: params.tag })),

    "sessions.untag": (params, context) =>
      onSession(params.sessionId, context, (state, sessionId) => decideUntag(state, { sessionId, tag: params.tag })),

    "sessions.setDraft": (params, context) =>
      onSession(params.sessionId, context, (state, sessionId) => decideSetDraft(state, { sessionId, draft: params.draft })),

    "sessions.delete": (params, context) => {
      const id = params.sessionId.toLowerCase();
      const aggregate = sessionStream(id);
      const at = clock().toISOString();
      const decision = decideDelete(stateOf(id), { sessionId: id, at, deleteProviderTranscript: params.deleteProviderTranscript ?? false });
      if (decision.rejected !== undefined) return { aggregate, rejected: decision.rejected };
      // Stopping the provider process and closing terminals are the adapter's and the terminal workstreams', on this event.
      log.append(
        aggregate,
        decision.events.map((event) => ({ ...event, occurredAt: at })),
        { tx: context.tx, actor: context.actor, commandId: context.commandId },
      );
      const { deletedAt, purgeAt } = decision.events[0]?.payload as SessionDeletedPayload;
      return { aggregate, result: { sessionId: id, deletedAt, purgeAt } };
    },

    "sessions.restore": (params, context) =>
      onSession(params.sessionId, context, (state, sessionId, at) => decideRestore(state, { sessionId, at })),

    "sessions.purge": (params, context) => {
      const id = params.sessionId.toLowerCase();
      const aggregate = sessionStream(id);
      const decision = decidePurge(stateOf(id), { sessionId: id });
      if (decision.rejected !== undefined) return { aggregate, rejected: decision.rejected };
      deletion.purgeSession(id, { tx: context.tx, actor: context.actor, commandId: context.commandId });
      return { aggregate, result: { sessionId: id } };
    },

    "sessions.list": () => ({ sequence: log.head(), sessions: listSummaries(reader) }),

    "sessions.get": ({ sessionId }) => {
      const id = sessionId.toLowerCase();
      const summary = readSummary(reader, id);
      if (summary === null) throw new ContractError(sessionNotFound(id));
      return { summary };
    },

    "sessions.listDeleted": () => ({ sessions: listDeleted(reader) }),

    "sessions.subscribe": () => ({
      stream: SESSION_LIST_SELECTOR,
      snapshot: () => ({ sequence: log.head(), sessions: listSummaries(reader), groups: listGroups(reader) }),
    }),

    /**
     * One session's stream, every event of it. A session that is not in
     * the list (unknown, deleted, or purged, whose stream holds only its
     * tombstone) is not found; `session.deleted` ends the subscription.
     */
    "sessions.subscribeSession": ({ sessionId }) => {
      const id = sessionId.toLowerCase();
      const summaryOf = (): SessionSummary => {
        const summary = readSummary(reader, id);
        if (summary === null) throw new ContractError(sessionNotFound(id));
        return summary;
      };
      summaryOf();
      return {
        stream: sessionStream(id),
        // The transcript's shape is the adapter workstream's (#119): an empty object until it fills it.
        snapshot: () => ({ sequence: log.head(), summary: summaryOf(), transcript: {} }),
        endOn: (event) => (event.type === "session.deleted" ? "deleted" : undefined),
      };
    },
  };
};
