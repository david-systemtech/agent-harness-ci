import { z } from "zod";
import { DenylistChangedPayload } from "./denylist.js";
import { BypassAcknowledgedPayload } from "./permissions.js";
import { SettingsChangedPayload } from "./permissions-settings.js";
import { ClientKind, ClientSessionId, PairingId, Timestamp } from "./primitives.js";
import { Ceiling, ScopeSet } from "./scopes.js";

/**
 * The access log (ADR 0006): the `access` stream in the environment's event
 * log, one stream per environment whose id is the environment's id. It
 * records who was let in and how: pairings, client sessions, sockets, and
 * changes to what a client session may do. `access.log.list` reads it.
 */

/** The stream kind of the access log. */
export const ACCESS_STREAM_KIND = "access";

const SocketId = z.string().min(1).meta({ description: "The socket's id, the same on its opened and closed events." });

export const PairingCreatedPayload = z
  .object({
    pairingId: PairingId,
    scopes: ScopeSet,
    ceiling: Ceiling,
    expiresAt: Timestamp,
  })
  .meta({ description: "pairing.created: a pairing code was minted, with the scopes and ceiling its client session will get. The code is never logged." });

export const PairingExchangedPayload = z
  .object({ pairingId: PairingId, clientSessionId: ClientSessionId })
  .meta({ description: "pairing.exchanged: a pairing code was exchanged for the client session named." });

export const PairingExpiredPayload = z
  .object({ pairingId: PairingId })
  .meta({ description: "pairing.expired: a pairing code's ten minutes ended before anyone exchanged it." });

/** How a client session was made: the bootstrap grant (a local client) or a pairing code. */
export const CLIENT_SESSION_ORIGINS = ["bootstrap", "pairing"] as const;
export const ClientSessionOrigin = z.enum(CLIENT_SESSION_ORIGINS).meta({
  description: "How a client session was made: through the bootstrap grant, by a local client, or by exchanging a pairing code.",
});
export type ClientSessionOrigin = z.infer<typeof ClientSessionOrigin>;

export const ClientSessionCreatedPayload = z
  .object({
    clientSessionId: ClientSessionId,
    kind: ClientKind,
    label: z.string(),
    scopes: ScopeSet,
    ceiling: Ceiling,
    local: z.boolean().meta({ description: "Made through the bootstrap grant rather than by pairing." }),
    how: ClientSessionOrigin,
    pairingId: PairingId.nullable().meta({ description: "The pairing exchanged for it; null for a bootstrap." }),
    expiresAt: Timestamp,
  })
  .meta({ description: "client-session.created: a client session was made, and what it may do." });

export const ClientSessionRefreshedPayload = z
  .object({ clientSessionId: ClientSessionId, expiresAt: Timestamp })
  .meta({ description: "client-session.refreshed: a client session's token was renewed, to expire at the new time." });

/**
 * Why a client session was revoked: `requested` through `access.sessions.revoke`
 * or by the environment's owner, `replaced` by a newer desktop bootstrap,
 * `idle` for a `tui` local client session whose last socket closed an hour before.
 */
export const REVOCATION_REASONS = ["requested", "replaced", "idle"] as const;
export const RevocationReason = z.enum(REVOCATION_REASONS).meta({
  description:
    "Why a client session was revoked: requested (access.sessions.revoke), replaced (a newer desktop bootstrap), or idle (a tui local client session whose last socket closed an hour before).",
});
export type RevocationReason = z.infer<typeof RevocationReason>;

export const ClientSessionRevokedPayload = z
  .object({ clientSessionId: ClientSessionId, reason: RevocationReason })
  .meta({ description: "client-session.revoked: a client session was revoked; its sockets were closed and its token is refused." });

export const SocketOpenedPayload = z
  .object({
    clientSessionId: ClientSessionId,
    socketId: SocketId,
    remoteAddress: z.string().nullable().meta({ description: "The address the socket came from, when known." }),
  })
  .meta({ description: "socket.opened: a WebSocket authenticated as the client session." });

export const SocketClosedPayload = z
  .object({ clientSessionId: ClientSessionId, socketId: SocketId })
  .meta({ description: "socket.closed: a WebSocket of the client session closed." });

export const ScopeGrantedPayload = z
  .object({
    clientSessionId: ClientSessionId,
    granted: ScopeSet.meta({ description: "The scopes added." }),
    scopes: ScopeSet.meta({ description: "Every scope the client session holds now." }),
  })
  .meta({ description: "scope.granted: a client session was given more scopes." });

const AccessGrant = z.object({ scopes: ScopeSet, ceiling: Ceiling });
export const AccessChangedPayload = z.object({ clientSessionId: ClientSessionId, from: AccessGrant, to: AccessGrant }).meta({
  description: "access.changed: another admin client replaced this client's scopes and ceiling; existing sockets reconnect with the same token.",
});

export const CeilingChangedPayload = z
  .object({ clientSessionId: ClientSessionId, from: Ceiling, to: Ceiling })
  .meta({
    description:
      "ceiling.changed: a client session's ceiling was changed, by another client session with admin scope (access.sessions.setCeiling); it applies to the session's next run.",
  });

/**
 * Every event type the access stream carries, in the order the env spec
 * lists them, then the permissions spec's: the first acknowledgement of
 * bypass, changes to the permission settings, and changes to the denylist. The specs name these on
 * the access stream `access.*`; the prefix is the stream, not the type.
 */
export const ACCESS_EVENT_TYPES = [
  "pairing.created",
  "pairing.exchanged",
  "pairing.expired",
  "client-session.created",
  "client-session.refreshed",
  "client-session.revoked",
  "socket.opened",
  "socket.closed",
  "scope.granted",
  "access.changed",
  "ceiling.changed",
  "bypass.acknowledged",
  "settings.changed",
  "denylist.changed",
] as const;
export const AccessEventType = z.enum(ACCESS_EVENT_TYPES).meta({
  description:
    "The event types of the access stream: pairing created, exchanged, expired; client session created, refreshed, revoked; socket opened, closed; scope granted; ceiling changed; bypass acknowledged; settings changed; denylist changed.",
});
export type AccessEventType = z.infer<typeof AccessEventType>;

/** Each access event type's payload schema. */
export const ACCESS_EVENT_PAYLOADS = {
  "pairing.created": PairingCreatedPayload,
  "pairing.exchanged": PairingExchangedPayload,
  "pairing.expired": PairingExpiredPayload,
  "client-session.created": ClientSessionCreatedPayload,
  "client-session.refreshed": ClientSessionRefreshedPayload,
  "client-session.revoked": ClientSessionRevokedPayload,
  "socket.opened": SocketOpenedPayload,
  "socket.closed": SocketClosedPayload,
  "scope.granted": ScopeGrantedPayload,
  "access.changed": AccessChangedPayload,
  "ceiling.changed": CeilingChangedPayload,
  "bypass.acknowledged": BypassAcknowledgedPayload,
  "settings.changed": SettingsChangedPayload,
  "denylist.changed": DenylistChangedPayload,
} as const satisfies Record<AccessEventType, z.ZodObject>;

export type AccessEventPayload<T extends AccessEventType> = z.infer<(typeof ACCESS_EVENT_PAYLOADS)[T]>;
