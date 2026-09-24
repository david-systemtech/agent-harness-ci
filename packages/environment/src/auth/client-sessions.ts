import { randomUUID } from "node:crypto";
import {
  Ceiling,
  SCOPES,
  type BootstrapKind,
  type ClientKind,
  type ClientSessionCredential,
  type Scope,
} from "@agent-harness/contracts";
import type { ClientSessionRow, ClientSessionTable } from "../event-log/client-sessions.js";
import type { Clock } from "../serve/clock.js";
import { readToken, signToken } from "./token.js";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/** How long a client session token is valid (env spec, "Pairing"); the refresh that extends it is #109's. */
export const TOKEN_LIFETIME_MS = 30 * DAY;

/** How long a `tui` local client session outlives its last open socket before it is revoked. */
export const TUI_REVOKE_AFTER_MS = 60 * MINUTE;

/** How often the environment looks for `tui` local client sessions to revoke. */
export const SWEEP_INTERVAL_MS = MINUTE;

/**
 * The ceiling the bootstrap grant's local client sessions get: the top one. Ceiling
 * values are the permissions workstream's (#129); this is the one place the
 * environment names the top one until then.
 */
export const TOP_CEILING: Ceiling = Ceiling.parse("bypassPermissions");

/** A client session a token has been verified for: what `hello` and the scope check need. */
export interface VerifiedClientSession {
  readonly id: string;
  readonly kind: ClientKind;
  readonly scopes: readonly Scope[];
  readonly ceiling: Ceiling;
  readonly local: boolean;
  /** Milliseconds since the epoch. */
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

/** Issuing and revoking client sessions from outside the wire: pairing (#109) and tests. */
export interface ClientSessionIssuer {
  /** Issues a client session that is not local, as pairing will. */
  issue(request: IssueRequest): ClientSessionCredential;
  /** Revokes a client session, closing its sockets with `bye: revoked`; false when it is unknown or already revoked. */
  revoke(id: string): boolean;
}

export interface ClientSessions extends ClientSessionIssuer {
  /** Issues a local client session for the bootstrap grant: every scope, the top ceiling; a desktop one replaces the previous desktop's. */
  issueLocal(kind: BootstrapKind, label: string): ClientSessionCredential;
  /**
   * Checks a token: its signature and issuer, then, from memory, that its
   * client session is known, not revoked and not expired. Reads no database.
   */
  verify(token: string): Verification;
  /** Hears every revocation, once, after it is stored. Returns the unsubscribe. */
  onRevoked(listener: (id: string) => void): () => void;
  /** A socket authenticated as the client session opened. */
  socketOpened(id: string): void;
  /** A socket authenticated as the client session closed. */
  socketClosed(id: string): void;
  /** Revokes every `tui` local client session whose last socket closed an hour or more ago. */
  sweep(): void;
}

export interface ClientSessionsOptions {
  readonly table: ClientSessionTable;
  /** The environment's signing key. */
  readonly key: Buffer;
  readonly environmentId: string;
  readonly clock: Clock;
}

/** A client session as memory mirrors the table, times in milliseconds, plus its open sockets. */
interface Mirrored {
  readonly kind: ClientKind;
  readonly scopes: readonly Scope[];
  readonly ceiling: Ceiling;
  readonly local: boolean;
  readonly createdAt: number;
  readonly expiresAt: number;
  lastSeenAt: number | null;
  revoked: boolean;
  /** Sockets authenticated as it and open now: the one count the sweep reads. In memory only. */
  openSockets: number;
}

const mirror = (row: ClientSessionRow): Mirrored => ({
  kind: row.kind,
  scopes: row.scopes,
  ceiling: row.ceiling,
  local: row.local,
  createdAt: Date.parse(row.createdAt),
  expiresAt: Date.parse(row.expiresAt),
  lastSeenAt: row.lastSeenAt === null ? null : Date.parse(row.lastSeenAt),
  revoked: row.revokedAt !== null,
  openSockets: 0,
});

/**
 * The environment's client sessions: the table read once, on start, into
 * memory, which is the one source for a client session's kind, scopes, ceiling,
 * local flag and expiry; every change is written through to the table.
 */
export const createClientSessions = (options: ClientSessionsOptions): ClientSessions => {
  const { table, key, environmentId, clock } = options;
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

  const create = (request: IssueRequest, local: boolean, replaces: readonly string[]): ClientSessionCredential => {
    const now = clock.now().getTime();
    const row: ClientSessionRow = {
      id: randomUUID(),
      kind: request.kind,
      label: request.label,
      scopes: [...request.scopes],
      ceiling: request.ceiling,
      local,
      createdAt: new Date(now).toISOString(),
      lastSeenAt: null,
      expiresAt: new Date(now + TOKEN_LIFETIME_MS).toISOString(),
      revokedAt: null,
    };
    // #109 appends "client session created" (and the replaced one's "revoked") to the access stream here.
    table.insert(row, replaces);
    for (const old of replaces) {
      const entry = known.get(old);
      if (entry) entry.revoked = true;
    }
    known.set(row.id, mirror(row));
    for (const old of replaces) tell(old);
    return {
      token: signToken(key, { sid: row.id, env: environmentId, iat: now }),
      clientSessionId: row.id,
      scopes: [...row.scopes],
      ceiling: row.ceiling,
      expiresAt: row.expiresAt,
    };
  };

  const revoke = (id: string): boolean => {
    const entry = known.get(id);
    if (!entry || entry.revoked) return false;
    // #109 appends "client session revoked" to the access stream here.
    table.revoke(id, clock.now().toISOString());
    entry.revoked = true;
    tell(id);
    return true;
  };

  const touch = (id: string, entry: Mirrored) => {
    const now = clock.now();
    entry.lastSeenAt = now.getTime();
    table.touch(id, now.toISOString());
  };

  return {
    issue: (request) => create(request, false, []),

    issueLocal(kind, label) {
      const replaces =
        kind === "desktop"
          ? [...known].filter(([, entry]) => entry.local && entry.kind === "desktop" && !entry.revoked).map(([id]) => id)
          : [];
      return create({ kind, label, scopes: SCOPES, ceiling: TOP_CEILING }, true, replaces);
    },

    verify(token) {
      const claims = readToken(key, token);
      if (!claims || claims.env !== environmentId) {
        return { ok: false, reason: "unauthorized", message: "The token was not issued by this environment." };
      }
      const entry = known.get(claims.sid);
      if (!entry) return { ok: false, reason: "unauthorized", message: "The token names a client session this environment does not know." };
      if (entry.revoked) return { ok: false, reason: "revoked", message: "The client session has been revoked." };
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

    revoke,

    onRevoked(listener) {
      const own = (id: string) => listener(id);
      listeners.add(own);
      return () => void listeners.delete(own);
    },

    socketOpened(id) {
      const entry = known.get(id);
      if (!entry) return;
      entry.openSockets++;
      touch(id, entry);
    },

    socketClosed(id) {
      const entry = known.get(id);
      if (!entry) return;
      entry.openSockets = Math.max(0, entry.openSockets - 1);
      touch(id, entry);
    },

    sweep() {
      const now = clock.now().getTime();
      for (const [id, entry] of known) {
        if (entry.revoked || !entry.local || entry.kind !== "tui" || entry.openSockets > 0) continue;
        if (now - (entry.lastSeenAt ?? entry.createdAt) >= TUI_REVOKE_AFTER_MS) revoke(id);
      }
    },
  };
};
