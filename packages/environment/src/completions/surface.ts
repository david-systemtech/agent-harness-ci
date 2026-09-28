import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, join } from "node:path";
import {
  CHAT_COMPLETIONS_PATH,
  COMPLETIONS_HEARTBEAT_MS,
  COMPLETIONS_NAMESPACE,
  ContractError,
  MODELS_PATH,
  type ChatCompletion,
  type ChatCompletionChunk,
  type CompletionsModelList,
  type EnvironmentReadiness,
  type Scope,
  type WireError,
  type Workspace,
} from "@agent-harness/contracts";
import type { AdapterHost } from "../adapter/host.js";
import type { ClientSessions, VerifiedClientSession } from "../auth/client-sessions.js";
import { formatActor, type EventEnvelope, type EventLog } from "../event-log/event-log.js";
import type { RunActor } from "../permissions/resolver.js";
import { readRun, readSessionFacts } from "../runs/run-reads.js";
import { requireAttachmentKinds } from "../runs/run-decider.js";
import { sendIn, startRunIn } from "../runs/run-methods.js";
import type { Clock, Timer } from "../serve/clock.js";
import { BodyTooLargeError, readBody, sendJson, type RouteHandler } from "../serve/http.js";
import type { MethodTable } from "../serve/methods.js";
import { appendDecided } from "../sessions/companions.js";
import { decideTag } from "../sessions/decider.js";
import { createSessionIn } from "../sessions/methods.js";
import { readSessionState, type Reader } from "../sessions/session-reads.js";
import { sessionStream } from "../sessions/streams.js";
import { createDispatch } from "../wire/dispatch.js";
import type { Resolution, WorkspaceResolver } from "../workspace/resolver.js";
import { createRenderer, type AnswerEnd, type AnswerHead } from "./answer.js";
import { CompletionsRefusal, asRefusal, fromContractError, sendRefusal, type RefusalContext } from "./errors.js";
import { listModels, listingId, modelObject, resolveModel, type CompletionsCatalogue, type ResolvedModel } from "./models.js";
import type { Passthrough } from "./passthrough.js";
import { readTurnRequest, sameTools, withPreamble, type TurnRequest } from "./request.js";

/**
 * The completions surface (claude-adapter spec, "The completions surface";
 * ADR 0015, ADR 0006; #138): OpenAI's routes under `/v1/` on the wire's
 * port, for programs such as the Hermes bots.
 *
 * - **Routes**: `POST /v1/chat/completions`, `GET /v1/models` and
 *   `GET /v1/models/<id>`, the id the rest of the path; every other path
 *   under `/v1/` is 501 with a sentence.
 * - **Authentication**: the bearer token of a client session of kind
 *   `program`: 401 for none, one not issued here, a revoked or an expired
 *   one; 403 for another kind of client session, or a scope the route needs
 *   (`read` for the models, `sessions:write` and `runs:drive` for a turn)
 *   that it lacks. 503 before the startup gate, and for a turn while the
 *   environment drains.
 * - **A turn is an ordinary run** on an ordinary session, started in one
 *   transaction with the session it needs: a fresh session (the directory
 *   the request names, or a scratch directory of its own under the data
 *   directory) or the one `sessionId` names, tagged `completions`; its run
 *   has origin `completions` and actor kind `completions`, attended only when
 *   the request says so, under the program's ceiling as it is now (#129,
 *   #131). On a session whose run is live, the turn is a steer
 *   (`runs.send`'s queue path) and the answer follows the run that reads it,
 *   naming the live run's model.
 * - **Continuity**: no `sessionId` is a fresh session, and the earlier
 *   messages ride as a preamble; a session named is continued, and they are
 *   dropped. `forkSession` and `rewindToMessageId` go through
 *   `sessions.fork` and `sessions.rewind` (#137) as the program's client
 *   session; the turn then runs on the fork, or on the rewound session, as
 *   a continued session.
 * - **The answer** (`answer.ts`) follows the session's events: live ones
 *   from the log's subscription, earlier ones read back, deduplicated by
 *   sequence. A stream sends each chunk as an SSE `data:` line and an SSE
 *   comment after fifteen silent seconds on the environment's clock, and
 *   ends with `[DONE]`; a whole answer waits for the end. A client that goes
 *   away stops only its answer: the run goes on.
 * - **The caller's tools** (#139, `passthrough.ts`): a request's `tools`
 *   are served to its run as the `client` tool server; a call the model
 *   makes to one is parked and returned as `tool_calls`, ending the answer
 *   with `finish_reason: tool_calls`; a follow-up whose trailing messages
 *   are the tool results (matched by `tool_call_id` alone, whatever session
 *   it names or leaves out) resumes the parked turn, and its answer carries
 *   the turn on from there.
 */

/** The largest request body taken: 20 MiB attachments travel base64 inside it. A chosen default. */
export const MAX_COMPLETIONS_BODY_BYTES = 64 * 1024 * 1024;

/**
 * How much of a streamed answer may wait unsent for a client that stopped
 * reading: past it, and still past it fifteen seconds later with nothing
 * drained, the connection is closed (the run goes on). A chosen default: a
 * reading client never holds more than a burst. A whole answer has no such
 * cutoff: it is one write, of a body the surface already held whole while
 * the run went on, so nothing grows after it.
 */
