import {
  ContractError,
  GROUP_STREAM_KIND,
  SESSION_STREAM_KIND,
  invalidParams,
  listEventTypes,
  type SessionSummary,
} from "@agent-harness/contracts";
import type { EventLog, StreamRef } from "../event-log/event-log.js";
import type { CommandAnswer, CommandContext, MethodHandlers } from "../serve/methods.js";
import { appendDecided } from "./companions.js";
import { decideSettle, decideSnooze, decideUnsettle, decideUnsnooze } from "./shelf-decider.js";
import {
  PURGED_STATE,
  decideArchive,
  decideCreate,
  decidePin,
  decideRename,
  decideReorderActive,
  decideReorderPinned,
  decideSetDraft,
  decideTag,
  decideUnarchive,
  decideUnpin,
  decideUntag,
  sessionNotFound,
  stampedAt,
  type Decision,
  type Refusal,
  type SessionState,
} from "./decider.js";
import { acceptAnyRunParameters, type RunParametersCheck } from "./run-parameters.js";
import { groupExists, listGroups, listSummaries, readSessionState, readSummary, type Reader } from "./session-reads.js";

/**
 * The session-organisation handlers on the method table (session-state
 * spec, "Commands" and "Subscriptions"): each session command runs its
 * decider over the projection and appends what it decides through the
 * command's transaction (create and rename; archive, pin and the reorders,
 * tags and the draft); `sessions.list`, `sessions.get` and
 * `sessions.subscribe` read the session-list projection. The other session
 * and group methods are registered in the contracts and served by #116 to
 * #118 (`OWED_HANDLERS`).
 */

export interface SessionMethodsOptions {
  readonly log: EventLog;
  /** The account, model and mode check `sessions.create` runs; preset: every value accepted, until #119 and the permissions workstream fill it. */
  readonly validateRunParameters?: RunParametersCheck;
  /** The environment's clock, which stamps the times a command records (`archivedAt`, `pinnedAt`); preset: the system's. */
  readonly clock?: () => Date;
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
    appendDecided(log, aggregate, decision, { tx: context.tx, actor: context.actor, commandId: context.commandId });
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
    return carryOut(id, stampedAt(decision, at), context);
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

    // The shelf (#117): settle and unsettle are never refused for lifecycle reasons; their companions share the command's transaction.
    "sessions.settle": (params, context) =>
      onSession(params.sessionId, context, (state, sessionId, at) => decideSettle(state, { sessionId, at, by: "user" })),

    "sessions.unsettle": (params, context) =>
      onSession(params.sessionId, context, (state, sessionId, at) => decideUnsettle(state, { sessionId, at })),

    // Not found first, then the window against the command's own instant: an until outside it is rejected
    // out_of_window in the receipt; one that is not a UTC timestamp was invalid_params at the wire.
    "sessions.snooze": (params, context) => {
      const id = params.sessionId.toLowerCase();
      const at = clock().toISOString();
      const decision = decideSnooze(stateOf(id), { sessionId: id, at, until: params.until });
      if (decision.rejected?.code === "out_of_window") return { aggregate: sessionStream(id), rejected: decision.rejected };
      return carryOut(id, stampedAt(decision as Decision, at), context);
    },

    "sessions.unsnooze": (params, context) =>
      onSession(params.sessionId, context, (state, sessionId) => decideUnsnooze(state, { sessionId, reason: "user" })),

    "sessions.tag": (params, context) => onSession(params.sessionId, context, (state, sessionId) => decideTag(state, { sessionId, tag: params.tag })),

    "sessions.untag": (params, context) =>
      onSession(params.sessionId, context, (state, sessionId) => decideUntag(state, { sessionId, tag: params.tag })),

    "sessions.setDraft": (params, context) =>
      onSession(params.sessionId, context, (state, sessionId) => decideSetDraft(state, { sessionId, draft: params.draft })),

    "sessions.list": () => ({ sequence: log.head(), sessions: listSummaries(reader) }),

    "sessions.get": ({ sessionId }) => {
      const id = sessionId.toLowerCase();
      const summary = readSummary(reader, id);
      if (summary === null) throw new ContractError(sessionNotFound(id));
      return { summary };
    },

    "sessions.subscribe": () => ({
      stream: SESSION_LIST_SELECTOR,
      snapshot: () => ({ sequence: log.head(), sessions: listSummaries(reader), groups: listGroups(reader) }),
    }),
  };
};
