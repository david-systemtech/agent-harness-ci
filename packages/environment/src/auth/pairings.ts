import { createHash, randomInt, randomUUID } from "node:crypto";
import {
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_TTL_MS,
  PROTOCOL_VERSION,
  PairRequest,
  SCOPES,
  normalisePairingCode,
  type Ceiling,
  type ClientKind,
  type ClientSessionCredential,
  type EnvironmentReadiness,
  type PairError,
  type ResultOf,
  type Scope,
} from "@agent-harness/contracts";
import type { PairingRow, PairingTable } from "../event-log/pairings.js";
import type { Clock } from "../serve/clock.js";
import type { RouteHandler } from "../serve/http.js";
import { SYSTEM, type AccessLog, type Attribution } from "./access-log.js";
import { DEFAULT_CEILING, type ClientSessions } from "./client-sessions.js";
import { exchangeRoute, type Refusal } from "./exchange.js";
import type { RateLimiter } from "./rate-limit.js";

/** A pairing as `access.pairings.create` answers it. */
export type MintedPairing = ResultOf<"access.pairings.create">;

/** Why an exchange of a code was refused: the pairing error's code. */
export type PairingRefusal = Extract<PairError["code"], "pairing_invalid" | "pairing_expired" | "pairing_used">;

export interface Pairings {
  /** Mints a code, valid for ten minutes and one exchange, for a client session with `scopes` and `ceiling`. */
  create(choice: { readonly scopes?: readonly Scope[] | undefined; readonly ceiling?: Ceiling | undefined }, attribution: Attribution): MintedPairing;
  /** Exchanges a code, as typed, for a client session; or says why not. */
  exchange(
    code: string,
    client: { readonly kind: ClientKind; readonly label: string },
  ): { readonly ok: true; readonly credential: ClientSessionCredential } | { readonly ok: false; readonly refusal: PairingRefusal };
  /** Records the expiry of every code whose ten minutes are over and that no one exchanged. */
  sweep(): void;
}

export interface PairingsOptions {
  readonly table: PairingTable;
  readonly clientSessions: Pick<ClientSessions, "issue">;
  readonly accessLog: Pick<AccessLog, "record" | "atomically">;
  readonly clock: Clock;
  /** The link a code is shown as: `http://<address>/pair#<code>`, on the address a client should use. */
  readonly link: (code: string) => string;
}

/** A pairing as memory mirrors the table, by code hash. */
interface Mirrored {
  readonly id: string;
  readonly scopes: readonly Scope[];
  readonly ceiling: Ceiling;
  readonly expiresAt: number;
  exchanged: boolean;
  expired: boolean;
}

const hash = (code: string): string => createHash("sha256").update(code, "utf8").digest("hex");

/** A fresh code: `PAIRING_CODE_LENGTH` characters drawn uniformly from the alphabet. */
const mint = (): string =>
  Array.from({ length: PAIRING_CODE_LENGTH }, () => PAIRING_CODE_ALPHABET.charAt(randomInt(PAIRING_CODE_ALPHABET.length))).join("");

const mirror = (row: PairingRow): Mirrored => ({
  id: row.id,
  scopes: row.scopes,
  ceiling: row.ceiling,
  expiresAt: Date.parse(row.expiresAt),
  exchanged: row.exchangedAt !== null,
  expired: row.expiredAt !== null,
});

/**
 * The environment's pairing codes. The table is read once on start into
 * memory, keyed by the code's hash; the code itself is never stored or
 * logged. Every change is written with its access-log event in one transaction.
 */
