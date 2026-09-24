import { ContractError } from "@agent-harness/contracts";
import type { MethodHandlers } from "../serve/methods.js";
import { DEFAULT_LOG_PAGE, byClientSession, type AccessLog } from "./access-log.js";
import type { ClientSessions } from "./client-sessions.js";
import type { Pairings } from "./pairings.js";

export interface AccessMethodsOptions {
  readonly pairings: Pick<Pairings, "create">;
  readonly clientSessions: Pick<ClientSessions, "list" | "refresh" | "revoke">;
  readonly accessLog: Pick<AccessLog, "list">;
}

type AccessMethodName = "access.pairings.create" | "access.sessions.list" | "access.sessions.revoke" | "access.sessions.refresh" | "access.log.list";

/**
 * The `access` family's handlers. The wire has checked the scope and the
 * params before any of them runs; each command's events name the calling
 * client session and carry its command id.
 */
export const accessMethods = (options: AccessMethodsOptions): Required<Pick<MethodHandlers, AccessMethodName>> => {
  const { pairings, clientSessions, accessLog } = options;
  return {
    "access.pairings.create": (params, { clientSession }) =>
      pairings.create({ scopes: params.scopes, ceiling: params.ceiling }, byClientSession(clientSession.id, params.commandId)),

    "access.sessions.list": (params) => ({ sessions: clientSessions.list(params.includeEnded ?? false) }),

    "access.sessions.revoke": (params, { clientSession }) => {
      const revoked = clientSessions.revoke(params.clientSessionId, "requested", byClientSession(clientSession.id, params.commandId));
      if (!revoked) {
        throw new ContractError({ code: "not_found", message: `No client session is named ${params.clientSessionId}.`, data: {} });
      }
      return { revokedAt: revoked.revokedAt };
    },

    "access.sessions.refresh": (params, { clientSession }) => {
      const renewed = clientSessions.refresh(clientSession.id, byClientSession(clientSession.id, params.commandId));
      // The socket authenticated moments ago; only a revocation or the expiry landing in between gets here.
      if (!renewed) throw new ContractError({ code: "unauthorized", message: "This client session is no longer valid.", data: {} });
      return renewed;
    },

    "access.log.list": (params) => ({ events: accessLog.list(params.afterSequence ?? 0, params.limit ?? DEFAULT_LOG_PAGE) }),
  };
};
