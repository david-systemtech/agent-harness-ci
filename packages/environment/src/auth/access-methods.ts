import { ContractError } from "@agent-harness/contracts";
import type { MethodHandlers } from "../serve/methods.js";
import { DEFAULT_LOG_PAGE, byClientSession, type AccessLog } from "./access-log.js";
import type { ClientSessions } from "./client-sessions.js";
import type { Pairings } from "./pairings.js";

export interface AccessMethodsOptions {
  readonly pairings: Pick<Pairings, "create">;
  readonly clientSessions: Pick<ClientSessions, "list" | "refresh" | "revoke">;
  readonly accessLog: Pick<AccessLog, "list" | "stream">;
}

type AccessMethodName = "access.pairings.create" | "access.sessions.list" | "access.sessions.revoke" | "access.sessions.refresh" | "access.log.list";

/**
 * The `access` family's handlers. The wire has checked the scope and the
 * params before any of them runs. Each command writes its table rows and its
 * events in the command's transaction, which the wire opens with the receipt,
 * and its aggregate is the `access` stream; the events name the calling
 * client session and carry the command's id.
 */
export const accessMethods = (options: AccessMethodsOptions): Required<Pick<MethodHandlers, AccessMethodName>> => {
  const { pairings, clientSessions, accessLog } = options;
  const aggregate = accessLog.stream;
  return {
    "access.pairings.create": (params, { clientSession, commandId, tx }) => ({
      aggregate,
      result: pairings.create(tx, { scopes: params.scopes, ceiling: params.ceiling }, byClientSession(clientSession.id, commandId)),
    }),

    "access.sessions.list": (params) => ({ sessions: clientSessions.list({ live: params.live ?? false }) }),

    "access.sessions.revoke": (params, { clientSession, commandId, tx }) => {
      const revoked = clientSessions.revoke(tx, params.clientSessionId, "requested", byClientSession(clientSession.id, commandId));
      if (!revoked) {
        return { aggregate, rejected: { code: "not_found", message: `No client session is named ${params.clientSessionId}.` } };
      }
      return { aggregate, result: { revokedAt: revoked.revokedAt } };
    },

    "access.sessions.refresh": (_params, { clientSession, commandId, tx }) => {
      const renewed = clientSessions.refresh(tx, clientSession.id, byClientSession(clientSession.id, commandId));
      // The socket authenticated moments ago; only a revocation or the expiry landing in between gets here.
      if (!renewed) throw new ContractError({ code: "unauthorized", message: "This client session is no longer valid.", data: {} });
      return { aggregate, result: renewed };
    },

    "access.log.list": (params) => ({ events: accessLog.list(params.afterSequence ?? 0, params.limit ?? DEFAULT_LOG_PAGE) }),
  };
};