export const MAX_BUFFERED_ANSWER_BYTES = 4 * 1024 * 1024;

/** Where fresh sessions without a named workspace get their scratch directories, under the data directory. */
export const SCRATCH_DIRECTORY = "scratch";

/** The actor the log names for a completions request's run events (#131). */
const COMPLETIONS_ACTOR = formatActor({ kind: "system", id: "completions" });

/** The tag every session a turn runs on carries. */
export const COMPLETIONS_TAG = "completions";

export interface CompletionsSurfaceOptions {
  readonly log: EventLog;
  readonly host: AdapterHost;
  readonly clock: Clock;
  /** Token verification, and a client session's ceiling as it is now. */
  readonly clientSessions: Pick<ClientSessions, "verify" | "ceiling">;
  readonly readiness: () => EnvironmentReadiness;
  readonly catalogue: CompletionsCatalogue;
  /** The method table, for `sessions.fork` and `sessions.rewind`, run as the program's client session. */
  readonly methods: MethodTable;
  /** The data directory's scratch root: `<data dir>/scratch`. */
  readonly scratchRoot: string;
  /** Client-tool passthrough (#139): the parked calls, and the tools each session's runs were served. */
  readonly passthrough: Passthrough;
  /** The resolver a fresh session's workspace goes through, as `sessions.create`'s does (#321). */
  readonly resolver: WorkspaceResolver;
}

export interface CompletionsSurface {
  /** Serves every request under `/v1/`. */
  readonly handle: RouteHandler;
  /** Ends every answer still open with a final error chunk; the environment is stopping. */
  close(): void;
}

/** Whether `path` is a directory the environment can see. */
const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** The scopes a turn needs. */
const TURN_SCOPES: readonly Scope[] = ["sessions:write", "runs:drive"];

const notImplemented = (method: string, path: string): CompletionsRefusal =>
  new CompletionsRefusal(501, "not_implemented", `${method} ${path} is not served here; this environment serves ${CHAT_COMPLETIONS_PATH} and ${MODELS_PATH}.`);

const wrongMethod = (path: string, allow: string): CompletionsRefusal =>
  new CompletionsRefusal(405, "method_not_allowed", `${path} takes ${allow}.`, { headers: { allow } });

