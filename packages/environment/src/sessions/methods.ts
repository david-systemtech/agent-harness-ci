import {
  ContractError,
  GROUP_STREAM_KIND,
  SESSION_STREAM_KIND,
  invalidParams,
  listEventTypes,
  type SessionSummary,
} from "@agent-harness/contracts";
import type { EventEnvelope, EventLog } from "../event-log/event-log.js";
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
  decideSetGroup,
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
import { groupExists, listGroups } from "./group-reads.js";
import { acceptAnyRunParameters, keepSessionMode, type RunParametersCheck, type SessionModeClamp } from "./run-parameters.js";
import { listDeleted, listSummaries, readDeletion, readSessionState, readSummary, type Reader } from "./session-reads.js";
import { foldTranscript } from "../runs/transcript.js";
import { sessionStream, stamp } from "./streams.js";

/**
 * The session-organisation handlers on the method table (session-state
 * spec, "Commands" and "Subscriptions"): each session command runs its
 * decider over the projection and appends what it decides through the
 * command's transaction (create and rename; archive, pin and the reorders,
 * tags and the draft; the group a session is in; delete, restore and
 * purge, the purge carried out by `deletion.ts`); `sessions.list`,
 * `sessions.get`, `sessions.listDeleted` and `sessions.subscribe` read the
 * session-list projection, and `sessions.subscribeSession` follows one
 * session's stream. The group commands are `group-methods.ts`'s; the other
 * session methods are registered in the contracts and served by #117
 * (`OWED_HANDLERS`).
 */

export interface SessionMethodsOptions {
  readonly log: EventLog;
  /** The account, model and mode check `sessions.create` runs: the environment passes the adapter host's (`validateSessionInput`); preset: every value accepted. */
  readonly validateRunParameters?: RunParametersCheck;
  /** The clamp a mode `sessions.create` is given goes through before it is stored (#129); preset: kept as given. */
  readonly clampSessionMode?: SessionModeClamp;
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

export const sessionMethods = (options: SessionMethodsOptions): MethodHandlers => {
  const { log } = options;
  const validateRunParameters = options.validateRunParameters ?? acceptAnyRunParameters;
  const clampSessionMode = options.clampSessionMode ?? keepSessionMode;
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

  /** What a session command answers with unless it says otherwise: the summary it leaves. */
  type SummaryResult = { summary: SessionSummary };

  /**
   * Carries out a decision in the command's transaction: a refusal is the
   * rejected answer; events are appended with the command's id and actor, so
   * the projector writes the summary and its patch before the answer reads
   * it. The answer is the summary the command leaves, or what `result` reads
   * after it.
   */
  const carryOut = <R = SummaryResult>(
    id: string,
    decision: Decision,
    context: CommandContext,
    result?: () => R,
  ): CommandAnswer<R, Refusal["code"]> => {
    const aggregate = sessionStream(id);
    if (decision.rejected !== undefined) return { aggregate, rejected: decision.rejected };
    if (decision.events.length > 0) {
      log.append(aggregate, decision.events, { tx: context.tx, actor: context.actor, commandId: context.commandId });
    }
    return { aggregate, result: result === undefined ? ({ summary: summaryAfter(id) } as R) : result() };
  };

  /**
   * Runs a command on one existing session: its id in lowercase, the time
   * now for the decider to record, and its events stamped with that same
   * time, so a time in a payload and the event's `occurredAt` (the summary's
   * `updatedAt`) are one instant.
   */
  const onSession = <R = SummaryResult>(
    sessionId: string,
    context: CommandContext,
    decide: (state: SessionState | null, id: string, at: string) => Decision,
    result?: (id: string) => R,
  ): CommandAnswer<R, Refusal["code"]> => {
    const id = sessionId.toLowerCase();
    const at = clock().toISOString();
    const decision = decide(stateOf(id), id, at);
    const stamped: Decision = decision.rejected === undefined ? { events: stamp(decision.events, at) } : decision;
    return carryOut(id, stamped, context, result === undefined ? undefined : () => result(id));
  };

  return {
    "sessions.create": (params, context) => {
      const id = params.id.toLowerCase();
      const asked = { account: params.account ?? null, model: params.model ?? null, mode: params.mode ?? null };
      const issues = validateRunParameters(asked);
      if (issues.length > 0) throw new ContractError(invalidParams(issues, "The account, model or mode is not one this environment offers."));
      // The mode is stored as the caller's ceiling allows it (#129).
      const run = { ...asked, mode: asked.mode === null ? null : clampSessionMode(asked.mode, asked.account, context.clientSession) };
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

    "sessions.setGroup": (params, context) =>
      onSession(params.sessionId, context, (state, sessionId) => {
        const groupId = params.groupId?.toLowerCase() ?? null;
        return decideSetGroup(state, { sessionId, groupId }, { groupExists: groupId !== null && groupExists(reader, groupId) });
      }),

    // Answered with the deletion the projection holds after it, since a deleted session has no summary in the list.
    "sessions.delete": (params, context) =>
      onSession(
        params.sessionId,
        context,
        (state, sessionId, at) => decideDelete(state, { sessionId, at, deleteProviderTranscript: params.deleteProviderTranscript ?? false }),
        (id) => {
          const deletion = readDeletion(reader, id);
          if (deletion === null) throw new Error(`The session ${id} is not deleted after its delete applied.`);
          return { sessionId: id, ...deletion };
        },
      ),

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

    "sessions.listDeleted": () => ({ sessions: listDeleted(reader, clock()) }),

    "sessions.subscribe": () => ({
      stream: SESSION_LIST_SELECTOR,
      snapshot: () => ({ sequence: log.head(), sessions: listSummaries(reader), groups: listGroups(reader) }),
    }),

    /**
     * One session's stream, every event of it. A session that is not in
     * the list (unknown, deleted, or purged, whose stream holds only its
     * tombstone) is not found. The deletion that holds now ends the
     * subscription `deleted`, and so does the tombstone, should a purge land
     * while the catch-up is held.
     */
    "sessions.subscribeSession": ({ sessionId }) => {
      const id = sessionId.toLowerCase();
      const summaryOf = (): SessionSummary => {
        const summary = readSummary(reader, id);
        if (summary === null) throw new ContractError(sessionNotFound(id));
        return summary;
      };
      summaryOf();
      /**
       * Whether a `session.deleted` is the deletion that holds now: the
       * session is deleted (or gone) and no restore follows it on the
       * stream. A replay passes a deletion a restore undid. The projection is
       * committed before an event is published, so a live one reads it as
       * the event left it.
       */
      const holdsNow = (event: EventEnvelope): boolean => {
        const state = readSessionState(reader, id);
        if (state !== null && !state.deleted) return false;
        return !log.readStream(sessionStream(id), event.sequence).some((later) => later.type === "session.restored");
      };
      return {
        stream: sessionStream(id),
        // The runs, items and parked prompts are folded from the stream as it stands (`runs/transcript.ts`).
        snapshot: () => ({ sequence: log.head(), summary: summaryOf(), ...foldTranscript(log.readStream(sessionStream(id))) }),
        endOn: (event) =>
          event.type === "session.purged" || (event.type === "session.deleted" && holdsNow(event)) ? "deleted" : undefined,
      };
    },
  };
};
