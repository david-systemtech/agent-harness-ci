import { z } from "zod";
import { EventEnvelope } from "../envelope.js";
import { commandParams, defineMethod } from "../method.js";
import { ClientKind, Sequence, Timestamp } from "../primitives.js";
import { Ceiling, ScopeSet } from "../scopes.js";

/**
 * Mint a one-time pairing code, valid for ten minutes. The scopes and ceiling
 * default to every scope and the environment's default ceiling.
 */
export const accessPairingsCreate = defineMethod({
  name: "access.pairings.create",
  scope: "admin",
  params: commandParams({ scopes: ScopeSet.optional(), ceiling: Ceiling.optional() }),
  result: z.object({
    /** The short code, for typing. */
    code: z.string().min(1),
    /** The link with the code in its fragment, also rendered as a QR. */
    link: z.url(),
    expiresAt: Timestamp,
    scopes: ScopeSet,
    ceiling: Ceiling,
  }),
  errors: [],
  stream: false,
  mutating: true,
});

const ClientSessionSummary = z.object({
  id: z.string().min(1),
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
  stream: false,
  mutating: false,
});

/** Revoke a client session: its connections get `bye: revoked` and its token is refused from then on. */
export const accessSessionsRevoke = defineMethod({
  name: "access.sessions.revoke",
  scope: "admin",
  params: commandParams({ clientSessionId: z.string().min(1) }),
  result: z.object({ revokedAt: Timestamp }),
  errors: [],
  stream: false,
  mutating: true,
});

/** The access log: the `access` stream's events after a cursor, oldest first. */
export const accessLogList = defineMethod({
  name: "access.log.list",
  scope: "admin",
  params: z.object({ afterSequence: Sequence.optional(), limit: z.int().min(1).max(1000).optional() }),
  result: z.object({ events: z.array(EventEnvelope) }),
  errors: [],
  stream: false,
  mutating: false,
});
