import { ContractError, compareModes, type Ceiling } from "@agent-harness/contracts";
import type { MethodHandlers } from "../serve/methods.js";
import { DEFAULT_LOG_PAGE, byClientSession, type AccessLog } from "./access-log.js";
import type { ClientSessions } from "./client-sessions.js";
import type { Pairings } from "./pairings.js";

export interface AccessMethodsOptions {
  readonly pairings: Pick<Pairings, "ceilingOf" | "create">;
  readonly clientSessions: Pick<ClientSessions, "list" | "refresh" | "revoke" | "setCeiling" | "heldCeiling" | "setAccess">;
  readonly accessLog: Pick<AccessLog, "list" | "stream">;
}

type AccessMethodName =
  | "access.pairings.create"
  | "access.sessions.list"
  | "access.sessions.revoke"
  | "access.sessions.refresh"
  | "access.sessions.setCeiling"
  | "access.sessions.setAccess"
  | "access.log.list";

/**
 * The `access` family's handlers. The wire has checked the scope and the
 * params before any of them runs. Each command writes its table rows and its
 * events in the command's transaction, which the wire opens with the receipt,
 * and its aggregate is the `access` stream; the events name the calling
 * client session and carry the command's id.
 */
/**
 * The refusal of a call that would grant a ceiling above the caller's own
 * (#180): a pairing never gives more than its minter holds, and no one
 * raises another client session above their own, so a token that leaks
 * from a phone paired at acceptEdits cannot mint or make a bypass session.
 */
const aboveOwn = (granted: Ceiling, own: Ceiling, what: string) => ({
  code: "forbidden" as const,
  message: `${what} ${granted} is above this client session's own ceiling, ${own}; a client session grants at most its own.`,
  data: { scope: "admin" as const, reason: "ceiling" as const, ceiling: own },
});

export const accessMethods = (options: AccessMethodsOptions): Required<Pick<MethodHandlers, AccessMethodName>> => {
  const { pairings, clientSessions, accessLog } = options;
  const aggregate = accessLog.stream;
  return {
    "access.pairings.create": (params, { clientSession, commandId, tx }) => {
      const ceiling = pairings.ceilingOf(params.ceiling);
      if (compareModes(ceiling, clientSession.ceiling) > 0) return { aggregate, rejected: aboveOwn(ceiling, clientSession.ceiling, "A pairing at") };
      const unheld = params.scopes?.find((scope) => !clientSession.scopes.includes(scope));
      if (unheld !== undefined) {
        return {
          aggregate,
          rejected: {
            code: "forbidden",
            message: `A pairing cannot grant ${unheld}; this client session does not hold that scope.`,
            data: { reason: "scope", scope: unheld },
          },
        };
      }
      return { aggregate, result: pairings.create(tx, { scopes: params.scopes ?? clientSession.scopes, ceiling }, byClientSession(clientSession.id, commandId)) };
    },

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

    // Permissions spec, "Ceilings": no client session changes its own ceiling, whatever its scopes (#129).
    "access.sessions.setCeiling": (params, { clientSession, commandId, tx }) => {
      const target = params.clientSessionId;
      if (target === clientSession.id) {
        return {
          aggregate,
          rejected: { code: "conflict", message: "A client session cannot change its own ceiling; another admin session can.", data: { reason: "own_session" } },
        };
      }
      // Raising above the caller's own ceiling is refused; lowering never is, even to a ceiling still above it (#180).
      const current = clientSessions.heldCeiling(target);
      if (current !== undefined && compareModes(params.ceiling, current) > 0 && compareModes(params.ceiling, clientSession.ceiling) > 0) {
        return { aggregate, rejected: aboveOwn(params.ceiling, clientSession.ceiling, "Raising a client session to") };
      }
      const changed = clientSessions.setCeiling(tx, target, params.ceiling, byClientSession(clientSession.id, commandId));
      if (changed === undefined) return { aggregate, rejected: { code: "not_found", message: `No client session is named ${target}.` } };
      if (changed === "revoked") {
        return { aggregate, rejected: { code: "conflict", message: `The client session ${target} has been revoked.`, data: { reason: "revoked" } } };
      }
      return { aggregate, result: { clientSessionId: target, from: changed.from, to: changed.to } };
    },

    "access.sessions.setAccess": (params, { clientSession, commandId, tx }) => {
      const target = params.clientSessionId;
      if (target === clientSession.id) return { aggregate, rejected: { code: "conflict", message: "A client cannot change its own access; another admin client can.", data: { reason: "own_session" } } };
      const own = clientSessions.heldCeiling(clientSession.id);
      if (own === undefined) throw new ContractError({ code: "unauthorized", message: "This client session is no longer valid.", data: {} });
      if (compareModes(params.ceiling, own) > 0) return { aggregate, rejected: aboveOwn(params.ceiling, own, "A client grant at") };
      const unheld = params.scopes.find((scope) => !clientSession.scopes.includes(scope));
      if (unheld !== undefined) return { aggregate, rejected: { code: "forbidden", message: `This client cannot grant ${unheld}; it does not hold that scope.`, data: { reason: "scope", scope: unheld } } };
      const changed = clientSessions.setAccess(tx, target, params.scopes, params.ceiling, byClientSession(clientSession.id, commandId));
      if (changed === "not_found") return { aggregate, rejected: { code: "not_found", message: `No client session is named ${target}.` } };
      if (changed === "revoked" || changed === "expired") return { aggregate, rejected: { code: "conflict", message: `The client session ${target} is ${changed}.`, data: { reason: changed } } };
      return { aggregate, result: { clientSessionId: target, scopes: params.scopes, ceiling: params.ceiling } };
    },

    "access.log.list": (params) => ({ events: accessLog.list(params.afterSequence ?? 0, params.limit ?? DEFAULT_LOG_PAGE) }),
  };
};
