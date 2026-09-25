import type { EventEnvelope, HelloFrame } from "@agent-harness/contracts";
import { SocketClosedError } from "../connections/connection.js";
import type { ConnectionRecord } from "../connections/records.js";
import { NotConnectedError, type ConnectionSeams } from "../connections/registry.js";

/**
 * Client-addressed calls (docs/specs/client-runtime.md, "Capability flags,
 * ceiling and absent-with-reason"; ADR 0014): a call the environment
 * addresses to the client session that started a run (a browser verb, which
 * this client performs on its own local environment's Chrome) arrives on
 * `environment.subscribe`; the runtime hands it to the handler registered
 * for its kind with `clientCalls.register(kind, handler)` and sends the
 * handler's answer back through the connection it came on. The call and the
 * answer are opaque to the runtime.
 *
 * - **Addressed**: a call names the client session it is for; one naming
 *   another is left alone (every client of the environment may hear the
 *   stream). It is handled once, by its call id, however often the stream
 *   carries it, and only as news: a call replayed onto an empty cache is
 *   history, not a call waiting.
 * - **Answered**: `{callId, ok: true, result}` with what the handler answered
 *   (null for nothing), or `{callId, ok: false, error: {code, message}}`:
 *   `unsupported` when no handler is registered for the kind, `handler_failed`
 *   when the handler threw or its promise rejected.
 * - **Reconnects**: handlers are the runtime's, not a socket's, so they
 *   outlive a reconnect; the client session id is stable across one. An
 *   answer that could not be sent because the socket went (or was cut
 *   before its response came) is sent again on the connection's next ready,
 *   as long as that ready is the same client session (a local connection's
 *   is new on every start, and a re-pair makes a new one: a call addressed
 *   to the old session is not this one's to answer).
 *
 * Verified first (#142): in phase A no environment sends a client-addressed
 * call and no method carries its answer. The environment's stream carries
 * the notices of `ENVIRONMENT_NOTICE_TYPES` and nothing addressed to one
 * client, and the frames have no client-bound call. So the event's type and
 * shape here (`CLIENT_CALL_EVENT`) and the answer's method
 * (`CLIENT_CALL_ANSWER_METHOD`) are this build's placeholders, owed to the
 * browser workstream (#93), which names both on the environment's side.
 */

/** The type of the event on the environment's stream that carries a call: a placeholder until the browser workstream names it. */
export const CLIENT_CALL_EVENT = "client.call";

/** The method the answer is sent with: a placeholder until the browser workstream names it. */
export const CLIENT_CALL_ANSWER_METHOD = "client.answer";

/** A call as its handler receives it. */
export interface ClientCall {
  /** The environment the call came from, and the connection its answer goes back on. */
  readonly environmentId: string;
  readonly callId: string;
  readonly kind: string;
  /** What the call carries, opaque to the runtime. */
  readonly payload: unknown;
}

/** Answers a call: a JSON value, or a promise of one; throwing (or rejecting) answers it `handler_failed`. */
export type ClientCallHandler = (call: ClientCall) => unknown;

export interface ClientCalls {
  /** Hands every call of `kind` addressed to this client to `handler`, until the returned release; a second handler for a kind is refused. */
  register(kind: string, handler: ClientCallHandler): () => void;
}

export interface ClientCallsHost {
  readonly seams: Pick<ConnectionSeams, "request" | "onReady">;
  readonly record: (environmentId: string) => ConnectionRecord | undefined;
  readonly report: (error: unknown) => void;
}

export interface ClientCallsRouter extends ClientCalls {
  /** An event on the environment's stream, news to this client. */
  heard(environmentId: string, event: EventEnvelope): void;
  /** The environment was removed: its calls and waiting answers go. */
  forget(environmentId: string): void;
  close(): void;
}

type Answer = { readonly callId: string; readonly ok: true; readonly result: unknown } | { readonly callId: string; readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

export const createClientCalls = (host: ClientCallsHost): ClientCallsRouter => {
  const handlers = new Map<string, ClientCallHandler>();
  /** The calls handled, by environment: a call id carried again is not a second call. */
  const handled = new Map<string, Set<string>>();
  /** Answers waiting for the connection's next ready, with the client session they are for. */
  const waiting = new Map<string, { readonly clientSessionId: string; readonly answer: Answer }[]>();
  let closed = false;

  const send = (environmentId: string, clientSessionId: string, answer: Answer): void => {
    if (closed) return;
    let sent: Promise<unknown>;
    try {
      sent = host.seams.request(environmentId, CLIENT_CALL_ANSWER_METHOD, answer as unknown as Record<string, unknown>).then((response) => {
        if (response.error) host.report(new Error(`The answer to call ${answer.callId} was refused: ${response.error.code}: ${response.error.message}`));
      });
    } catch (error) {
      sent = Promise.reject(error);
    }
    sent.catch((error: unknown) => {
      // Not sent, or cut off before its response: sent again on the next ready of the same client session.
      if (!(error instanceof SocketClosedError || error instanceof NotConnectedError)) return host.report(error);
      const queue = waiting.get(environmentId) ?? [];
      queue.push({ clientSessionId, answer });
      waiting.set(environmentId, queue);
    });
  };

  const answerOf = async (call: ClientCall): Promise<Answer> => {
    const handler = handlers.get(call.kind);
    if (handler === undefined) return { callId: call.callId, ok: false, error: { code: "unsupported", message: `This client has no handler for ${call.kind}.` } };
    try {
      const result: unknown = await handler(call);
      return { callId: call.callId, ok: true, result: result === undefined ? null : result };
    } catch (error) {
      return { callId: call.callId, ok: false, error: { code: "handler_failed", message: error instanceof Error ? error.message : String(error) } };
    }
  };

  const stopReady = host.seams.onReady((environmentId: string, hello: HelloFrame) => {
    const queue = waiting.get(environmentId);
    if (queue === undefined) return;
    waiting.delete(environmentId);
    for (const { clientSessionId, answer } of queue) if (clientSessionId === hello.clientSessionId) send(environmentId, clientSessionId, answer);
  });

  return {
    register(kind, handler) {
      if (handlers.has(kind)) throw new Error(`A handler for ${kind} is registered already.`);
      handlers.set(kind, handler);
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        if (handlers.get(kind) === handler) handlers.delete(kind);
      };
    },
    heard(environmentId, event) {
      if (closed || event.type !== CLIENT_CALL_EVENT) return;
      const { payload } = event;
      const callId = text(payload["callId"]);
      const kind = text(payload["kind"]);
      const addressed = text(payload["clientSessionId"]);
      if (callId === null || kind === null || addressed === null) return host.report(new Error(`A client-addressed call this client cannot read: event ${event.sequence}.`));
      if (addressed !== host.record(environmentId)?.clientSessionId) return;
      let seen = handled.get(environmentId);
      if (seen === undefined) handled.set(environmentId, (seen = new Set()));
      if (seen.has(callId)) return;
      seen.add(callId);
      void answerOf({ environmentId, callId, kind, payload: payload["payload"] ?? null }).then((answer) => send(environmentId, addressed, answer));
    },
    forget(environmentId) {
      handled.delete(environmentId);
      waiting.delete(environmentId);
    },
    close() {
      closed = true;
      stopReady();
      waiting.clear();
    },
  };
};
