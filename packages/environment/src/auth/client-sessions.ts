import { randomUUID } from "node:crypto";
import {
  Ceiling,
  PERMISSION_SETTINGS,
  SCOPES,
  type BootstrapKind,
  type ClientKind,
  type ClientSessionCredential,
  type ResultOf,
  type RevocationReason,
  type Scope,
} from "@agent-harness/contracts";
import type { ClientSessionRow, ClientSessionTable } from "../event-log/client-sessions.js";
import type { Tx } from "../event-log/event-log.js";
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

/** The ceiling the bootstrap grant's local client sessions get: the top one (permissions spec, "Ceilings"). */
export const TOP_CEILING: Ceiling = "bypassPermissions";

/**
 * The ceiling a pairing gives when none is chosen and the setting
 * `permissions.defaultCeiling` has not been changed: its preset, acceptEdits.
 */
export const DEFAULT_CEILING: Ceiling = PERMISSION_SETTINGS["permissions.defaultCeiling"].preset;

/** A client session a token has been verified for: what `hello` and the scope check need. */
export interface VerifiedClientSession {
  readonly id: string;
  readonly kind: ClientKind;
  readonly scopes: readonly Scope[];
  readonly ceiling: Ceiling;
  readonly local: boolean;
  /** Milliseconds since the epoch, as of the verification; a refresh moves it (`ClientSessions.expiresAt`). */
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

/**
 * The environment's client sessions. Every change takes the `Tx` of the
 * `atomically` its caller opened, writes the table and the access log inside
 * it, and changes memory only once it has committed: a rolled-back change
 * leaves no client session that `verify` would take.
 */
export interface ClientSessions {
  /** Issues the client session a pairing's exchange makes, under the id the exchange already recorded. */
  issue(tx: Tx, request: IssueRequest, origin: { readonly id: string; readonly pairingId: string }): ClientSessionCredential;
  /** Issues a local client session for the bootstrap grant: every scope, the top ceiling; a desktop one replaces the previous desktop's. */
  issueLocal(tx: Tx, kind: BootstrapKind, label: string): ClientSessionCredential;
  /**
   * Checks a token: its signature and issuer, then, from memory, that its
   * client session is known, not revoked and not expired. Reads no database.
   */
  verify(token: string): Verification;
  /** The client session's expiry now, in milliseconds since the epoch; undefined when it is unknown. */
  expiresAt(id: string): number | undefined;
  /** Renews a live client session for `TOKEN_LIFETIME_MS` from now with a fresh token; undefined when it is unknown, revoked or expired. */
  refresh(tx: Tx, id: string, attribution: Attribution): ClientSessionCredential | undefined;
  /**
   * Revokes a client session; once committed, its sockets are closed with
   * `bye: revoked`. Undefined when it is unknown; for one revoked already,
   * when it was, and `changed` false.
   */
  revoke(tx: Tx, id: string, reason: RevocationReason, attribution: Attribution): { readonly revokedAt: string; readonly changed: boolean } | undefined;
  /**
   * Sets another client session's ceiling, recorded as `ceiling.changed`;
   * once committed, its next run and its next `hello` have it. Undefined
   * when it is unknown; `revoked` when it has been revoked; `changed` false
   * when it has the ceiling already.
   */
  setCeiling(
    tx: Tx,
    id: string,
    ceiling: Ceiling,
    attribution: Attribution,
  ): { readonly from: Ceiling; readonly to: Ceiling; readonly changed: boolean } | "revoked" | undefined;
  setAccess(tx: Tx, id: string, scopes: readonly Scope[], ceiling: Ceiling, attribution: Attribution): "revoked" | "expired" | "not_found" | "changed" | "unchanged";
  onAccessChanged(listener: (id: string) => void): () => void;
  /**
   * The client session's ceiling now; undefined when it is unknown, revoked
   * or expired, so nothing is started under the ceiling of a client session
   * that can no longer act (a run from the queue waits instead).
   */
  ceiling(id: string): Ceiling | undefined;
  /** The ceiling the client session holds, live, expired or revoked; undefined only for an id never issued. */
  heldCeiling(id: string): Ceiling | undefined;
  /** Every client session, oldest first; with `live`, only those neither revoked nor expired. */
  list(options: { readonly live: boolean }): ClientSessionSummary[];
  /** Hears every revocation, once, after it is committed. Returns the unsubscribe. */
  onRevoked(listener: (id: string) => void): () => void;
  /** A socket authenticated as the client session opened. */
  socketOpened(tx: Tx, id: string, socket: SocketRef): void;
  /** A socket authenticated as the client session closed. */
  socketClosed(tx: Tx, id: string, socket: SocketRef): void;
  /** Revokes every `tui` local client session whose last socket closed an hour or more ago. */
  sweep(tx: Tx): void;
}

/** What the wire needs of the client sessions: verification, expiry, revocations, and its sockets recorded. */
export interface SocketSessions {
  onAccessChanged(listener: (id: string) => void): () => void;
  verify(token: string): Verification;
  expiresAt(id: string): number | undefined;
  onRevoked(listener: (id: string) => void): () => void;
  socketOpened(id: string, socket: SocketRef): void;
  socketClosed(id: string, socket: SocketRef): void;
}

/**
 * The wire's view of `sessions`: each socket event is its own transaction,
 * opened here, and a failure to record one is logged, never thrown into the
 * socket's handling.
 */
export const socketSessions = (sessions: ClientSessions, atomically: <T>(work: (tx: Tx) => T) => T): SocketSessions => {
  const record = (work: (tx: Tx) => void) => {
    try {
      atomically(work);
    } catch (error) {
      console.error("Recording a socket in the access log failed:", error);
    }
  };
  return {
    onAccessChanged: (listener) => sessions.onAccessChanged(listener),
    verify: (token) => sessions.verify(token),
    expiresAt: (id) => sessions.expiresAt(id),
    onRevoked: (listener) => sessions.onRevoked(listener),
    socketOpened: (id, socket) => record((tx) => sessions.socketOpened(tx, id, socket)),
    socketClosed: (id, socket) => record((tx) => sessions.socketClosed(tx, id, socket)),
  };
};

export interface ClientSessionsOptions {
  readonly table: ClientSessionTable;
  /** Where every creation, refresh, revocation and socket is recorded, in the caller's transaction. */
  readonly accessLog: Pick<AccessLog, "record">;
  /** The environment's signing key. */
  readonly key: Buffer;
  readonly environmentId: string;
  readonly clock: Clock;
}

/** A client session as memory mirrors the table, times in milliseconds, plus its open sockets. */
interface Mirrored {
  readonly kind: ClientKind;
  readonly label: string;
  scopes: readonly Scope[];
  ceiling: Ceiling;
  readonly local: boolean;
  readonly createdAt: number;
  expiresAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
  /** Sockets authenticated as it and open now: the one count the sweep reads. In memory only, and never rolled back. */
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
 * its access-log event, in the caller's transaction.
 */
export const createClientSessions = (options: ClientSessionsOptions): ClientSessions => {
  const { table, accessLog, key, environmentId, clock } = options;
  const known = new Map<string, Mirrored>(table.all().map((row) => [row.id, mirror(row)]));
  const listeners = new Set<(id: string) => void>();
  const accessListeners = new Set<(id: string) => void>();

  const tell = (id: string) => {
    for (const listener of [...listeners]) {
      try {
        listener(id);
      } catch (error) {
        console.error("A revocation listener threw:", error);
      }
    }
  };

  const credential = (id: string, scopes: readonly Scope[], ceiling: Ceiling, expiresAt: number, issuedAt: number): ClientSessionCredential => ({
    token: signToken(key, { sid: id, env: environmentId, iat: issuedAt }),
    clientSessionId: id,
    scopes: [...scopes],
    ceiling,
    expiresAt: iso(expiresAt),
  });

  const create = (
    tx: Tx,
    id: string,
    request: IssueRequest,
    origin: { readonly local: boolean; readonly pairingId: string | null },
    attribution: Attribution,
    replaces: readonly string[],
  ): ClientSessionCredential => {
    const now = clock.now().getTime();
    const row: ClientSessionRow = {
      id,
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
    table.insert(tx, row, replaces);
    for (const old of replaces) accessLog.record(tx, "client-session.revoked", { clientSessionId: old, reason: "replaced" }, attribution);
    accessLog.record(
      tx,
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
    tx.afterCommit(() => {
      for (const old of replaces) {
        const entry = known.get(old);
        if (entry) entry.revokedAt = now;
      }
      known.set(row.id, mirror(row));
      for (const old of replaces) tell(old);
    });
    return credential(row.id, row.scopes, row.ceiling, now + TOKEN_LIFETIME_MS, now);
  };

  const revoke: ClientSessions["revoke"] = (tx, id, reason, attribution) => {
    const entry = known.get(id);
    if (!entry) return undefined;
    if (entry.revokedAt !== null) return { revokedAt: iso(entry.revokedAt), changed: false };
    const now = clock.now().getTime();
    table.revoke(tx, id, iso(now));
    accessLog.record(tx, "client-session.revoked", { clientSessionId: id, reason }, attribution);
    tx.afterCommit(() => {
      entry.revokedAt = now;
      tell(id);
    });
    return { revokedAt: iso(now), changed: true };
  };

  /** Records a socket event and the client session's last-seen time together. */
  const seen = (tx: Tx, id: string, entry: Mirrored, record: () => void) => {
    const now = clock.now();
    table.touch(tx, id, now.toISOString());
    record();
    tx.afterCommit(() => (entry.lastSeenAt = now.getTime()));
  };

  const live = (entry: Mirrored, now: number) => entry.revokedAt === null && now < entry.expiresAt;

  return {
    issue: (tx, request, origin) => create(tx, origin.id, request, { local: false, pairingId: origin.pairingId }, SYSTEM.exchange, []),

    issueLocal(tx, kind, label) {
      const replaces =
        kind === "desktop"
          ? [...known].filter(([, entry]) => entry.local && entry.kind === "desktop" && entry.revokedAt === null).map(([id]) => id)
          : [];
      return create(tx, randomUUID(), { kind, label, scopes: SCOPES, ceiling: TOP_CEILING }, { local: true, pairingId: null }, SYSTEM.bootstrap, replaces);
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

    refresh(tx, id, attribution) {
      const entry = known.get(id);
      const now = clock.now().getTime();
      if (!entry || !live(entry, now)) return undefined;
      const expiresAt = now + TOKEN_LIFETIME_MS;
      table.extend(tx, id, iso(expiresAt));
      accessLog.record(tx, "client-session.refreshed", { clientSessionId: id, expiresAt: iso(expiresAt) }, attribution);
      tx.afterCommit(() => (entry.expiresAt = expiresAt));
      return credential(id, entry.scopes, entry.ceiling, expiresAt, now);
    },

    revoke,

    setCeiling(tx, id, ceiling, attribution) {
      const entry = known.get(id);
      if (!entry) return undefined;
      if (entry.revokedAt !== null) return "revoked";
      const from = entry.ceiling;
      if (from === ceiling) return { from, to: ceiling, changed: false };
      table.setCeiling(tx, id, ceiling);
      accessLog.record(tx, "ceiling.changed", { clientSessionId: id, from, to: ceiling }, attribution);
      tx.afterCommit(() => (entry.ceiling = ceiling));
      return { from, to: ceiling, changed: true };
    },

    ceiling(id) {
      const entry = known.get(id);
      return entry === undefined || !live(entry, clock.now().getTime()) ? undefined : entry.ceiling;
    },

    setAccess(tx, id, scopes, ceiling, attribution) {
      const entry = known.get(id);
      if (!entry) return "not_found";
      if (entry.revokedAt !== null) return "revoked";
      if (!live(entry, clock.now().getTime())) return "expired";
      if (entry.ceiling === ceiling && entry.scopes.length === scopes.length && entry.scopes.every((scope) => scopes.includes(scope))) return "unchanged";
      const to = { scopes: [...scopes], ceiling };
      table.setAccess(tx, id, to.scopes, ceiling);
      accessLog.record(tx, "access.changed", { clientSessionId: id, from: { scopes: [...entry.scopes], ceiling: entry.ceiling }, to }, attribution);
      tx.afterCommit(() => {
        entry.scopes = to.scopes;
        entry.ceiling = ceiling;
        for (const listener of [...accessListeners]) {
          try { listener(id); } catch (error) { console.error("An access-change listener threw:", error); }
        }
      });
      return "changed";
    },

    onAccessChanged(listener) {
      accessListeners.add(listener);
      return () => void accessListeners.delete(listener);
    },

    heldCeiling: (id) => known.get(id)?.ceiling,

    list({ live: liveOnly }) {
      const now = clock.now().getTime();
      return [...known]
        .filter(([, entry]) => !liveOnly || live(entry, now))
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

    socketOpened(tx, id, socket) {
      const entry = known.get(id);
      if (!entry) return;
      entry.openSockets++;
      seen(tx, id, entry, () =>
        accessLog.record(
          tx,
          "socket.opened",
          { clientSessionId: id, socketId: socket.socketId, remoteAddress: socket.remoteAddress ?? null },
          { actor: { kind: "client_session", id } },
        ),
      );
    },

    socketClosed(tx, id, socket) {
      const entry = known.get(id);
      if (!entry) return;
      entry.openSockets = Math.max(0, entry.openSockets - 1);
      seen(tx, id, entry, () =>
        accessLog.record(tx, "socket.closed", { clientSessionId: id, socketId: socket.socketId }, { actor: { kind: "client_session", id } }),
      );
    },

    sweep(tx) {
      const now = clock.now().getTime();
      for (const [id, entry] of known) {
        if (entry.revokedAt !== null || !entry.local || entry.kind !== "tui" || entry.openSockets > 0) continue;
        if (now - (entry.lastSeenAt ?? entry.createdAt) >= TUI_REVOKE_AFTER_MS) revoke(tx, id, "idle", SYSTEM.sweep);
      }
    },
  };
};