export const createPairings = (options: PairingsOptions): Pairings => {
  const { table, clientSessions, accessLog, clock } = options;
  const byHash = new Map<string, Mirrored>(table.all().map((row) => [row.codeHash, mirror(row)]));

  const expire = (pairing: Mirrored): void => {
    if (pairing.expired || pairing.exchanged) return;
    accessLog.atomically(() => {
      table.expire(pairing.id, clock.now().toISOString());
      accessLog.record("pairing.expired", { pairingId: pairing.id }, SYSTEM.sweep);
    });
    pairing.expired = true;
  };

  return {
    create(choice, attribution) {
      const now = clock.now().getTime();
      let code = mint();
      // Two live codes never share a hash: at about 49 bits a repeat is a curiosity, and is drawn again.
      while (byHash.has(hash(code))) code = mint();
      const row: PairingRow = {
        id: randomUUID(),
        codeHash: hash(code),
        scopes: [...(choice.scopes ?? SCOPES)],
        ceiling: choice.ceiling ?? DEFAULT_CEILING,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + PAIRING_TTL_MS).toISOString(),
        exchangedAt: null,
        clientSessionId: null,
        expiredAt: null,
      };
      accessLog.atomically(() => {
        table.insert(row);
        accessLog.record(
          "pairing.created",
          { pairingId: row.id, scopes: [...row.scopes], ceiling: row.ceiling, expiresAt: row.expiresAt },
          attribution,
        );
      });
      byHash.set(row.codeHash, mirror(row));
      return {
        pairingId: row.id,
        code,
        link: options.link(code),
        expiresAt: row.expiresAt,
        scopes: [...row.scopes],
        ceiling: row.ceiling,
      };
    },

    exchange(typed, client) {
      const code = normalisePairingCode(typed);
      const pairing = code === undefined ? undefined : byHash.get(hash(code));
      if (!pairing) return { ok: false, refusal: "pairing_invalid" };
      if (pairing.exchanged) return { ok: false, refusal: "pairing_used" };
      if (pairing.expired || clock.now().getTime() >= pairing.expiresAt) {
        expire(pairing);
        return { ok: false, refusal: "pairing_expired" };
      }
      const credential = accessLog.atomically(() => {
        const issued = clientSessions.issue({ kind: client.kind, label: client.label, scopes: pairing.scopes, ceiling: pairing.ceiling }, pairing.id);
        table.exchange(pairing.id, clock.now().toISOString(), issued.clientSessionId);
        accessLog.record("pairing.exchanged", { pairingId: pairing.id, clientSessionId: issued.clientSessionId }, SYSTEM.pairing);
        return issued;
      });
      pairing.exchanged = true;
      return { ok: true, credential };
    },

    sweep() {
      const now = clock.now().getTime();
      for (const pairing of byHash.values()) if (now >= pairing.expiresAt) expire(pairing);
    },
  };
};

const REFUSALS: Record<PairingRefusal, Refusal> = {
  pairing_invalid: {
    status: 401,
    error: { code: "pairing_invalid", message: "This environment issued no such pairing code.", data: {} },
  },
  pairing_expired: {
    status: 410,
    error: { code: "pairing_expired", message: "The pairing code has expired; ask for a new one.", data: {} },
  },
  pairing_used: {
    status: 410,
    error: { code: "pairing_used", message: "The pairing code has been used already; each code pairs one client.", data: {} },
  },
};

export interface PairRouteOptions {
  readonly pairings: Pick<Pairings, "exchange">;
  /** Every exchange, refused or not, spends from its remote address's bucket. */
  readonly rateLimiter: RateLimiter;
  readonly readiness: () => EnvironmentReadiness;
}

/**
 * `POST /api/pair`: from any bound address, since that is what pairing is
 * for; the Host check before it still applies. A client of another protocol
 * version is refused before its code is looked at, so the code stays good for
 * a client that speaks this one.
 */
export const pairRoute = (options: PairRouteOptions): RouteHandler =>
  exchangeRoute({
    body: PairRequest,
    what: "a pairing exchange",
    rateLimiter: options.rateLimiter,
    readiness: options.readiness,
    exchange: (body) => {
      if (body.protocolVersion !== PROTOCOL_VERSION) {
        return {
          ok: false,
          refusal: {
            status: 400,
            error: {
              code: "protocol_mismatch",
              message: `The client speaks protocol ${body.protocolVersion}; this environment speaks ${PROTOCOL_VERSION}.`,
              data: { protocolVersion: PROTOCOL_VERSION },
            },
          },
        };
      }
      const outcome = options.pairings.exchange(body.code, { kind: body.kind, label: body.label });
      return outcome.ok ? outcome : { ok: false, refusal: REFUSALS[outcome.refusal] };
    },
  });
