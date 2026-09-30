import {
  ContractError,
  GROUP_STREAM_KIND,
  SESSION_STREAM_KIND,
  invalidParams,
  listEventTypes,
  type Mode,
  type ResultOf,
  type SessionOrigin,
  type SessionSummary,
  type Workspace,
} from "@agent-harness/contracts";
import type { AppendOptions, EventEnvelope, EventLog, Tx } from "../event-log/event-log.js";
import type { CommandAnswer, CommandContext, MethodHandler, MethodHandlers } from "../serve/methods.js";
import { appendDecided } from "./companions.js";
import { decideSettle, decideSnooze, decideUnsettle, decideUnsnooze } from "./shelf-decider.js";
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
  decideSetBrowser,
  decideSetDraft,
  decideSetGroup,
  decideTag,
  decideUnarchive,
  decideUnpin,
  decideUntag,
  refuseCreate,
  sessionNotFound,
  stampedAt,
  type Decision,
  type FirstBrowser,
  type Refusal,
  type SessionState,
} from "./decider.js";
import { createDeletion, type Deletion } from "./deletion.js";
import { groupExists, listGroups } from "./group-reads.js";
import { acceptAnyRunParameters, keepSessionMode, type RunParametersCheck, type SessionModeClamp } from "./run-parameters.js";
import { listDeleted, listSummaries, readDeletion, readSessionState, readSummary, type Reader } from "./session-reads.js";
import { sessionTranscript, storedTranscriptParts } from "../runs/transcript.js";
import { readSessionInstructions } from "../instructions/session-instructions.js";
import { sessionStream } from "./streams.js";
import type { LogSource } from "../wire/subscriptions.js";
import type { Resolution, WorkspaceResolver } from "../workspace/resolver.js";

/**
 * The session-organisation handlers on the method table (session-state
 * spec, "Commands" and "Subscriptions"). Each session command runs its
 * decider over the projection and appends what it decides, its own events
 * and their companions, through the command's transaction:
 * `sessions.create`, `sessions.rename`, `sessions.archive`,
 * `sessions.unarchive`, `sessions.pin`, `sessions.unpin`,
 * `sessions.reorderPinned`, `sessions.reorderActive`, `sessions.tag`,
 * `sessions.untag`, `sessions.setDraft`, `sessions.setBrowser`, `sessions.setGroup`,
 * `sessions.settle`, `sessions.unsettle`, `sessions.snooze`,
 * `sessions.unsnooze`, `sessions.delete`, `sessions.restore` and
 * `sessions.purge` (the purge carried out by `deletion.ts`). The queries
 * `sessions.list`, `sessions.get` and `sessions.listDeleted` and the stream
 * `sessions.subscribe` read the session-list projection;
 * `sessions.subscribeSession` follows one session's stream. The group
 * commands are `group-methods.ts`'s, the settings methods
 * `settings/methods.ts`'s, and the shelf's sweep `settle-sweep.ts`'s.
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
  /** What `sessions.create` resolves its workspace request with (#321): the environment's (`workspace/resolver.ts`), or a test's. */
  readonly resolver: WorkspaceResolver;
  /**
   * What a session's open waits for before its snapshot goes out, null when
   * nothing: an imported session's history appended the first time
   * (`carry-over/history.ts`, #579). Preset: nothing.
   */
  readonly beforeOpen?: (sessionId: string) => Promise<void> | null;
}

/** The streams and event types the session list carries: the `list`-flagged events of every session and group stream. */
export const SESSION_LIST_SELECTOR = {
  kinds: [SESSION_STREAM_KIND, GROUP_STREAM_KIND],
  types: listEventTypes([SESSION_STREAM_KIND, GROUP_STREAM_KIND]),
} as const;

/** A session to create, as `sessions.create` and the completions surface (#138) ask for one, its workspace as the resolver gave it. */
export interface SessionCreation {
  readonly id: string;
  readonly title?: string | null | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly groupId?: string | null | undefined;
  readonly workspace: Workspace;
  /** The repository identity the resolver found; none when absent. */
  readonly repositoryIdentity?: string | null | undefined;
  readonly account?: string | null | undefined;
  readonly model?: string | null | undefined;
  readonly mode?: Mode | null | undefined;
  /** Where the session came from when no client asked for it: the Carry over import's (#578); absent for a command's. */
  readonly origin?: SessionOrigin | undefined;
  /** The session's first browser and who chose it; none chosen when absent. */
  readonly browser?: FirstBrowser | null | undefined;
}

