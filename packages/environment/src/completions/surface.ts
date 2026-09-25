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
import { decideSend } from "../runs/run-decider.js";
import { startRunIn } from "../runs/run-methods.js";
import type { Clock, Timer } from "../serve/clock.js";
import { BodyTooLargeError, readBody, sendJson, type RouteHandler } from "../serve/http.js";
import type { MethodTable } from "../serve/methods.js";
import { appendRunEvents } from "../sessions/activity-companions.js";
import { appendDecided } from "../sessions/companions.js";
import { decideCreate, decideTag } from "../sessions/decider.js";
import { readSessionState, type Reader } from "../sessions/session-reads.js";
import { sessionStream } from "../sessions/streams.js";
import { createDispatch } from "../wire/dispatch.js";
import { createRenderer, type AnswerEnd, type AnswerHead } from "./answer.js";
import { CompletionsRefusal, asRefusal, sendRefusal, type RefusalContext } from "./errors.js";
import { listModels, modelObject, resolveModel, type CompletionsCatalogue, type ResolvedModel } from "./models.js";
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
 *   (`runs.send`'s queue path) and the answer follows the run that reads it.
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

  const ready = (forTurn: boolean): void => {
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

  /** What starting or steering the turn recorded: the session, the run the answer follows, the message, and the first chunk's fields. */
  interface Begun {
    readonly sessionId: string;
    readonly runId: string;
    readonly messageId: string;
    readonly steer: boolean;
    readonly head: AnswerHead;
  }

  /**
   * The turn, in one transaction: a fresh session made (or the named one
   * tagged), then the run started, or, when one is live, the message queued
   * to it as a steer. Nothing is recorded when anything refuses.
   */
  const begin = (turn: TurnRequest, model: ResolvedModel, clientSession: VerifiedClientSession, target: { sessionId: string; fresh: boolean }): Begun => {
    const { sessionId, fresh } = target;
    const clientActor = formatActor({ kind: "client_session", id: clientSession.id });
    const workspace = fresh ? workspaceFor(turn, sessionId) : null;
    const ignored = [...turn.ignored];
    if (!fresh && turn.extension.workspace !== null) ignored.push(`${COMPLETIONS_NAMESPACE}.workspace`);
    try {
      return log.atomically((tx) => {
        if (workspace !== null) {
          const created = decideCreate(
            null,
            { id: sessionId, title: null, tags: [COMPLETIONS_TAG], groupId: null, workspace: { kind: "directory", path: workspace.path }, account: model.account.id, model: model.model.id, mode: null },
            { groupExists: false },
          );
          if (created.rejected !== undefined) throw new ContractError({ code: created.rejected.code, message: created.rejected.message ?? "The session could not be created.", data: created.rejected.data ?? {} });
          appendDecided(log, sessionStream(sessionId), created, { tx, actor: clientActor });
        } else {
          const tagged = decideTag(readSessionState(reader, sessionId), { sessionId, tag: COMPLETIONS_TAG });
          if (tagged.rejected === undefined) appendDecided(log, sessionStream(sessionId), tagged, { tx, actor: clientActor });
        }
        const actor: RunActor = {
          kind: "completions",
          attended: turn.extension.attended,
          ceiling: options.clientSessions.ceiling(clientSession.id) ?? clientSession.ceiling,
          clientSessionId: clientSession.id,
        };
        const facts = host.startFacts(sessionId, actor);
        if (facts.session === null || facts.session.deleted) {
          throw new CompletionsRefusal(404, "session_not_found", `No session ${sessionId} is on this environment.`, { param: `${COMPLETIONS_NAMESPACE}.sessionId` });
        }
        if (facts.accountId !== model.account.id) {
          throw new CompletionsRefusal(
            409,
            "account_mismatch",
            `The session ${sessionId} runs on the account ${facts.accountId ?? "(none)"}, not ${model.account.id}; name one of its models, or fork it onto the other account with ${COMPLETIONS_NAMESPACE}.forkSession.`,
            { param: "model" },
          );
        }
        const messageId = randomUUID();
        const prompt = { messageId, text: fresh ? withPreamble(turn.earlier, turn.text) : turn.text, attachments: [...turn.extension.attachments] };

        if (facts.live !== null) {
          // A run is live: the turn is a steer, and the answer follows the run that reads it (#138).
          const decision = decideSend(facts, prompt);
          if (decision.rejected !== undefined) throw new ContractError({ code: decision.rejected.code, message: decision.rejected.message, data: decision.rejected.data });
          if (decision.queued === undefined) throw new Error("A send to a live run started a run.");
          host.stageAttachments(decision.queued.message);
          appendRunEvents(log, sessionId, decision.events, { tx, actor: COMPLETIONS_ACTOR, correlationId: decision.result.runId });
          const queued = decision.queued;
          tx.afterCommit(() => host.queue(queued));
          for (const [set, path] of [
            [turn.extension.permissionMode, "permissionMode"],
            [turn.appendedInstructions === "" ? null : turn.appendedInstructions, "systemPrompt"],
            [turn.effort, "thinking"],
          ] as const) {
            if (set !== null) ignored.push(`${COMPLETIONS_NAMESPACE}.${path}`);
          }
          return {
            sessionId,
            runId: decision.result.runId,
            messageId,
            steer: true,
            head: { sessionId, runId: decision.result.runId, messageId, steered: true, mode: facts.live.policy.mode.effective, clamped: null, ignored },
          };
        }

        // Started as runs.start and the environment's startRun start theirs (#131's startRunIn): the run's policy resolved for the completions actor.
        const started = startRunIn(log, host, tx, { actor: COMPLETIONS_ACTOR }, {
          sessionId,
          actor,
          origin: "completions",
          text: prompt.text,
          attachments: prompt.attachments,
          model: model.model.id,
          effort: turn.effort ?? undefined,
          mode: turn.extension.permissionMode ?? undefined,
          appendedInstructions: turn.appendedInstructions,
        });
        if (started.rejected !== undefined) throw new ContractError({ code: started.rejected.code, message: started.rejected.message, data: started.rejected.data });
        const { mode } = started.policy;
        return {
          sessionId,
          runId: started.runId,
          messageId: started.messageId,
          steer: false,
          head: {
            sessionId,
            runId: started.runId,
            messageId: started.messageId,
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

  /** Where a steered message is now: still with the provider, waiting in the environment's queue, or read. */
  const steerHolder = (messageId: string): "wait" | "queued" | "read" => {
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

  const chat = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
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
    const turn = readTurnRequest(body);
    const model = resolveModel(catalogue, turn.model);
    if (model === undefined) throw new CompletionsRefusal(404, "model_not_found", `No model ${turn.model} is offered here; GET ${MODELS_PATH} lists them.`, { param: "model" });
    const where = await target(turn, model, clientSession);

    // Listen before anything is recorded, so no event of the turn is missed; what came before `after` is read back.
    const buffered: EventEnvelope[] = [];
    let deliver: ((event: EventEnvelope) => void) | undefined;
    const stop = log.subscribe((event) => {
      if (event.streamKind !== "session" || event.streamId !== where.sessionId) return;
      if (deliver === undefined) buffered.push(event);
      else deliver(event);
    });
    const head = log.head();
    let begun: Begun;
    try {
      begun = begin(turn, model, clientSession, where);
    } catch (error) {
      stop();
      // A fresh session's id names nothing once its transaction rolled back.
      throw asRefusal(error, where.fresh ? undefined : { sessionId: where.sessionId });
    }
    answer(response, turn, model, begun, begun.steer && turn.extension.after !== null ? turn.extension.after : head, buffered, stop, (listener) => (deliver = listener));
  };

  /** Writes the answer: a stream of chunks, or the whole completion once it is over. */
  const answer = (
    response: ServerResponse,
    turn: TurnRequest,
    model: ResolvedModel,
    begun: Begun,
    after: number,
    buffered: EventEnvelope[],
    unsubscribe: () => void,
    listen: (listener: (event: EventEnvelope) => void) => void,
  ): void => {
    const created = seconds();
    const id = `chatcmpl-${begun.messageId}`;
    const chunks: ChatCompletionChunk[] = [];
    let heartbeat: Timer | undefined;
    let finished = false;

    const write = (text: string): void => {
      if (response.writableEnded || response.destroyed) return;
      response.write(text);
      heartbeat?.cancel();
      heartbeat = clock.setTimeout(() => write(": keep-alive\n\n"), COMPLETIONS_HEARTBEAT_MS);
    };

    const done = (): void => {
      if (finished) return;
      finished = true;
      heartbeat?.cancel();
      unsubscribe();
      open.delete(entry);
    };

    if (turn.stream) {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      // A client that goes away stops its answer, never the run (ADR 0006).
      response.on("close", done);
    } else {
      response.on("close", () => {
        if (!response.writableFinished) done();
      });
    }

    const end = (ended: AnswerEnd): void => {
      if (turn.stream) {
        if (turn.includeUsage) {
          write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: model.id, choices: [], usage: ended.usage, [COMPLETIONS_NAMESPACE]: { seq: ended.seq } })}\n\n`);
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
        const status = ended.ended?.reason === "interrupted" ? 409 : ended.ended?.reason === "error" ? 502 : 503;
        return sendRefusal(response, new CompletionsRefusal(status, ended.error.code ?? "error", ended.error.message, { context }));
      }
      const completion: ChatCompletion = {
        id,
        object: "chat.completion",
        created,
        model: model.id,
        choices: [{ index: 0, message: { role: "assistant", content: chunks.map((chunk) => chunk.choices[0]?.delta.content ?? "").join("") }, finish_reason: ended.finishReason }],
        usage: ended.usage,
        [COMPLETIONS_NAMESPACE]: { ...first, seq: ended.seq, ...(ended.queued !== null && { queued: ended.queued }) },
      };
      sendJson(response, 200, completion, { "cache-control": "no-store" });
    };

    const renderer = createRenderer({
      id,
      created,
      model: model.id,
      head: begun.head,
      stops: turn.stop,
      maxCharacters: turn.maxCharacters,
      runId: begun.runId,
      steer: begun.steer ? begun.messageId : null,
      emit: (chunk) => {
        if (turn.stream) write(`data: ${JSON.stringify(chunk)}\n\n`);
        else chunks.push(chunk);
      },
      end,
      steerHolder,
      later: (work) => void setImmediate(work),
    });
    const entry = { abandon: () => renderer.abandon("The environment is stopping; the run goes on, or ends with it.", "closing") };
    open.add(entry);

    // What the log holds after the cursor, then what arrived meanwhile, then live: each event once, in order.
    let cursor = after;
    const feed = (event: EventEnvelope): void => {
      if (finished || event.sequence <= cursor) return;
      cursor = event.sequence;
      try {
        renderer.event(event);
      } catch (error) {
        console.error(`Rendering event ${event.sequence} of session ${begun.sessionId} for a completion failed:`, error);
        renderer.abandon("The environment failed to render the run.", "internal");
      }
    };
    for (const event of log.readStream(sessionStream(begun.sessionId), after)) feed(event);
    for (const event of buffered.splice(0)) feed(event);
    listen(feed);
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
        if (method !== "GET" && method !== "HEAD") throw wrongMethod(path, "GET");
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
      for (const entry of [...open]) entry.abandon();
    },
  };
};
