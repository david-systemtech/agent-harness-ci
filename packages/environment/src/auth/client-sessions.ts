import { randomUUID } from "node:crypto";
import {
  Ceiling,
  SCOPES,
  type BootstrapKind,
  type ClientKind,
  type ClientSessionCredential,
  type ResultOf,
  type RevocationReason,
  type Scope,
} from "@agent-harness/contracts";
import type { ClientSessionRow, ClientSessionTable } from "../event-log/client-sessions.js";
import type { Clock } from "../serve/clock.js";
import { SYSTEM, type AccessLog, type Attribution } from "./access-log.js";
import { readToken, signToken } from "./token.js";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/** How long a client session token is valid (env spec, "Pairing"), from its creation or its last refresh. */
export const TOKEN_LIFETIME_MS = 30 * DAY;

/** How long a `tui` local client session outlives its last open socket before it is revoked. */
export const TUI_REVOKE_AFTER_MS = 60 * MINUTE;

/** How often the environment sweeps: idle `tui` local client sessions, and expired pairing codes. */
export const SWEEP_INTERVAL_MS = MINUTE;

/**
 * The ceiling the bootstrap grant's local client sessions get: the top one. Ceiling
 * values are the permissions workstream's (#129); this is the one place the
 * environment names the top one until then.
 */
export const TOP_CEILING: Ceiling = Ceiling.parse("bypassPermissions");

/**
 * The ceiling a pairing gives when none is chosen: the environment's default
 * ceiling. A chosen default, the top one, since every paired client is the
 * same person (ADR 0001) and the preset scopes include `admin`, which may
 * raise it anyway; the settings store (#117) and the permissions workstream
 * (#129) make it a setting.
 */
export const DEFAULT_CEILING: Ceiling = TOP_CEILING;

/** A client session a token has been verified for: what `hello` and the scope check need. */
export interface VerifiedClientSession {
  readonly id: string;
  readonly kind: ClientKind;
  readonly scopes: readonly Scope[];
  readonly ceiling: Ceiling;
  readonly local: boolean;
  /** Milliseconds since the epoch, as of the verification; a refresh moves it (`expiresAt`). */
  readonly expiresAt: number;
}

/** Why a token is refused, as the `bye` reason that says so. */
export type Refusal = "unauthorized" | "expired" | "revoked";

export type Verification =
  | { readonly ok: true; readonly clientSession: VerifiedClientSession }
  | { readonly ok: false; readonly reason: Refusal; readonly message: string };

/** What a client session is issued with. */
export interface IssueRequest {
  readonly kind: ClientKind;
  readonly label: string;
  readonly scopes: readonly Scope[];
  readonly ceiling: Ceiling;
}

/** Issuing and revoking client sessions from the process that embeds the environment: tests, through its handle. */
export interface ClientSessionIssuer {
  /** Issues a client session that is not local, by minting a pairing code and exchanging it in-process. */
  issue(request: IssueRequest): ClientSessionCredential;
  /** Revokes a client session, closing its sockets with `bye: revoked`; false when it is unknown or already revoked. */
  revoke(id: string): boolean;
}

/** A client session as `access.sessions.list` answers it. */
export type ClientSessionSummary = ResultOf<"access.sessions.list">["sessions"][number];

/** A socket as the access log names it. */
export interface SocketRef {
  readonly socketId: string;
  readonly remoteAddress?: string | undefined;
}

export interface ClientSessions {
  /** Issues a client session for a pairing's exchange; the caller's `atomically` holds the pairing's own writes. */
  issue(request: IssueRequest, pairingId: string): ClientSessionCredential;
  /** Issues a local client session for the bootstrap grant: every scope, the top ceiling; a desktop one replaces the previous desktop's. */
  issueLocal(kind: BootstrapKind, label: string): ClientSessionCredential;
  /**
   * Checks a token: its signature and issuer, then, from memory, that its
   * client session is known, not revoked and not expired. Reads no database.
   */
  verify(token: string): Verification;
  /** The client session's expiry now, in milliseconds since the epoch; undefined when it is unknown. */
  expiresAt(id: string): number | undefined;
  /** Renews a live client session for `TOKEN_LIFETIME_MS` from now with a fresh token; undefined when it is unknown, revoked or expired. */
  refresh(id: string, attribution: Attribution): ClientSessionCredential | undefined;
  /**
   * Revokes a client session, closing its sockets with `bye: revoked`.
   * Undefined when it is unknown; for one revoked already, when it was, and
   * `changed` false.
   */
  revoke(id: string, reason: RevocationReason, attribution: Attribution): { readonly revokedAt: string; readonly changed: boolean } | undefined;
  /** Every client session, oldest first; with `includeEnded` false, only those neither revoked nor expired. */
  list(includeEnded: boolean): ClientSessionSummary[];
  /** Hears every revocation, once, after it is stored. Returns the unsubscribe. */
  onRevoked(listener: (id: string) => void): () => void;
  /** A socket authenticated as the client session opened. */
  socketOpened(id: string, socket: SocketRef): void;
  /** A socket authenticated as the client session closed. */
  socketClosed(id: string, socket: SocketRef): void;
  /** Revokes every `tui` local client session whose last socket closed an hour or more ago. */
  sweep(): void;
}