/** A creation's refusal: the decider's, or an account that cannot run. */
type CreationRefusal = Refusal | { readonly code: "conflict"; readonly message: string; readonly data: { reason: string; accountId: string } };

/** The checks a creation runs: the account, model and mode against the host, and the mode's clamp to the caller's ceiling. */
export interface SessionCreationChecks {
  readonly validateRunParameters: RunParametersCheck;
  readonly clampMode: (mode: Mode, account: string | null) => Mode | null;
}

/**
 * A creation checked as far as it can be without its workspace: the run
 * parameters (`invalid_params` thrown for one this environment does not
 * offer; an account that cannot run is the refusal `conflict`
 * `account_unavailable`), the mode clamped (#129), and what the decider
 * needs besides the workspace: the session's state and whether its group
 * is here.
 */
const checkCreation = (log: EventLog, creation: Omit<SessionCreation, "workspace" | "repositoryIdentity">, checks: SessionCreationChecks) => {
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  const id = creation.id.toLowerCase();
  const asked = { account: creation.account ?? null, model: creation.model ?? null, mode: creation.mode ?? null };
  const verdict = checks.validateRunParameters(asked);
  // An account that cannot run is the session's state, not a malformed request: refused with a receipt (#134).
  if (verdict.unavailable !== undefined) {
    const { accountId, message } = verdict.unavailable;
    const rejected: CreationRefusal = { code: "conflict", message, data: { reason: "account_unavailable", accountId } };
    return { rejected };
  }
  if (verdict.issues.length > 0) throw new ContractError(invalidParams(verdict.issues, "The account, model or mode is not one this environment offers."));
  // The mode is stored as the caller's ceiling allows it (#129).
  const mode = asked.mode === null ? null : checks.clampMode(asked.mode, asked.account);
  const groupId = creation.groupId?.toLowerCase() ?? null;
  const state = readSessionState(reader, id) ?? (log.readStream(sessionStream(id), 0, 1).length > 0 ? PURGED_STATE : null);
  const command = {
    id,
    title: creation.title ?? null,
    tags: [...(creation.tags ?? [])],
    groupId,
    account: asked.account,
    model: asked.model,
    mode,
    ...(creation.origin !== undefined && { origin: creation.origin }),
    browser: creation.browser ?? null,
  };
  return { state, command, context: { groupExists: groupId !== null && groupExists(reader, groupId) } };
};

/**
 * What refuses a creation whatever its workspace, checked before the
 * workspace is made (#321): the run parameters, as `checkCreation` reads
 * them, then the decider's cheap refusals, an id in use and a group not
 * here. Null when none does.
 */
export const refuseCreation = (
  log: EventLog,
  creation: Omit<SessionCreation, "workspace" | "repositoryIdentity">,
  checks: SessionCreationChecks,
): CreationRefusal | null => {
  const checked = checkCreation(log, creation, checks);
  if (checked.rejected !== undefined) return checked.rejected;
  return refuseCreate(checked.state, checked.command, checked.context)?.rejected ?? null;
};

/**
 * Creates a session in the open transaction `tx`, as `sessions.create`
 * does, in the workspace the resolver gave: the checks of `checkCreation`,
 * then the decider over the session's state (an id in use, a purged one's
 * included, is `conflict` `exists`; a group not here is `not_found`), its
 * events appended under `attribution`. Answers the refusal, or nothing.
 */
export const createSessionIn = (
  log: EventLog,
  attribution: AppendOptions & { readonly tx: Tx },
  creation: SessionCreation,
  checks: SessionCreationChecks,
): { readonly rejected: CreationRefusal } | { readonly rejected?: undefined } => {
  const checked = checkCreation(log, creation, checks);
  if (checked.rejected !== undefined) return checked;
  const { workspace, repositoryIdentity = null } = creation;
  const decision = decideCreate(checked.state, { ...checked.command, workspace, repositoryIdentity }, checked.context);
  if (decision.rejected !== undefined) return { rejected: decision.rejected };
  appendDecided(log, sessionStream(checked.command.id), decision, attribution);
  return {};
};

