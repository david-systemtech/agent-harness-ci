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

/** How long a `tui` local session outlives its last connection before it is revoked. */
export const TUI_REVOKE_AFTER_MS = 60 * MINUTE;

/** How often the environment looks for `tui` local sessions to revoke. */
export const SWEEP_INTERVAL_MS = MINUTE;

/**
 * The ceiling the bootstrap grant's local sessions get: the top one. Ceiling
 * values are the permissions workstream's (#129); this is the one place the
 * environment names the top one until then.
 */
export const TOP_CEILING: Ceiling = Ceiling.parse("bypassPermissions");

/** A client session a token has been verified for: what `hello` and the scope check need. */
export interface VerifiedSession {
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
  | { readonly ok: true; readonly session: VerifiedSession }
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
  /** Revokes a client session, closing its connections with `bye: revoked`; false when it is unknown or already revoked. */
  revoke(id: string): boolean;
}

export interface ClientSessions extends ClientSessionIssuer {
  /** Issues a local session for the bootstrap grant: every scope, the top ceiling; a desktop one replaces the previous desktop's. */
  issueLocal(kind: BootstrapKind, label: string): ClientSessionCredential;
  /** Checks a token: its signature and issuer, then, from memory, that the session is known and not revoked, then its expiry. */
  verify(token: string): Verification;
  /** Hears every revocation, once, after it is stored. Returns the unsubscribe. */
  onRevoked(listener: (id: string) => void): () => void;
  /** A connection of the session opened. */
  connected(id: string): void;
  /** A connection of the session closed. */
  disconnected(id: string): void;
  /** Revokes every `tui` local session whose last connection closed an hour or more ago. */
  sweep(): void;
}

export interface ClientSessionsOptions {
  readonly table: ClientSessionTable;
  /** The environment's signing key. */
  readonly key: Buffer;
  readonly environmentId: string;
  readonly clock: Clock;
}

interface Known {
  readonly kind: string;
  readonly local: boolean;
  readonly createdAt: number;
  lastSeenAt: number | null;
  revoked: boolean;
  /** Connections open now; in memory only. */
  open: number;
}

/**
 * The environment's client sessions: loaded from the table once, then kept in
 * memory, so verifying a token reads nothing; every change is written through.
 */
export const createClientSessions = (options: ClientSessionsOptions): ClientSessions => {
  const { table, key, environmentId, clock } = options;
  const known = new Map<string, Known>();
  for (const row of table.all()) {
    known.set(row.id, {
      kind: row.kind,
      local: row.local,
      createdAt: Date.parse(row.createdAt),
      lastSeenAt: row.lastSeenAt === null ? null : Date.parse(row.lastSeenAt),
      revoked: row.revokedAt !== null,
      open: 0,
    });
  }
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
    const id = randomUUID();
    const scopes = [...request.scopes];
    const expiresAt = now + TOKEN_LIFETIME_MS;
    const row: ClientSessionRow = {
      id,
      kind: request.kind,
      label: request.label,
      scopes,
      ceiling: request.ceiling,
      local,
      createdAt: new Date(now).toISOString(),
      lastSeenAt: null,
      expiresAt: new Date(expiresAt).toISOString(),
      revokedAt: null,
    };
    // #109 appends "client session created" (and the replaced one's "revoked") to the access stream here.
    table.insert(row, replaces);
    for (const old of replaces) {
      const entry = known.get(old);
      if (entry) entry.revoked = true;
    }
    known.set(id, { kind: request.kind, local, createdAt: now, lastSeenAt: null, revoked: false, open: 0 });
    for (const old of replaces) tell(old);
    const token = signToken(key, {
      sid: id,
      env: environmentId,
      kind: request.kind,
      scopes,
      ceiling: request.ceiling,
      local,
      iat: now,
      exp: expiresAt,
    });
    return { token, clientSessionId: id, scopes, ceiling: request.ceiling, expiresAt: new Date(expiresAt).toISOString() };
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

  const touch = (id: string, entry: Known) => {
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
      if (clock.now().getTime() >= claims.exp) return { ok: false, reason: "expired", message: "The client session's token has expired." };
      return {
        ok: true,
        session: {
          id: claims.sid,
          kind: claims.kind,
          scopes: claims.scopes,
          ceiling: claims.ceiling,
          local: claims.local,
          expiresAt: claims.exp,
        },
      };
    },

    revoke,

    onRevoked(listener) {
      const own = (id: string) => listener(id);
      listeners.add(own);
      return () => void listeners.delete(own);
    },

    connected(id) {
      const entry = known.get(id);
      if (!entry) return;
      entry.open++;
      touch(id, entry);
    },

    disconnected(id) {
      const entry = known.get(id);
      if (!entry) return;
      entry.open = Math.max(0, entry.open - 1);
      touch(id, entry);
    },

    sweep() {
      const now = clock.now().getTime();
      for (const [id, entry] of known) {
        if (entry.revoked || !entry.local || entry.kind !== "tui" || entry.open > 0) continue;
        if (now - (entry.lastSeenAt ?? entry.createdAt) >= TUI_REVOKE_AFTER_MS) revoke(id);
      }
    },
  };
};