export interface ClientSessionsOptions {
  readonly table: ClientSessionTable;
  /** Where every creation, refresh, revocation and socket is recorded, in the same transaction as the table's write. */
  readonly accessLog: Pick<AccessLog, "record" | "atomically">;
  /** The environment's signing key. */
  readonly key: Buffer;
  readonly environmentId: string;
  readonly clock: Clock;
}

/** A client session as memory mirrors the table, times in milliseconds, plus its open sockets. */
interface Mirrored {
  readonly kind: ClientKind;
  readonly label: string;
  readonly scopes: readonly Scope[];
  readonly ceiling: Ceiling;
  readonly local: boolean;
  readonly createdAt: number;
  expiresAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
  /** Sockets authenticated as it and open now: the one count the sweep reads. In memory only. */
  openSockets: number;
}

const mirror = (row: ClientSessionRow): Mirrored => ({
  kind: row.kind,
  label: row.label,
  scopes: row.scopes,
  ceiling: row.ceiling,
  local: row.local,
  createdAt: Date.parse(row.createdAt),
  expiresAt: Date.parse(row.expiresAt),
  lastSeenAt: row.lastSeenAt === null ? null : Date.parse(row.lastSeenAt),
  revokedAt: row.revokedAt === null ? null : Date.parse(row.revokedAt),
  openSockets: 0,
});

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * The environment's client sessions: the table read once, on start, into
 * memory, which is the one source for a client session's kind, scopes, ceiling,
 * local flag and expiry; every change is written through to the table, with
 * its access-log event in the same transaction.
 */
