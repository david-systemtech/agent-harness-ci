import {
  ACCESS_STREAM_KIND,
  type AccessEventPayload,
  type AccessEventType,
  type Actor,
  type EventEnvelope as WireEnvelope,
} from "@agent-harness/contracts";
import { formatActor } from "../event-log/envelope.js";
import type { EventLog, StreamRef, Tx } from "../event-log/event-log.js";
import { toWireEnvelope } from "../wire/envelope.js";

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
  exchange: { actor: { kind: "system", id: "exchange" } },
  /** The minute sweep: expired pairings, idle `tui` local client sessions, and the purge of deleted sessions past their grace period. */
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
 * id is the environment's id. The caller that owns a change opens
 * `atomically` once and passes its `Tx` to every auth-table write and every
 * `record`, so the rows and their events commit together.
 */
export interface AccessLog {
  /** The `access` stream: the aggregate of the access commands. */
  readonly stream: StreamRef;
  record<T extends AccessEventType>(tx: Tx, type: T, payload: AccessEventPayload<T>, attribution: Attribution): void;
  atomically<R>(work: (tx: Tx) => R): R;
  /** The stream's events after `afterSequence`, oldest first, at most `limit`. */
  list(afterSequence: number, limit: number): WireEnvelope[];
}

export const createAccessLog = (log: EventLog, environmentId: string): AccessLog => {
  const stream: StreamRef = { kind: ACCESS_STREAM_KIND, id: environmentId };
  return {
    stream,
    record(tx, type, payload, attribution) {
      log.append(stream, [{ type, payload }], {
        tx,
        actor: formatActor(attribution.actor),
        ...(attribution.commandId !== undefined && { commandId: attribution.commandId }),
      });
    },
    atomically: (work) => log.atomically(work),
    list: (afterSequence, limit) => log.readStream(stream, afterSequence, limit).map(toWireEnvelope),
  };
};
