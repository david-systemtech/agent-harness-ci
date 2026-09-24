import { ContractError } from "@agent-harness/contracts";
import type { Tx } from "../event-log/event-log.js";
import type { MethodHandlers } from "../serve/methods.js";
import { DEFAULT_LOG_PAGE, byClientSession, type AccessLog } from "./access-log.js";
import type { ClientSessions } from "./client-sessions.js";
import type { Pairings } from "./pairings.js";

export interface AccessMethodsOptions {
  readonly pairings: Pick<Pairings, "create">;
  readonly clientSessions: Pick<ClientSessions, "list" | "refresh" | "revoke">;
  readonly accessLog: Pick<AccessLog, "list">;
  /** Opens the one transaction each command writes in. */
  readonly atomically: <T>(work: (tx: Tx) => T) => T;
}

type AccessMethodName = "access.pairings.create" | "access.sessions.list" | "access.sessions.revoke" | "access.sessions.refresh" | "access.log.list";

/**
 * The `access` family's handlers. The wire has checked the scope and the
 * params before any of them runs; each command opens one transaction for its
 * table writes and its events, which name the calling client session and
 * carry the command's id.
 */
export const accessMethods = (options: AccessMethodsOptions): Required<Pick<MethodHandlers, AccessMethodName>> => {
  const { pairings, clientSessions, accessLog, atomically } = options;
  return {
    "access.pairings.create": (params, { clientSession }) =>
      atomically((tx) => pairings.create(tx, { scopes: params.scopes, ceiling: params.ceiling }, byClientSession(clientSession.id, params.commandId))),

    "access.sessions.list": (params) => ({ sessions: clientSessions.list({ live: params.live ?? false }) }),

    "access.sessions.revoke": (params, { clientSession }) => {
      const revoked = atomically((tx) =>
        clientSessions.revoke(tx, params.clientSessionId, "requested", byClientSession(clientSession.id, params.commandId)),
      );
      if (!revoked) {
        throw new ContractError({ code: "not_found", message: `No client session is named ${params.clientSessionId}.`, data: {} });
      }
      return { revokedAt: revoked.revokedAt };
    },

    "access.sessions.refresh": (params, { clientSession }) => {
      const renewed = atomically((tx) => clientSessions.refresh(tx, clientSession.id, byClientSession(clientSession.id, params.commandId)));
      // The socket authenticated moments ago; only a revocation or the expiry landing in between gets here.
      if (!renewed) throw new ContractError({ code: "unauthorized", message: "This client session is no longer valid.", data: {} });
      return renewed;
    },

    "access.log.list": (params) => ({ events: accessLog.list(params.afterSequence ?? 0, params.limit ?? DEFAULT_LOG_PAGE) }),
  };
};