export const createClientSessions = (options: ClientSessionsOptions): ClientSessions => {
  const { table, accessLog, key, environmentId, clock } = options;
  const known = new Map<string, Mirrored>(table.all().map((row) => [row.id, mirror(row)]));
  const listeners = new Set<(id: string) => void>();

  const tell = (id: string) => {
    for (const listener of [...listeners]) {
      try {
        listener(id);
      } catch (error) {
        console.error("A revocation listener threw:", error);
      }
    }
  };

  const credential = (id: string, entry: Mirrored, issuedAt: number): ClientSessionCredential => ({
    token: signToken(key, { sid: id, env: environmentId, iat: issuedAt }),
    clientSessionId: id,
    scopes: [...entry.scopes],
    ceiling: entry.ceiling,
    expiresAt: iso(entry.expiresAt),
  });

  const create = (
    request: IssueRequest,
    origin: { readonly local: boolean; readonly pairingId: string | null },
    attribution: Attribution,
    replaces: readonly string[],
  ): ClientSessionCredential => {
    const now = clock.now().getTime();
    const row: ClientSessionRow = {
      id: randomUUID(),
      kind: request.kind,
      label: request.label,
      scopes: [...request.scopes],
      ceiling: request.ceiling,
      local: origin.local,
      createdAt: iso(now),
      lastSeenAt: null,
      expiresAt: iso(now + TOKEN_LIFETIME_MS),
      revokedAt: null,
    };
    accessLog.atomically(() => {
      table.insert(row, replaces);
      for (const old of replaces) accessLog.record("client-session.revoked", { clientSessionId: old, reason: "replaced" }, attribution);
      accessLog.record(
        "client-session.created",
        {
          clientSessionId: row.id,
          kind: row.kind,
          label: row.label,
          scopes: [...row.scopes],
          ceiling: row.ceiling,
          local: row.local,
          how: origin.local ? "bootstrap" : "pairing",
          pairingId: origin.pairingId,
          expiresAt: row.expiresAt,
        },
        attribution,
      );
    });
    for (const old of replaces) {
      const entry = known.get(old);
      if (entry) entry.revokedAt = now;
    }
    const entry = mirror(row);
    known.set(row.id, entry);
    for (const old of replaces) tell(old);
    return credential(row.id, entry, now);
  };

  const revoke: ClientSessions["revoke"] = (id, reason, attribution) => {
    const entry = known.get(id);
    if (!entry) return undefined;
    if (entry.revokedAt !== null) return { revokedAt: iso(entry.revokedAt), changed: false };
    const now = clock.now().getTime();
    accessLog.atomically(() => {
      table.revoke(id, iso(now));
      accessLog.record("client-session.revoked", { clientSessionId: id, reason }, attribution);
    });
    entry.revokedAt = now;
    tell(id);
    return { revokedAt: iso(now), changed: true };
  };

  /** Records a socket event and the client session's last-seen time together; a failure is logged, never thrown into the socket's handling. */
  const seen = (id: string, entry: Mirrored, record: () => void) => {
    const now = clock.now();
    entry.lastSeenAt = now.getTime();
    try {
      accessLog.atomically(() => {
        table.touch(id, now.toISOString());
        record();
      });
    } catch (error) {
      console.error("Recording a socket in the access log failed:", error);
    }
  };

  const live = (entry: Mirrored, now: number) => entry.revokedAt === null && now < entry.expiresAt;

  return {
    issue: (request, pairingId) => create(request, { local: false, pairingId }, SYSTEM.pairing, []),

    issueLocal(kind, label) {
      const replaces =
        kind === "desktop"
          ? [...known].filter(([, entry]) => entry.local && entry.kind === "desktop" && entry.revokedAt === null).map(([id]) => id)
          : [];
      return create({ kind, label, scopes: SCOPES, ceiling: TOP_CEILING }, { local: true, pairingId: null }, SYSTEM.bootstrap, replaces);
    },

    verify(token) {
      const claims = readToken(key, token);
      if (!claims || claims.env !== environmentId) {
        return { ok: false, reason: "unauthorized", message: "The token was not issued by this environment." };
      }
      const entry = known.get(claims.sid);
      if (!entry) return { ok: false, reason: "unauthorized", message: "The token names a client session this environment does not know." };
      if (entry.revokedAt !== null) return { ok: false, reason: "revoked", message: "The client session has been revoked." };
      if (clock.now().getTime() >= entry.expiresAt) return { ok: false, reason: "expired", message: "The client session's token has expired." };
      return {
        ok: true,
        clientSession: {
          id: claims.sid,
          kind: entry.kind,
          scopes: [...entry.scopes],
          ceiling: entry.ceiling,
          local: entry.local,
          expiresAt: entry.expiresAt,
        },
      };
    },

    expiresAt: (id) => known.get(id)?.expiresAt,

    refresh(id, attribution) {
      const entry = known.get(id);
      const now = clock.now().getTime();
      if (!entry || !live(entry, now)) return undefined;
      const expiresAt = now + TOKEN_LIFETIME_MS;
      accessLog.atomically(() => {
        table.extend(id, iso(expiresAt));
        accessLog.record("client-session.refreshed", { clientSessionId: id, expiresAt: iso(expiresAt) }, attribution);
      });
      entry.expiresAt = expiresAt;
      return credential(id, entry, now);
    },

    revoke,

    list(includeEnded) {
      const now = clock.now().getTime();
      return [...known]
        .filter(([, entry]) => includeEnded || live(entry, now))
        .sort(([a, x], [b, y]) => x.createdAt - y.createdAt || (a < b ? -1 : a > b ? 1 : 0))
        .map(([id, entry]) => ({
          id,
          kind: entry.kind,
          label: entry.label,
          createdAt: iso(entry.createdAt),
          lastSeenAt: entry.lastSeenAt === null ? null : iso(entry.lastSeenAt),
          expiresAt: iso(entry.expiresAt),
          revokedAt: entry.revokedAt === null ? null : iso(entry.revokedAt),
          scopes: [...entry.scopes],
          ceiling: entry.ceiling,
          local: entry.local,
        }));
    },

    onRevoked(listener) {
      const own = (id: string) => listener(id);
      listeners.add(own);
      return () => void listeners.delete(own);
    },

    socketOpened(id, socket) {
      const entry = known.get(id);
      if (!entry) return;
      entry.openSockets++;
      seen(id, entry, () =>
        accessLog.record(
          "socket.opened",
          { clientSessionId: id, socketId: socket.socketId, remoteAddress: socket.remoteAddress ?? null },
          { actor: { kind: "client_session", id } },
        ),
      );
    },

    socketClosed(id, socket) {
      const entry = known.get(id);
      if (!entry) return;
      entry.openSockets = Math.max(0, entry.openSockets - 1);
      seen(id, entry, () =>
        accessLog.record("socket.closed", { clientSessionId: id, socketId: socket.socketId }, { actor: { kind: "client_session", id } }),
      );
    },

    sweep() {
      const now = clock.now().getTime();
      for (const [id, entry] of known) {
        if (entry.revokedAt !== null || !entry.local || entry.kind !== "tui" || entry.openSockets > 0) continue;
        if (now - (entry.lastSeenAt ?? entry.createdAt) >= TUI_REVOKE_AFTER_MS) revoke(id, "idle", SYSTEM.sweep);
      }
    },
  };
};
