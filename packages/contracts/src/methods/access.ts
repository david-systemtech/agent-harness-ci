import { z } from "zod";
import { EventEnvelope } from "../envelope.js";
import { commandParams, defineMethod } from "../method.js";
import { ClientKind, ClientSessionId, Sequence, Timestamp } from "../primitives.js";
import { Ceiling, ScopeSet } from "../scopes.js";

/**
 * Mint a one-time pairing code, valid for ten minutes. The scopes and ceiling
 * default to every scope and the environment's default ceiling.
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
    code: z.string().min(1).meta({ description: "The one-time pairing code, for typing." }),
    link: z.url().meta({ description: "A link with the code in its fragment, also rendered as a QR." }),
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
  lastSeenAt: Timestamp.nullable(),
  scopes: ScopeSet,
  ceiling: Ceiling,
});

/** Every client session paired to the environment. */
export const accessSessionsList = defineMethod({
  name: "access.sessions.list",
  scope: "admin",
  params: z.object({}),
  result: z.object({ sessions: z.array(ClientSessionSummary) }),
  errors: [],
  kind: "query",
});

/** Revoke a client session: its connections get `bye: revoked` and its token is refused from then on. */
export const accessSessionsRevoke = defineMethod({
  name: "access.sessions.revoke",
  scope: "admin",
  params: commandParams({ clientSessionId: ClientSessionId }),
  result: z.object({ revokedAt: Timestamp }),
  errors: [],
  kind: "command",
});

/** The access log: the `access` stream's events after a cursor, oldest first. */
export const accessLogList = defineMethod({
  name: "access.log.list",
  scope: "admin",
  params: z.object({
    afterSequence: Sequence.optional().meta({ description: "Return events after this sequence; from the start when absent." }),
    limit: z.int().min(1).max(1000).optional().meta({ description: "At most this many events, 1 to 1000." }),
  }),
  result: z.object({ events: z.array(EventEnvelope) }),
  errors: [],
  kind: "query",
});
