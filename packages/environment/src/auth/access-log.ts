import {
  ACCESS_STREAM_KIND,
  type AccessEventPayload,
  type AccessEventType,
  type Actor,
  type EventEnvelope as WireEnvelope,
} from "@agent-harness/contracts";
import type { EventLog, StreamRef } from "../event-log/event-log.js";
import { actorKey, toWireEnvelope } from "../event-log/wire-envelope.js";

/** Who caused an access event, and the command that did when one did. */
export interface Attribution {
  readonly actor: Actor;
  readonly commandId?: string | undefined;
}

/** The environment's own components, as the access log names them when no client session acted. */
export const SYSTEM = {
  /** The bootstrap exchange at `/api/bootstrap`. */
  bootstrap: { actor: { kind: "system", id: "bootstrap" } },
  /** The pairing exchange at `/api/pair`. */
  pairing: { actor: { kind: "system", id: "pairing" } },
  /** The minute sweep: expired pairings, idle terminal UI sessions. */
  sweep: { actor: { kind: "system", id: "sweep" } },
  /** The process embedding the environment, through its handle. */
  owner: { actor: { kind: "system", id: "owner" } },
} as const satisfies Record<string, Attribution>;

/** The attribution of a method call: the calling client session, and the command's id when it is one. */
export const byClientSession = (clientSessionId: string, commandId?: string): Attribution => ({
  actor: { kind: "client_session", id: clientSessionId },
  commandId,
});

/** How many events `access.log.list` answers when asked for no particular number. */
export const DEFAULT_LOG_PAGE = 100;

/**
 * The access log (ADR 0006): the `access` stream, one per environment, whose
 * id is the environment's id. `record` appends one event; `atomically` lets
 * an auth-table write and its events commit together.
 */
export interface AccessLog {
  record<T extends AccessEventType>(type: T, payload: AccessEventPayload<T>, attribution: Attribution): void;
  atomically<R>(work: () => R): R;
  /** The stream's events after `afterSequence`, oldest first, at most `limit`. */
  list(afterSequence: number, limit: number): WireEnvelope[];
}

export const createAccessLog = (log: EventLog, environmentId: string): AccessLog => {
  const stream: StreamRef = { kind: ACCESS_STREAM_KIND, id: environmentId };
  return {
    record(type, payload, attribution) {
      log.append(stream, [{ type, payload }], {
        actor: actorKey(attribution.actor),
        ...(attribution.commandId !== undefined && { commandId: attribution.commandId }),
      });
    },
    atomically: (work) => log.atomically(work),
    list: (afterSequence, limit) => log.readStream(stream, afterSequence, limit).map(toWireEnvelope),
  };
};
