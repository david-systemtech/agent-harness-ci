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
import { createRenderer, type AnswerEnd, type AnswerHead } from "./answer.js";
import { CompletionsRefusal, asRefusal, sendRefusal, type RefusalContext } from "./errors.js";
import { listModels, listingId, modelObject, resolveModel, type CompletionsCatalogue, type ResolvedModel } from "./models.js";
import { readTurnRequest, withPreamble, type TurnRequest } from "./request.js";

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
 *   `sessions.fork` and `sessions.rewind` as the program's client session,
 *   answered 501 while the environment does not serve them (#137).
 * - **The answer** (`answer.ts`) follows the session's events: live ones
 *   from the log's subscription, earlier ones read back, deduplicated by
 *   sequence. A stream sends each chunk as an SSE `data:` line and an SSE
 *   comment after fifteen silent seconds on the environment's clock, and
 *   ends with `[DONE]`; a whole answer waits for the end. A client that goes
 *   away stops only its answer: the run goes on.
 */

/** The largest request body taken: 20 MiB attachments travel base64 inside it. A chosen default. */
export const MAX_COMPLETIONS_BODY_BYTES = 64 * 1024 * 1024;

/**
 * How much of an answer may wait unsent for a client that stopped reading:
 * past it, and still past it fifteen seconds later with nothing drained, the
 * connection is closed (the run goes on). A chosen default: a reading client
 * never holds more than a burst.
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
  const { log, host, clock, catalogue } = options;
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

  /** Runs a method of the table as the program's client session; undefined when the environment does not serve it. */
  const command = async (clientSession: VerifiedClientSession, method: string, params: Record<string, unknown>): Promise<Record<string, unknown> | undefined> => {
    if (options.methods.get(method)?.handler === undefined) return undefined;
    const answer = await new Promise<{ result?: Record<string, unknown>; error?: WireError }>((resolve) => {
      void dispatch(
        { type: "request", id: randomUUID(), method, params: { commandId: randomUUID(), ...params } },
        clientSession,
        (value) => resolve(value as { result?: Record<string, unknown>; error?: WireError }),
        () => resolve({ error: { code: "internal", message: `${method} is a stream.`, data: {} } }),
      );
    });
    if (answer.error !== undefined) throw new ContractError(answer.error);
    const receipt = answer.result?.["receipt"] as { status: string; error?: WireError } | undefined;
    if (receipt?.status === "rejected" && receipt.error !== undefined) throw new ContractError(receipt.error);
    return (answer.result?.["result"] as Record<string, unknown> | undefined) ?? {};
  };

  // ---- a turn ----

  /** Where a fresh session's code lives: the directory the request names, or a scratch directory of its own. */
  const workspaceFor = (turn: TurnRequest, sessionId: string): { path: string; made: boolean } => {
    const named = turn.extension.workspace;
    if (named !== null) {
      const param = `${COMPLETIONS_NAMESPACE}.workspace`;
      if (!isAbsolute(named)) throw new CompletionsRefusal(400, "workspace_not_found", `The workspace is an absolute path to a directory the environment has; ${named} is not absolute.`, { param });
      if (!isDirectory(named)) throw new CompletionsRefusal(400, "workspace_not_found", `The environment has no directory ${named}.`, { param });
      return { path: named, made: false };
    }
    const path = join(options.scratchRoot, sessionId);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return { path, made: true };
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

  /** What the turn recorded: the session, the run the answer follows, the message, whether it was queued to a live run, the model the answer names, and the first chunk's fields. */
  interface Begun {
    readonly sessionId: string;
    readonly runId: string;
    readonly messageId: string;
    readonly queued: boolean;
    /** The listing id of the model the message is read in: the requested one for a new run, the live run's for a queued message. */
    readonly model: string;
    readonly head: AnswerHead;
  }

  /**
   * The turn, in one transaction: a fresh session made as `sessions.create`
   * makes one (`createSessionIn`), or the named one tagged; then the run
   * started as `runs.start` starts one (`startRunIn`), or, when one is live,
   * the message queued to it as `runs.send` queues one (`sendIn`). Nothing is
   * recorded when anything refuses.
   */
  const begin = (turn: TurnRequest, model: ResolvedModel, clientSession: VerifiedClientSession, target: { sessionId: string; fresh: boolean }): Begun => {
    const { sessionId, fresh } = target;
    const clientActor = formatActor({ kind: "client_session", id: clientSession.id });
    const workspace = fresh ? workspaceFor(turn, sessionId) : null;
    const ignored = [...turn.ignored];
    if (!fresh && turn.extension.workspace !== null) ignored.push(`${COMPLETIONS_NAMESPACE}.workspace`);
    const refused = (refusal: { code: string; message: string; data: Record<string, unknown> }): ContractError => new ContractError(refusal);
    try {
      return log.atomically((tx) => {
        if (workspace !== null) {
          const created = createSessionIn(
            log,
            { tx, actor: clientActor },
            { id: sessionId, tags: [COMPLETIONS_TAG], workspace: { kind: "directory", path: workspace.path }, account: model.account.id, model: model.model.id },
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
          // opens), so the answer names that one, and a request naming another is told so.
          const running = readRun(reader, facts.live.runId);
          const answeredIn = running === null ? model.id : (listingId(catalogue, running.accountId, running.model) ?? model.id);
          if (answeredIn !== model.id) ignored.push("model");
          if (turn.extension.permissionMode !== null) ignored.push(`${COMPLETIONS_NAMESPACE}.permissionMode`);
          ignored.push(...turn.instructionSources);
          if (turn.effortParam !== null) ignored.push(turn.effortParam);
          if (turn.extension.attendedSet) ignored.push(`${COMPLETIONS_NAMESPACE}.attended`);
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
    } catch (error) {
      if (workspace?.made === true) rmSync(workspace.path, { recursive: true, force: true });
      throw error;
    }
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
      const forked = await command(clientSession, "sessions.fork", {
        sessionId,
        id: forkId,
        ...(rewindToMessageId !== null && { atMessageId: rewindToMessageId }),
        account: model.account.id,
      });
      if (forked === undefined) {
        throw new CompletionsRefusal(501, "not_implemented", "Forking a session needs sessions.fork, which this environment does not serve yet.", { param: `${COMPLETIONS_NAMESPACE}.forkSession` });
      }
      return { sessionId: forkId, fresh: false };
    }
    if (rewindToMessageId !== null) {
      const rewound = await command(clientSession, "sessions.rewind", { sessionId, messageId: rewindToMessageId });
      if (rewound === undefined) {
        throw new CompletionsRefusal(501, "not_implemented", "Rewinding a session needs sessions.rewind, which this environment does not serve yet.", {
          param: `${COMPLETIONS_NAMESPACE}.rewindToMessageId`,
        });
      }
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
    ready(true);
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
    // The environment may have begun to stop while the body was read.
    ready(true);
    const turn = readTurnRequest(body);
    if (turn.extension.after !== null && turn.extension.after > log.head()) {
      throw new CompletionsRefusal(400, "invalid_params", `after ${turn.extension.after} is past the log's head, ${log.head()}.`, { param: `${COMPLETIONS_NAMESPACE}.after` });
    }
    // A bare model continuing a session is the session's account's, so a change of default leaves the conversation where it was.
    const named = turn.extension.sessionId === null ? null : readSessionFacts(log, reader, turn.extension.sessionId);
    const model = resolveModel(catalogue, turn.model, named?.account ?? catalogue.defaultAccountId());
    if (model === undefined) throw new CompletionsRefusal(404, "model_not_found", `No model ${turn.model} is offered here; GET ${MODELS_PATH} lists them.`, { param: "model" });
    precheck(turn, model, clientSession);
    if (exchange.gone) return;
    const where = await target(turn, model, clientSession);
    if (exchange.gone) return;
    // Or while a fork or a rewind was asked for.
    ready(true);

    // Listen before anything is recorded, so no event of the turn is missed; what came before `after` is read back.
    const follower = follow(where.sessionId);
    let begun: Begun;
    try {
      begun = begin(turn, model, clientSession, where);
    } catch (error) {
      follower.stop();
      // A fresh session's id names nothing once its transaction rolled back.
      throw asRefusal(error, where.fresh ? undefined : { sessionId: where.sessionId });
    }
    answer(response, turn, begun, follower, exchange);
  };

  /** Writes the answer: a stream of chunks, or the whole completion once it is over. */
  const answer = (response: ServerResponse, turn: TurnRequest, begun: Begun, follower: Follower, exchange: Exchange): void => {
    const created = seconds();
    const id = `chatcmpl-${begun.messageId}`;
    const chunks: ChatCompletionChunk[] = [];
    let heartbeat: Timer | undefined;
    /** Armed while the answer is backed up past the cap: fires unless the client drains it first. */
    let stalled: Timer | undefined;
    let finished = false;

    const done = (): void => {
      if (finished) return;
      finished = true;
      heartbeat?.cancel();
      follower.stop();
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
        const status = reason === undefined ? (ended.error.code === "internal" ? 500 : 503) : reason === "interrupted" ? 409 : reason === "error" ? 502 : 503;
        return sendRefusal(response, new CompletionsRefusal(status, ended.error.code ?? "error", ended.error.message, { context }));
      }
      const completion: ChatCompletion = {
        id,
        object: "chat.completion",
        created,
        model: begun.model,
        choices: [{ index: 0, message: { role: "assistant", content: chunks.map((chunk) => chunk.choices[0]?.delta.content ?? "").join("") }, finish_reason: ended.finishReason }],
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