export const sessionMethods = (options: SessionMethodsOptions): MethodHandlers => {
  const { log } = options;
  const validateRunParameters = options.validateRunParameters ?? acceptAnyRunParameters;
  const clampSessionMode = options.clampSessionMode ?? keepSessionMode;
  const clock = options.clock ?? (() => new Date());
  const deletion = options.deletion ?? createDeletion({ log });
  const { resolver } = options;
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
    appendDecided(log, aggregate, decision, { tx: context.tx, actor: context.actor, commandId: context.commandId });
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
    return carryOut(id, stampedAt(decision, at), context, result === undefined ? undefined : () => result(id));
  };

  return {
    // A prepared command (#321): the request is resolved outside the transaction, once the cheap refusals have passed, so
    // nothing is made for a create refused anyway; what the resolver made goes again if the transaction still refuses.
    "sessions.create": {
      prepare: (params, context) => {
        const id = params.id.toLowerCase();
        const aggregate = sessionStream(id);
        const checks: SessionCreationChecks = {
          validateRunParameters,
          clampMode: (mode, account) => clampSessionMode(mode, account, context.clientSession),
        };
        const { workspace: request, ...creation } = { ...params, id };
        const doomed = refuseCreation(log, creation, checks);
        if (doomed !== null) return () => ({ aggregate, rejected: doomed });
        const handlerFor = (resolved: Resolution): MethodHandler<"sessions.create"> => {
          if (resolved.refused !== undefined) {
            const { refused } = resolved;
            return () => ({ aggregate, rejected: refused });
          }
          if (resolved.undo !== undefined) context.onUndo(resolved.undo);
          const { workspace, repositoryIdentity } = resolved;
          return (_params, command) => {
            const attribution = { tx: command.tx, actor: command.actor, commandId: command.commandId };
            const created = createSessionIn(log, attribution, { ...creation, workspace, repositoryIdentity }, checks);
            if (created.rejected !== undefined) return { aggregate, rejected: created.rejected };
            return { aggregate, result: { summary: summaryAfter(id) } };
          };
        };
        // A resolver's answer given at once (a scratch directory) keeps the create's place among its socket's requests.
        const resolved = resolver.resolve(request, id);
        return resolved instanceof Promise ? resolved.then(handlerFor) : handlerFor(resolved);
      },
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

    // The browser the session's next run resolves (#550), chosen by the person at the client; at runs:drive, which the wire checks.
    "sessions.setBrowser": (params, context) =>
      onSession(params.sessionId, context, (state, sessionId) => decideSetBrowser(state, { sessionId, browser: params.browser, chosenBy: "person" })),

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
     * while the catch-up is held. An open waits first for what `beforeOpen`
     * says it needs (an imported session's history, #579); one that needs
     * nothing is answered at once.
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
      const source: LogSource<ResultOf<"sessions.subscribeSession">> = {
        stream: sessionStream(id),
        // The runs, items, parked prompts and rewinds standing are folded from the stream as it stands, from its compaction's fold if it has one (`runs/transcript.ts`).
        snapshot: () => ({ sequence: log.head(), summary: summaryOf(), ...sessionTranscript(log, id), instructions: readSessionInstructions(reader, id) }),
        // A cursor older than the session's compaction (#123) gets its fold, at the compaction's sequence, then the events after it.
        // The summary and the session's instructions (#506) are read at the head: what is replayed after it sets what it set again.
        compacted: (snapshot) => ({ sequence: snapshot.sequence, summary: summaryOf(), ...storedTranscriptParts(snapshot.payload), instructions: readSessionInstructions(reader, id) }),
        endOn: (event) =>
          event.type === "session.purged" || (event.type === "session.deleted" && holdsNow(event)) ? "deleted" : undefined,
      };
      const waiting = options.beforeOpen?.(id) ?? null;
      return waiting === null ? source : waiting.then(() => source);
    },
  };
};