export const createCompletionsSurface = (options: CompletionsSurfaceOptions): CompletionsSurface => {
  const { log, host, clock, catalogue, passthrough } = options;
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  const dispatch = createDispatch(options.methods, log);
  /** Every answer still being written: ended with an error chunk when the environment stops. */
  const open = new Set<{ abandon(): void }>();
  const seconds = (): number => Math.floor(clock.now().getTime() / 1000);

  /** The program's client session from the bearer token, with every scope `scopes` names. */
  const authenticate = (request: IncomingMessage, scopes: readonly Scope[]): VerifiedClientSession => {
    const header = request.headers.authorization ?? "";
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
    if (match === null) {
      throw new CompletionsRefusal(401, "unauthorized", "Send the token of a program's client session as Authorization: Bearer <token>.", {
        headers: { "www-authenticate": "Bearer" },
      });
    }
    const verified = options.clientSessions.verify(match[1] as string);
    if (!verified.ok) throw new CompletionsRefusal(401, verified.reason, verified.message, { headers: { "www-authenticate": "Bearer" } });
    const { clientSession } = verified;
    if (clientSession.kind !== "program") {
      throw new CompletionsRefusal(
        403,
        "client_kind",
        `The completions surface serves the client sessions of programs; this one is a ${clientSession.kind}'s. Pair the program as kind program.`,
      );
    }
    const missing = scopes.filter((scope) => !clientSession.scopes.includes(scope));
    if (missing.length > 0) {
      throw new CompletionsRefusal(403, "forbidden", `This needs the ${missing.join(" and ")} scope${missing.length > 1 ? "s" : ""}, which the client session does not hold.`);
    }
    return clientSession;
  };

  /**
   * Set by `close`: the environment is stopping. A turn is refused when it
   * arrives, and again after each wait (its body, a fork or a rewind), so one
   * that was waiting when `close` ran starts nothing; an answer opened after
   * it is abandoned at once.
   */
  let closed = false;

  const ready = (forTurn: boolean): void => {
    if (closed) throw new CompletionsRefusal(503, "unavailable", "The environment is stopping.", { headers: { "retry-after": "30" } });
    const readiness = options.readiness();
    if (readiness === "starting") throw new CompletionsRefusal(503, "unavailable", "The environment is starting.", { headers: { "retry-after": "5" } });
    if (forTurn && readiness === "draining") throw new CompletionsRefusal(503, "unavailable", "The environment is draining for a restart; no new turn is taken.", { headers: { "retry-after": "30" } });
  };

  // ---- models ----

  const models = (request: IncomingMessage, response: ServerResponse, id: string | null): void => {
    authenticate(request, ["read"]);
    ready(false);
    if (id === null) {
      const list: CompletionsModelList = { object: "list", data: listModels(catalogue, seconds()) };
      return sendJson(response, 200, list, { "cache-control": "no-store" });
    }
    let asked: string;
    try {
      asked = decodeURIComponent(id);
    } catch {
      asked = id;
    }
    const resolved = resolveModel(catalogue, asked);
    if (resolved === undefined) throw new CompletionsRefusal(404, "model_not_found", `No model ${id} is offered here; GET ${MODELS_PATH} lists them.`, { param: "model" });
    // The listing holds signed-in accounts only, and so does reading one of it.
    if (!resolved.account.signedIn) {
      throw new CompletionsRefusal(404, "model_not_found", `The account ${resolved.account.label} is not signed in, so ${resolved.id} is not offered now.`, { param: "model" });
    }
    sendJson(response, 200, modelObject(resolved, seconds()), { "cache-control": "no-store" });
  };

  // ---- commands run as the program's client session ----

  /**
   * Runs a fork or a rewind (#137) as the program's client session, through
   * the method table, so its scope is checked where every client's is. Its
   * refusal names the request's field that asked for it (`field`), a message
   * not in the session's visible transcript `rewindToMessageId` and a
   * session not here `sessionId`; the environment's own failure names none.
   */
  const command = async (clientSession: VerifiedClientSession, method: "sessions.fork" | "sessions.rewind", params: Record<string, unknown>, field: string): Promise<void> => {
    const answer = await new Promise<{ result?: Record<string, unknown>; error?: WireError }>((resolve) => {
      void dispatch(
        { type: "request", id: randomUUID(), method, params: { commandId: randomUUID(), ...params } },
        clientSession,
        (value) => resolve(value as { result?: Record<string, unknown>; error?: WireError }),
        () => resolve({ error: { code: "internal", message: `${method} is a stream.`, data: {} } }),
      );
    });
    const receipt = answer.result?.["receipt"] as { status: string; error?: WireError } | undefined;
    const error = answer.error ?? (receipt?.status === "rejected" ? receipt.error : undefined);
    if (error === undefined) return;
    const refusal = fromContractError(new ContractError(error));
    const kind = error.code === "not_found" ? error.data["kind"] : undefined;
    const param = kind === "message" ? `${COMPLETIONS_NAMESPACE}.rewindToMessageId` : kind === "session" ? `${COMPLETIONS_NAMESPACE}.sessionId` : field;
    // The environment's own failure is about no field.
    throw new CompletionsRefusal(refusal.status, refusal.code, refusal.message, { param: refusal.status >= 500 ? null : param });
  };

  // ---- a turn ----

  /** A fresh session's place: the workspace and identity to record, and how to remove what was made for it when the turn records nothing. */
  interface Place {
    readonly workspace: Workspace;
    readonly repositoryIdentity: string | null;
    discard(): Promise<void>;
  }

  /**
   * Where a fresh session's code lives: the directory the request names, or
   * a scratch directory of its own, asked of the resolver as a `directory`
   * request (#321), which records it and finds its identity as it does for
   * `sessions.create`. A refusal is a 400 naming the workspace, and leaves
   * no scratch directory behind.
   */
  const placeFor = async (turn: TurnRequest, sessionId: string): Promise<Place> => {
    const named = turn.extension.workspace;
    const param = `${COMPLETIONS_NAMESPACE}.workspace`;
    let path: string;
    if (named !== null) {
      if (!isAbsolute(named)) throw new CompletionsRefusal(400, "workspace_not_found", `The workspace is an absolute path to a directory the environment has; ${named} is not absolute.`, { param });
      if (!isDirectory(named)) throw new CompletionsRefusal(400, "workspace_not_found", `The environment has no directory ${named}.`, { param });
      path = named;
    } else {
      path = join(options.scratchRoot, sessionId);
      mkdirSync(path, { recursive: true, mode: 0o700 });
    }
    const removeScratch = (): void => {
      if (named === null) rmSync(path, { recursive: true, force: true });
    };
    let resolved: Resolution;
    try {
      resolved = await options.resolver.resolve({ kind: "directory", path }, sessionId);
    } catch (error) {
      removeScratch();
      throw error;
    }
    if (resolved.refused !== undefined) {
      removeScratch();
      const { reason } = resolved.refused.data;
      throw new CompletionsRefusal(400, typeof reason === "string" ? reason : resolved.refused.code, resolved.refused.message, { param });
    }
    const { workspace, repositoryIdentity, undo } = resolved;
    return {
      workspace,
      repositoryIdentity,
      discard: async () => {
        await undo?.();
        removeScratch();
      },
    };
  };

  /** The run's actor: the completions surface, attended only when the request says so, under the program's ceiling as it is now (#129, #131). */
  const actorFor = (turn: TurnRequest, clientSession: VerifiedClientSession): RunActor => ({
    kind: "completions",
    attended: turn.extension.attended,
    ceiling: options.clientSessions.ceiling(clientSession.id) ?? clientSession.ceiling,
    clientSessionId: clientSession.id,
  });

  const sessionNotFound = (sessionId: string): CompletionsRefusal =>
    new CompletionsRefusal(404, "session_not_found", `No session ${sessionId} is on this environment.`, { param: `${COMPLETIONS_NAMESPACE}.sessionId` });

  const accountMismatch = (sessionId: string, accountId: string | null, model: ResolvedModel): CompletionsRefusal =>
    new CompletionsRefusal(
      409,
      "account_mismatch",
      `The session ${sessionId} runs on the account ${accountId ?? "(none)"}, not ${model.account.id}; name one of its models, or fork it onto the other account with ${COMPLETIONS_NAMESPACE}.forkSession.`,
      { param: "model" },
    );

  /**
   * The refusals a turn would meet anyway, checked before a fork or a rewind
   * is recorded, so a turn refused for its own request leaves neither behind:
   * the account signed in, the effort one the model takes, each attachment a
   * kind the model's adapter takes, and the named session here and on the
   * model's account (a fork moves it onto the model's). Each commits in a
   * transaction of its own, so a refusal these do not foresee still leaves
   * it: a race (the environment beginning to stop or drain, the account
   * signed out or the session deleted meanwhile), or no mode at or below the
   * ceiling available to the account, which no Claude account meets.
   */
  const precheck = (turn: TurnRequest, model: ResolvedModel, clientSession: VerifiedClientSession): void => {
    const account = host.account(model.account.id);
    if (account === null || !account.signedIn) {
      throw new CompletionsRefusal(409, "account_unavailable", `The account ${model.account.label} is not signed in on this environment, so no run can start on it.`, { param: "model" });
    }
    if (turn.effort !== null && !model.model.efforts.includes(turn.effort)) {
      throw new CompletionsRefusal(400, "invalid_params", `The model ${model.id} does not take the effort ${turn.effort}.`, { param: turn.effortParam });
    }
    requireAttachmentKinds(account.descriptor, turn.extension.attachments, [COMPLETIONS_NAMESPACE]);
    const { sessionId, forkSession } = turn.extension;
    if (sessionId === null) return;
    const facts = host.startFacts(sessionId, actorFor(turn, clientSession));
    if (facts.session === null || facts.session.deleted) throw sessionNotFound(sessionId);
    if (!forkSession && facts.accountId !== model.account.id) throw accountMismatch(sessionId, facts.accountId, model);
  };

  /**
   * What the turn recorded: the session, the run the answer follows, the
   * message (none for tool results, which resume a turn), whether it was
   * queued to a live run, the model the answer names, and the first chunk's
   * fields.
   */
  interface Begun {
    readonly sessionId: string;
    readonly runId: string;
    readonly messageId: string | null;
    readonly queued: boolean;
    /** The model the message is read in, by its listing id: the requested one for a new run, the live run's for a queued message or tool results (its bare id once its account has left the listing). */
    readonly model: string;
    readonly head: AnswerHead;
    /** The sequence an answer to tool results starts from: the log's head when it began following. */
    readonly startSeq?: number;
  }

  /** The live run's model by its listing id, else its bare id once its account has left the listing (removed while the run went on). */
  const modelOfRun = (runId: string, fallback: string): string => {
    const running = readRun(reader, runId);
    return running === null ? fallback : (listingId(catalogue, running.accountId, running.model) ?? running.model);
  };

  /**
   * What the caller's tools on a request that cannot give a run its tools
   * (the run is live already) come to: `tools` ignored when they are not the
   * ones the session's run was served, `tool_choice` when it would withhold
   * them, since a live run keeps what it started with.
   */
  const liveToolsIgnored = (turn: TurnRequest, sessionId: string): string[] => [
    ...(turn.tools.declared !== null && !sameTools(turn.tools.declared, passthrough.toolsOf(sessionId) ?? []) ? ["tools"] : []),
    ...(turn.tools.withheld ? ["tool_choice"] : []),
  ];

  /**
   * The turn, in one transaction: a fresh session made in its `place` as
   * `sessions.create` makes one (`createSessionIn`), or the named one tagged;
   * then the run started as `runs.start` starts one (`startRunIn`), or, when
   * one is live, the message queued to it as `runs.send` queues one
   * (`sendIn`). Nothing is recorded when anything refuses; the caller then
   * discards the place.
   */
  const begin = (
    turn: TurnRequest,
    model: ResolvedModel,
    clientSession: VerifiedClientSession,
    target: { sessionId: string; fresh: boolean },
    place: Place | null,
  ): Begun => {
    const { sessionId, fresh } = target;
    const clientActor = formatActor({ kind: "client_session", id: clientSession.id });
    const ignored = [...turn.ignored];
    if (!fresh && turn.extension.workspace !== null) ignored.push(`${COMPLETIONS_NAMESPACE}.workspace`);
    const refused = (refusal: { code: string; message: string; data: Record<string, unknown> }): ContractError => new ContractError(refusal);
    return log.atomically((tx) => {
      if (place !== null) {
        const created = createSessionIn(
          log,
          { tx, actor: clientActor },
          {
            id: sessionId,
            tags: [COMPLETIONS_TAG],
            workspace: place.workspace,
            repositoryIdentity: place.repositoryIdentity,
            account: model.account.id,
            model: model.model.id,
          },
          // The session is given no mode of its own: the request's permissionMode is its run's alone.
          { validateRunParameters: host.validateSessionInput, clampMode: () => null },
        );
        if (created.rejected !== undefined) throw refused(created.rejected);
      } else {
        const tagged = decideTag(readSessionState(reader, sessionId), { sessionId, tag: COMPLETIONS_TAG });
        if (tagged.rejected === undefined) appendDecided(log, sessionStream(sessionId), tagged, { tx, actor: clientActor });
      }
      const actor = actorFor(turn, clientSession);
      const facts = host.startFacts(sessionId, actor);
      if (facts.session === null || facts.session.deleted) throw sessionNotFound(sessionId);
      if (facts.accountId !== model.account.id) throw accountMismatch(sessionId, facts.accountId, model);
      const text = fresh ? withPreamble(turn.earlier, turn.text) : turn.text;
      const attachments = [...turn.extension.attachments];

      if (facts.live !== null) {
        // A run is live: the turn is a queued message (ADR 0022), and the answer follows the run that reads it (#138).
        const sent = sendIn(log, host, tx, { actor: COMPLETIONS_ACTOR }, { sessionId, actor, origin: "completions", text, attachments });
        if (sent.rejected !== undefined) throw refused(sent.rejected);
        // What a live run cannot take is said to be ignored. Its model first: whichever run reads the message runs on the
        // live run's (the live run, a run of its queue, which takes the model of the run before it, or a turn its provider
        // opens), so the answer names that one, by its bare id once its account has left the listing (removed mid-run),
        // and a request naming another is told so. A live run's row is there: `run.started` wrote it, and only a purge,
        // refused above for a deleted session, takes it away.
        const answeredIn = modelOfRun(facts.live.runId, model.id);
        if (answeredIn !== model.id) ignored.push("model");
        if (turn.extension.permissionMode !== null) ignored.push(`${COMPLETIONS_NAMESPACE}.permissionMode`);
        ignored.push(...turn.instructionSources);
        if (turn.effortParam !== null) ignored.push(turn.effortParam);
        if (turn.extension.attendedSet) ignored.push(`${COMPLETIONS_NAMESPACE}.attended`);
        ignored.push(...liveToolsIgnored(turn, sessionId));
        const { runId, messageId } = sent.result;
        return {
          sessionId,
          runId,
          messageId,
          queued: true,
          model: answeredIn,
          head: { sessionId, runId, messageId, delivery: "queued", mode: facts.live.policy.mode.effective, clamped: null, ignored },
        };
      }

      // Nothing is live to attach to: a new run starts, and `after` says nothing.
      if (turn.extension.after !== null) ignored.push(`${COMPLETIONS_NAMESPACE}.after`);
      const started = startRunIn(log, host, tx, { actor: COMPLETIONS_ACTOR }, {
        sessionId,
        actor,
        origin: "completions",
        text,
        attachments,
        model: model.model.id,
        effort: turn.effort ?? undefined,
        mode: turn.extension.permissionMode ?? undefined,
        appendedInstructions: turn.appendedInstructions,
        clientTools: turn.tools.served,
      });
      if (started.rejected !== undefined) throw refused(started.rejected);
      const { mode } = started.policy;
      return {
        sessionId,
        runId: started.runId,
        messageId: started.messageId,
        queued: false,
        model: model.id,
        head: {
          sessionId,
          runId: started.runId,
          messageId: started.messageId,
          delivery: "prompt",
          mode: mode.effective,
          clamped: mode.clamped && mode.requested !== null && mode.clampReason !== null ? { requested: mode.requested, effective: mode.effective, ceiling: mode.ceiling, reason: mode.clampReason } : null,
          ignored,
        },
      };
    });
  };

  /** Where a queued message is now: still with the provider, waiting in the environment's queue, or read. */
  const holderOf = (messageId: string): "wait" | "queued" | "read" => {
    const [row] = reader.all<{ held_by: string }>("SELECT held_by FROM run_messages WHERE message_id = ?", messageId);
    if (row?.held_by === "provider") return "wait";
    if (row?.held_by === "read") return "read";
    return "queued";
  };

  /** The session a turn runs on: fresh, the named one, or a fork of it; a rewind first when asked for. */
  const target = async (turn: TurnRequest, model: ResolvedModel, clientSession: VerifiedClientSession): Promise<{ sessionId: string; fresh: boolean }> => {
    const { sessionId, forkSession, rewindToMessageId } = turn.extension;
    if (sessionId === null) {
      for (const [set, name] of [
        [forkSession, "forkSession"],
        [rewindToMessageId !== null, "rewindToMessageId"],
      ] as const) {
        if (set) throw new CompletionsRefusal(400, "invalid_params", `${COMPLETIONS_NAMESPACE}.${name} needs a sessionId.`, { param: `${COMPLETIONS_NAMESPACE}.${name}` });
      }
      return { sessionId: randomUUID(), fresh: true };
    }
    if (forkSession) {
      const forkId = randomUUID();
      await command(
        clientSession,
        "sessions.fork",
        { sessionId, id: forkId, ...(rewindToMessageId !== null && { atMessageId: rewindToMessageId }), account: model.account.id },
        `${COMPLETIONS_NAMESPACE}.forkSession`,
      );
      return { sessionId: forkId, fresh: false };
    }
    if (rewindToMessageId !== null) {
      await command(clientSession, "sessions.rewind", { sessionId, messageId: rewindToMessageId }, `${COMPLETIONS_NAMESPACE}.rewindToMessageId`);
    }
    return { sessionId, fresh: false };
  };

  /** Whether the client went away before its answer was written, and what to stop when it does. */
  interface Exchange {
    gone: boolean;
    onGone: (() => void) | undefined;
  }

  /**
   * Follows a session's events from the moment it is called: those that
   * arrive meanwhile are held, and `start` delivers what the log holds after
   * a cursor, then the held ones, then the live ones, each once, in order.
   */
  const follow = (sessionId: string) => {
    const held: EventEnvelope[] = [];
    let deliver: ((event: EventEnvelope) => void) | undefined;
    const stop = log.subscribe((event) => {
      if (event.streamKind !== "session" || event.streamId !== sessionId) return;
      if (deliver === undefined) held.push(event);
      else deliver(event);
    });
    return {
      /** The log's head when following began: nothing after it can be missed. */
      head: log.head(),
      start(after: number, sink: (event: EventEnvelope) => void): void {
        let cursor = after;
        const feed = (event: EventEnvelope): void => {
          if (event.sequence <= cursor) return;
          cursor = event.sequence;
          sink(event);
        };
        for (const event of log.readStream(sessionStream(sessionId), after)) feed(event);
        for (const event of held.splice(0)) feed(event);
        deliver = feed;
      },
      stop,
    };
  };
  type Follower = ReturnType<typeof follow>;

  const chat = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // A client that goes away early stops its answer, and whatever it holds, however far the request got.
    const exchange: Exchange = { gone: false, onGone: undefined };
    response.once("close", () => {
      if (response.writableFinished) return;
      exchange.gone = true;
      exchange.onGone?.();
    });
    const clientSession = authenticate(request, TURN_SCOPES);
    // A turn is refused while the environment drains, after the body says what it is: tool results resume a running turn,
    // which the drain lets finish.
    ready(false);
    let text: string;
    try {
      text = await readBody(request, MAX_COMPLETIONS_BODY_BYTES);
    } catch (error) {
      if (error instanceof BodyTooLargeError) throw new CompletionsRefusal(413, "too_large", error.message);
      throw error;
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new CompletionsRefusal(400, "invalid_json", "The request body is not JSON.");
    }
    const turn = readTurnRequest(body);
    // The environment may have begun to stop while the body was read.
    ready(turn.toolResults.length === 0);
    if (turn.extension.after !== null && turn.extension.after > log.head()) {
      throw new CompletionsRefusal(400, "invalid_params", `after ${turn.extension.after} is past the log's head, ${log.head()}.`, { param: `${COMPLETIONS_NAMESPACE}.after` });
    }
    if (turn.toolResults.length > 0) return resume(response, turn, clientSession, exchange);
    // A bare model continuing a session is the session's account's, so a change of default leaves the conversation where it was.
    const named = turn.extension.sessionId === null ? null : readSessionFacts(log, reader, turn.extension.sessionId);
    const model = resolveModel(catalogue, turn.model, named?.account ?? catalogue.defaultAccountId());
    if (model === undefined) throw new CompletionsRefusal(404, "model_not_found", `No model ${turn.model} is offered here; GET ${MODELS_PATH} lists them.`, { param: "model" });
    precheck(turn, model, clientSession);
    if (exchange.gone) return;
    const where = await target(turn, model, clientSession);
    if (exchange.gone) return;
    // A fresh session's place, through the resolver (#321): a wait too, after which the turn is checked again.
    const place = where.fresh ? await placeFor(turn, where.sessionId) : null;
    if (exchange.gone) {
      await place?.discard();
      return;
    }
    // Or while a fork or a rewind was asked for, or the place resolved.
    try {
      ready(true);
    } catch (error) {
      await place?.discard();
      throw error;
    }

    // Listen before anything is recorded, so no event of the turn is missed; what came before `after` is read back.
    const follower = follow(where.sessionId);
    let begun: Begun;
    try {
      begun = begin(turn, model, clientSession, where, place);
    } catch (error) {
      follower.stop();
      await place?.discard();
      // A fresh session's id names nothing once its transaction rolled back.
      throw asRefusal(error, where.fresh ? undefined : { sessionId: where.sessionId });
    }
    answer(response, turn, begun, follower, exchange);
  };

  /**
   * A follow-up whose trailing messages are tool results (#139): each is
   * matched to a parked call by its `tool_call_id` alone, whatever session
   * the request names or leaves out; the calls resolve with the caller's
   * text and the answer carries the same turn on from there, in the run's
   * model. It records nothing of its own: the provider reports what it
   * reads. What the running turn cannot take is reported ignored, as for a
   * queued message, and so is a result no call waits for, once another
   * matched; none matching is 404.
   */
  const resume = (response: ServerResponse, turn: TurnRequest, clientSession: VerifiedClientSession, exchange: Exchange): void => {
    const matched: { readonly id: string; readonly text: string; readonly sessionId: string }[] = [];
    const unmatched: number[] = [];
    for (const result of turn.toolResults) {
      const call = passthrough.find(result.toolCallId);
      // A second result for one call is as stray as one for no call.
      if (call === undefined || matched.some((other) => other.id === call.id)) unmatched.push(result.index);
      else matched.push({ id: call.id, text: result.text, sessionId: call.sessionId });
    }
    const [first] = matched;
    if (first === undefined) {
      const [result] = turn.toolResults;
      throw new CompletionsRefusal(
        404,
        "tool_call_not_found",
        `No call ${result?.toolCallId ?? ""} waits for its result here: it was answered already, it expired, or its run ended.`,
        { param: `messages.${result?.index ?? 0}.tool_call_id` },
      );
    }
    const { sessionId } = first;
    const other = matched.find((call) => call.sessionId !== sessionId);
    if (other !== undefined) {
      const at = turn.toolResults.find((result) => result.toolCallId === other.id);
      throw new CompletionsRefusal(400, "invalid_params", "The tool results answer calls of two sessions' runs; send each session's in a request of its own.", {
        param: `messages.${at?.index ?? 0}.tool_call_id`,
      });
    }
    const named = turn.extension.sessionId;
    if (named !== null && named !== sessionId) {
      throw new CompletionsRefusal(400, "invalid_params", `The tool calls answered are session ${sessionId}'s, not ${named}'s.`, { param: `${COMPLETIONS_NAMESPACE}.sessionId` });
    }
    for (const [set, field] of [
      [turn.extension.forkSession, "forkSession"],
      [turn.extension.rewindToMessageId !== null, "rewindToMessageId"],
    ] as const) {
      if (set) throw new CompletionsRefusal(400, "invalid_params", `Tool results resume a running turn; they cannot ${field === "forkSession" ? "fork its session" : "rewind it"}.`, { param: `${COMPLETIONS_NAMESPACE}.${field}` });
    }
    // A call waits only while its run is live: every run's end lets go of what it left parked.
    const facts = host.startFacts(sessionId, actorFor(turn, clientSession));
    if (facts.live === null) {
      throw new CompletionsRefusal(404, "tool_call_not_found", `The run that made the call ${first.id} has ended.`, { param: "messages" });
    }
    const runId = facts.live.runId;
    const answeredIn = modelOfRun(runId, turn.model);
    const requested = resolveModel(catalogue, turn.model, facts.accountId ?? catalogue.defaultAccountId());
    const ignored = [...turn.ignored];
    if (requested?.id !== answeredIn) ignored.push("model");
    if (turn.extension.permissionMode !== null) ignored.push(`${COMPLETIONS_NAMESPACE}.permissionMode`);
    ignored.push(...turn.instructionSources);
    if (turn.effortParam !== null) ignored.push(turn.effortParam);
    if (turn.extension.attendedSet) ignored.push(`${COMPLETIONS_NAMESPACE}.attended`);
    if (turn.extension.workspace !== null) ignored.push(`${COMPLETIONS_NAMESPACE}.workspace`);
    if (turn.extension.attachments.length > 0) ignored.push(`${COMPLETIONS_NAMESPACE}.attachments`);
    if (turn.extension.after !== null) ignored.push(`${COMPLETIONS_NAMESPACE}.after`);
    ignored.push(...liveToolsIgnored(turn, sessionId));
    ignored.push(...unmatched.map((index) => `messages.${index}`));
    if (exchange.gone) return;

    // Following first, so nothing the resumed turn records is missed; then the calls resolve and the turn goes on.
    const follower = follow(sessionId);
    for (const call of matched) passthrough.resolve(call.id, call.text);
    answer(response, turn, {
      sessionId,
      runId,
      messageId: null,
      queued: false,
      model: answeredIn,
      head: { sessionId, runId, mode: facts.live.policy.mode.effective, clamped: null, ignored },
      startSeq: follower.head,
    }, follower, exchange);
  };

  /** Writes the answer: a stream of chunks, or the whole completion once it is over. */
  const answer = (response: ServerResponse, turn: TurnRequest, begun: Begun, follower: Follower, exchange: Exchange): void => {
    const created = seconds();
    const id = `chatcmpl-${begun.messageId ?? randomUUID()}`;
    const chunks: ChatCompletionChunk[] = [];
    let heartbeat: Timer | undefined;
    /** Armed while the answer is backed up past the cap: fires unless the client drains it first. */
    let stalled: Timer | undefined;
    let finished = false;

    /** Stops offering the answer the calls its session's runs park (#139); set once it watches them. */
    const watching = { stop: (): void => undefined };

    const done = (): void => {
      if (finished) return;
      finished = true;
      heartbeat?.cancel();
      follower.stop();
      watching.stop();
      open.delete(entry);
    };

    const write = (text: string): void => {
      if (response.writableEnded || response.destroyed) return;
      response.write(text);
      // A client that stopped reading is let go before its answer fills the environment's memory; the run goes on.
      // A burst may pass the cap before the socket has had a turn to flush, so it is let go only if it is still
      // backed up a heartbeat's time later with nothing drained.
      if (response.writableLength > MAX_BUFFERED_ANSWER_BYTES && stalled === undefined) {
        const armed = clock.setTimeout(() => {
          stalled = undefined;
          // Finished or not: an answer written whole still sits in memory until the client reads it.
          if (response.destroyed || response.writableLength <= MAX_BUFFERED_ANSWER_BYTES) return;
          console.error(`A completions client stopped reading session ${begun.sessionId}'s answer; ${response.writableLength} bytes wait. Its connection is closed; the run goes on.`);
          done();
          response.destroy();
        }, COMPLETIONS_HEARTBEAT_MS);
        stalled = armed;
        const disarm = (): void => {
          armed.cancel();
          if (stalled === armed) stalled = undefined;
        };
        response.once("drain", disarm);
        response.once("close", disarm);
      }
      heartbeat?.cancel();
      heartbeat = clock.setTimeout(() => write(": keep-alive\n\n"), COMPLETIONS_HEARTBEAT_MS);
    };

    if (turn.stream) {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
    }

    const end = (ended: AnswerEnd): void => {
      if (turn.stream) {
        if (turn.includeUsage && ended.usage !== null) {
          write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: begun.model, choices: [], usage: ended.usage, [COMPLETIONS_NAMESPACE]: { seq: ended.seq } })}\n\n`);
        }
        write("data: [DONE]\n\n");
        done();
        response.end();
        return;
      }
      done();
      const first = chunks[0]?.[COMPLETIONS_NAMESPACE] ?? { seq: ended.seq };
      const context: RefusalContext = {
        sessionId: begun.sessionId,
        runId: begun.runId,
        ...(ended.ended !== null && { ended: { reason: ended.ended.reason, cause: ended.ended.cause } }),
      };
      if (ended.error !== null) {
        const reason = ended.ended?.reason;
        // With no run end: the environment stopped the answer (503) or could not go on (500), or its message was withdrawn (409).
        const unended = ended.error.code === "internal" ? 500 : ended.error.code === "withdrawn" ? 409 : 503;
        const status = reason === undefined ? unended : reason === "interrupted" ? 409 : reason === "error" ? 502 : 503;
        return sendRefusal(response, new CompletionsRefusal(status, ended.error.code ?? "error", ended.error.message, { context }));
      }
      const toolCalls = chunks.flatMap((chunk) => chunk.choices[0]?.delta.tool_calls ?? []).map((call) => ({ id: call.id, type: call.type, function: call.function }));
      const content = chunks.map((chunk) => chunk.choices[0]?.delta.content ?? "").join("");
      const completion: ChatCompletion = {
        id,
        object: "chat.completion",
        created,
        model: begun.model,
        choices: [{ index: 0, message: { role: "assistant", content, ...(toolCalls.length > 0 && { tool_calls: toolCalls }) }, finish_reason: ended.finishReason }],
        ...(ended.usage !== null && { usage: ended.usage }),
        [COMPLETIONS_NAMESPACE]: { ...first, seq: ended.seq, ...(ended.waiting !== null && { waiting: ended.waiting }) },
      };
      sendJson(response, 200, completion, { "cache-control": "no-store" });
    };

    const renderer = createRenderer({
      id,
      created,
      model: begun.model,
      head: begun.head,
      stops: turn.stop,
      maxCharacters: turn.maxCharacters,
      runId: begun.runId,
      queuedMessage: begun.queued ? begun.messageId : null,
      emit: (chunk) => {
        if (turn.stream) write(`data: ${JSON.stringify(chunk)}\n\n`);
        else chunks.push(chunk);
      },
      end,
      holderOf,
      later: (work) => void setImmediate(work),
      isClientCall: (toolCallId) => passthrough.isClientCall(begun.sessionId, toolCallId),
      // A queued turn's answer returns calls to the caller's tools once it follows the run that reads its message.
      onReading: () => {
        // A later turn of the event loop has no caller to catch for it (each claim catches its own).
        if (!finished) passthrough.offer(begun.sessionId);
      },
      ...(begun.startSeq !== undefined && { startSeq: begun.startSeq }),
    });
    const entry = { abandon: () => renderer.abandon("The environment is stopping; the run goes on, or ends with it.", "closing") };
    open.add(entry);
    exchange.onGone = done;
    // `close` has run already: its one pass over the open answers never saw this one.
    if (closed) return entry.abandon();
    if (exchange.gone) return done();

    const failed = (what: string, error: unknown): void => {
      console.error(`${what} for a completion of session ${begun.sessionId} failed:`, error);
      renderer.abandon("The environment failed to follow the run.", "internal");
    };
    try {
      follower.start(begun.queued && turn.extension.after !== null ? turn.extension.after : follower.head, (event) => {
        if (finished) return;
        try {
          renderer.event(event);
        } catch (error) {
          failed(`Rendering event ${event.sequence}`, error);
        }
      });
    } catch (error) {
      failed("Reading the session back", error);
    }
    // The calls to the caller's tools its runs park, those waiting already first, once the events read back are rendered (#139).
    if (finished) return;
    watching.stop = passthrough.watch(begun.sessionId, {
      claim: (call) => {
        if (finished) return false;
        try {
          return renderer.claim(call);
        } catch (error) {
          failed(`Returning the call ${call.id}`, error);
          return false;
        }
      },
    });
  };

  const handle: RouteHandler = async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const method = request.method ?? "";
    try {
      if (path === CHAT_COMPLETIONS_PATH) {
        if (method !== "POST") throw wrongMethod(path, "POST");
        return await chat(request, response);
      }
      if (path === MODELS_PATH || path.startsWith(`${MODELS_PATH}/`)) {
        if (method !== "GET" && method !== "HEAD") throw wrongMethod(path, "GET, HEAD");
        const id = path === MODELS_PATH ? null : path.slice(MODELS_PATH.length + 1);
        return models(request, response, id === "" ? null : id);
      }
      throw notImplemented(method, path);
    } catch (thrown) {
      sendRefusal(response, asRefusal(thrown));
    }
  };

  return {
    handle,
    close() {
      closed = true;
      for (const entry of [...open]) entry.abandon();
    },
  };
};
