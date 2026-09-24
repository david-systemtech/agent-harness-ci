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
import { decideCreate, decideRename, type Decision, type Refusal, type SessionState } from "./decider.js";
import { acceptAnyRunParameters, type RunParametersCheck } from "./run-parameters.js";
import { listGroups, listSummaries, readSessionState, readSummary, type Reader } from "./session-list.js";

/**
 * The session-organisation handlers on the method table (session-state
 * spec, "Commands" and "Subscriptions"): `sessions.create` and
 * `sessions.rename` run the decider over the projection and append what it
 * decides through the command's transaction; `sessions.list`, `sessions.get`
 * and `sessions.subscribe` read the session-list projection. The other
 * session and group methods are registered in the contracts and served by
 * #115 to #118.
 */

export interface SessionMethodsOptions {
  readonly log: EventLog;
  /** The account, model and mode check `sessions.create` runs; preset: every value accepted, until #119 and the permissions workstream fill it. */
  readonly validateRunParameters?: RunParametersCheck;
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
  // The log's query-only read: inside a command it reads that command's own transaction.
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  /**
   * The session's state for the decider. A session with no row but events on
   * its stream was purged: its id stays used, so it reads as deleted.
   */
  const stateOf = (id: string): SessionState | null =>
    readSessionState(reader, id) ?? (log.readStream(sessionStream(id), 0, 1).length > 0 ? { deleted: true, userTitle: null } : null);

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

  return {
    "sessions.create": (params, context) => {
      const id = params.id.toLowerCase();
      const run = { account: params.account ?? null, model: params.model ?? null, mode: params.mode ?? null };
      const issues = validateRunParameters(run);
      if (issues.length > 0) throw new ContractError(invalidParams(issues, "The account, model or mode is not one this environment offers."));
      const groupId = params.groupId?.toLowerCase() ?? null;
      const groupExists = groupId !== null && reader.all("SELECT 1 FROM groups WHERE id = ?", groupId).length > 0;
      const command = { id, title: params.title ?? null, tags: params.tags ?? [], groupId, workspace: params.workspace, ...run };
      return carryOut(id, decideCreate(stateOf(id), command, { groupExists }), context);
    },

    "sessions.rename": (params, context) => {
      const id = params.sessionId.toLowerCase();
      return carryOut(id, decideRename(stateOf(id), id, params.title), context);
    },

    "sessions.list": () => ({ sequence: log.head(), sessions: listSummaries(reader) }),

    "sessions.get": ({ sessionId }) => {
      const id = sessionId.toLowerCase();
      const summary = readSummary(reader, id);
      if (summary === null) {
        throw new ContractError({ code: "not_found", message: `No session ${id} is on this environment.`, data: { kind: "session", sessionId: id } });
      }
      return { summary };
    },

    "sessions.subscribe": () => ({
      stream: SESSION_LIST_SELECTOR,
      snapshot: () => ({ sequence: log.head(), sessions: listSummaries(reader), groups: listGroups(reader) }),
    }),
  };
};
