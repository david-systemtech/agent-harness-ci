import { z } from "zod";
import { ClientSessionCredential } from "../bootstrap.js";
import { EventEnvelope } from "../envelope.js";
import { commandParams, defineMethod } from "../method.js";
import { ClientKind, ClientSessionId, PairingId, Sequence, Timestamp } from "../primitives.js";
import { Ceiling, ScopeSet } from "../scopes.js";

/**
 * Mint a one-time pairing code, valid for ten minutes and one exchange at
 * `/api/pair`. Scopes default to the minter's own; a requested scope it does
 * not hold is forbidden with reason scope. The ceiling defaults to the
 * environment's default ceiling, the setting `permissions.defaultCeiling`.
 */
export const accessPairingsCreate = defineMethod({
  name: "access.pairings.create",
  scope: "admin",
  params: commandParams({
    scopes: ScopeSet.optional().meta({
      description: "The scopes the client session will hold; the minter's own scopes when absent. A scope the minter does not hold is forbidden with reason scope, naming it in data.scope.",
    }),
    ceiling: Ceiling.optional().meta({
      description: "The client session's ceiling; the environment's default ceiling (the setting permissions.defaultCeiling) when absent.",
    }),
  }),
  result: z.object({
    pairingId: PairingId,
    code: z.string().min(1).meta({
      description: "The one-time pairing code in its canonical form; show it in two groups of five for typing.",
    }),
    link: z.url().meta({
      description: "http://<address>/pair#<code>: the code in the fragment, so it never reaches a log. Render it as a QR.",
    }),
    expiresAt: Timestamp.meta({ description: "When the code expires: it is valid for ten minutes, and for one use." }),
    scopes: ScopeSet,
    ceiling: Ceiling,
  }),
  errors: [],
  kind: "command",
});

/** A pairing code as `access.pairings.create` mints it. */
export type MintedPairing = z.infer<typeof accessPairingsCreate.result>;

const ClientSessionSummary = z.object({
  id: ClientSessionId,
  kind: ClientKind,
  label: z.string(),
  createdAt: Timestamp,
  lastSeenAt: Timestamp.nullable().meta({ description: "When a socket of it last opened or closed; null until one has." }),
  expiresAt: Timestamp,
  revokedAt: Timestamp.nullable(),
  scopes: ScopeSet,
  ceiling: Ceiling,
  local: z.boolean().meta({ description: "Made through the bootstrap grant by a client on the environment's machine." }),
});

/** Every client session of the environment, oldest first; with `live`, only those neither revoked nor expired. */
export const accessSessionsList = defineMethod({
  name: "access.sessions.list",
  scope: "admin",
  params: z.object({
    live: z.boolean().optional().meta({
      description: "Leave out client sessions that were revoked or have expired; false when absent, so every one is listed.",
    }),
  }),
  result: z.object({ sessions: z.array(ClientSessionSummary) }),
  errors: [],
  kind: "query",
});

/**
 * Revoke a client session: its sockets get `bye: revoked` and its token is
 * refused from then on. Revoking the caller's own client session is allowed
 * and closes the caller. An unknown id is rejected with a receipt of reason
 * `not_found`; one revoked already answers when it was, unchanged.
 */
export const accessSessionsRevoke = defineMethod({
  name: "access.sessions.revoke",
  scope: "admin",
  params: commandParams({ clientSessionId: ClientSessionId }),
  result: z.object({ revokedAt: Timestamp }),
  errors: [],
  kind: "command",
});

/**
 * Change another client session's ceiling (permissions spec, "Ceilings"):
 * raising or lowering it, recorded as `ceiling.changed` in the access log
 * and applied to that client session's next run; a run already going keeps
 * the policy it started with. The caller's own client session is refused
 * with a receipt of reason `conflict` and `data.reason` `own_session`,
 * whatever its scopes, so no client session changes its own ceiling. An
 * unknown id is `not_found`, a revoked one `conflict` with reason `revoked`;
 * the ceiling it has already changes nothing.
 */
export const accessSessionsSetCeiling = defineMethod({
  name: "access.sessions.setCeiling",
  scope: "admin",
  params: commandParams({ clientSessionId: ClientSessionId, ceiling: Ceiling }),
  result: z.object({ clientSessionId: ClientSessionId, from: Ceiling, to: Ceiling }),
  errors: [],
  kind: "command",
});

/** Replace another live client's grant. No self-edit or grant above the caller's scopes/ceiling. */
export const accessSessionsSetAccess = defineMethod({
  name: "access.sessions.setAccess",
  scope: "admin",
  params: commandParams({ clientSessionId: ClientSessionId, scopes: ScopeSet, ceiling: Ceiling }),
  result: z.object({ clientSessionId: ClientSessionId, scopes: ScopeSet, ceiling: Ceiling }),
  errors: [],
  kind: "command",
});

/**
 * Renew the caller's own client session for another 30 days from now, with
 * a fresh token. The previous token stays valid too: expiry belongs to the
 * client session, not to a token.
 */
export const accessSessionsRefresh = defineMethod({
  name: "access.sessions.refresh",
  scope: "read",
  params: commandParams({}),
  result: ClientSessionCredential,
  errors: [],
  kind: "command",
});

/** The access log: the `access` stream's events after a cursor, oldest first, newest last. */
export const accessLogList = defineMethod({
  name: "access.log.list",
  scope: "admin",
  params: z.object({
    afterSequence: Sequence.optional().meta({ description: "Return events after this sequence; from the start when absent." }),
    limit: z.int().min(1).max(1000).optional().meta({ description: "At most this many events, 1 to 1000; 100 when absent." }),
  }),
  result: z.object({ events: z.array(EventEnvelope) }),
  errors: [],
  kind: "query",
});
