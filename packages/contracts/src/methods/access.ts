import { z } from "zod";
import { ClientSessionCredential } from "../bootstrap.js";
import { EventEnvelope } from "../envelope.js";
import { commandParams, defineMethod } from "../method.js";
import { ClientKind, ClientSessionId, PairingId, Sequence, Timestamp } from "../primitives.js";
import { Ceiling, ScopeSet } from "../scopes.js";

/**
 * Mint a one-time pairing code, valid for ten minutes and one exchange at
 * `/api/pair`. The scopes and ceiling default to every scope and the
 * environment's default ceiling.
 */
export const accessPairingsCreate = defineMethod({
  name: "access.pairings.create",
  scope: "admin",
  params: commandParams({
    scopes: ScopeSet.optional().meta({ description: "The scopes the client session will hold; every scope when absent." }),
    ceiling: Ceiling.optional().meta({
      description: "The client session's ceiling; the environment's default ceiling when absent.",
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

/** The environment's client sessions, oldest first: the live ones, or every one with `includeEnded`. */
export const accessSessionsList = defineMethod({
  name: "access.sessions.list",
  scope: "admin",
  params: z.object({
    includeEnded: z.boolean().optional().meta({
      description: "Include client sessions that were revoked or have expired; false when absent.",
    }),
  }),
  result: z.object({ sessions: z.array(ClientSessionSummary) }),
  errors: [],
  kind: "query",
});

/**
 * Revoke a client session: its sockets get `bye: revoked` and its token is
 * refused from then on. Revoking the caller's own client session is allowed
 * and closes the caller. An unknown id is `not_found`; one revoked already
 * answers when it was.
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
