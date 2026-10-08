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
  type EnvironmentReadiness,
  type MintedPairing,
  type PairError,
  type Scope,
} from "@agent-harness/contracts";
import type { Tx } from "../event-log/event-log.js";
import type { PairingRow, PairingTable } from "../event-log/pairings.js";
import type { Clock } from "../serve/clock.js";
import type { ClientAddressOf } from "../serve/client-address.js";
import type { RouteHandler } from "../serve/http.js";
import { SYSTEM, type AccessLog, type Attribution } from "./access-log.js";
import { DEFAULT_CEILING, type ClientSessions } from "./client-sessions.js";
import { exchangeRoute, type Outcome, type Refusal } from "./exchange.js";
import type { RateLimiter } from "./rate-limit.js";

/** Why an exchange of a code was refused: the pairing error's code. */
export type PairingRefusal = Extract<PairError["code"], "pairing_invalid" | "pairing_expired" | "pairing_used">;

/**
 * The environment's pairing codes. Every change takes the `Tx` of the
 * `atomically` its caller opened; memory follows only once it commits.
 */
export interface Pairings {
  /** The ceiling a pairing gives for `chosen`: it, else the setting `permissions.defaultCeiling`, read now. */
  ceilingOf(chosen: Ceiling | undefined): Ceiling;
  /** Mints a code, valid for ten minutes and one exchange, for a client session with `scopes` and `ceiling`. */
  create(tx: Tx, choice: { readonly scopes?: readonly Scope[] | undefined; readonly ceiling?: Ceiling | undefined }, attribution: Attribution): MintedPairing;
  /**
   * Exchanges a code, as typed, for a client session; or says why not. A
   * code found expired has its expiry recorded, attributed to the exchange.
   */
  exchange(tx: Tx, code: string, client: { readonly kind: ClientKind; readonly label: string }): Outcome<PairingRefusal>;
  /** Records the expiry of every code whose ten minutes are over and that no one exchanged, attributed to the sweep. */
  sweep(tx: Tx): void;
  /** Whether any code was ever exchanged here: whether a client has ever paired. */
  everExchanged(): boolean;
}

export interface PairingsOptions {
  readonly table: PairingTable;
  readonly clientSessions: Pick<ClientSessions, "issue">;
  readonly accessLog: Pick<AccessLog, "record">;
  readonly clock: Clock;
  /** The link a code is shown as: `http://<address>/pair#<code>`, on the address a client should use. */
  readonly link: (code: string) => string;
  /** The ceiling a pairing gives when none is chosen, read in the minting transaction: the setting `permissions.defaultCeiling`. Preset: its preset. */
  readonly defaultCeiling?: () => Ceiling;
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
 * logged. Every change is written with its access-log event in the caller's
 * transaction.
 */
export const createPairings = (options: PairingsOptions): Pairings => {
  const { table, clientSessions, accessLog, clock } = options;
  const byHash = new Map<string, Mirrored>(table.all().map((row) => [row.codeHash, mirror(row)]));

  const expire = (tx: Tx, pairing: Mirrored, attribution: Attribution): void => {
    if (pairing.expired || pairing.exchanged) return;
    table.expire(tx, pairing.id, clock.now().toISOString());
    accessLog.record(tx, "pairing.expired", { pairingId: pairing.id }, attribution);
    tx.afterCommit(() => (pairing.expired = true));
  };

  const ceilingOf = (chosen: Ceiling | undefined): Ceiling => chosen ?? options.defaultCeiling?.() ?? DEFAULT_CEILING;

  return {
    ceilingOf,
    create(tx, choice, attribution) {
      const now = clock.now().getTime();
      let code = mint();
      // Two codes never share a hash: at about 49 bits a repeat is a curiosity, and is drawn again.
      while (byHash.has(hash(code))) code = mint();
      const row: PairingRow = {
        id: randomUUID(),
        codeHash: hash(code),
        scopes: [...(choice.scopes ?? SCOPES)],
        ceiling: ceilingOf(choice.ceiling),
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + PAIRING_TTL_MS).toISOString(),
        exchangedAt: null,
        clientSessionId: null,
        expiredAt: null,
      };
      table.insert(tx, row);
      accessLog.record(tx, "pairing.created", { pairingId: row.id, scopes: [...row.scopes], ceiling: row.ceiling, expiresAt: row.expiresAt }, attribution);
      tx.afterCommit(() => byHash.set(row.codeHash, mirror(row)));
      return {
        pairingId: row.id,
        code,
        link: options.link(code),
        expiresAt: row.expiresAt,
        scopes: [...row.scopes],
        ceiling: row.ceiling,
      };
    },

    exchange(tx, typed, client) {
      const code = normalisePairingCode(typed);
      const pairing = code === undefined ? undefined : byHash.get(hash(code));
      if (!pairing) return { ok: false, refusal: "pairing_invalid" };
      if (pairing.exchanged) return { ok: false, refusal: "pairing_used" };
      if (pairing.expired || clock.now().getTime() >= pairing.expiresAt) {
        expire(tx, pairing, SYSTEM.exchange);
        return { ok: false, refusal: "pairing_expired" };
      }
      // The exchange is recorded before the client session it makes, under the id it will have.
      const clientSessionId = randomUUID();
      accessLog.record(tx, "pairing.exchanged", { pairingId: pairing.id, clientSessionId }, SYSTEM.exchange);
      const credential = clientSessions.issue(
        tx,
        { kind: client.kind, label: client.label, scopes: pairing.scopes, ceiling: pairing.ceiling },
        { id: clientSessionId, pairingId: pairing.id },
      );
      table.exchange(tx, pairing.id, clock.now().toISOString(), clientSessionId);
      tx.afterCommit(() => (pairing.exchanged = true));
      return { ok: true, credential };
    },

    sweep(tx) {
      const now = clock.now().getTime();
      for (const pairing of byHash.values()) if (now >= pairing.expiresAt) expire(tx, pairing, SYSTEM.sweep);
    },

    everExchanged: () => [...byHash.values()].some((pairing) => pairing.exchanged),
  };
};

const REFUSALS: Record<PairingRefusal, Refusal<PairError>> = {
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
  /** Opens the one transaction an exchange writes in, refused or not: a code found expired records its expiry. */
  readonly atomically: <T>(work: (tx: Tx) => T) => T;
  /** Every exchange, refused or not, spends from its client address's bucket. */
  readonly rateLimiter: RateLimiter;
  readonly clientAddress: ClientAddressOf;
  readonly readiness: () => EnvironmentReadiness;
}

/**
 * `POST /api/pair`: from any bound address, since that is what pairing is
 * for; the Host check before it still applies. A client of another protocol
 * version is refused before its code is looked at, so the code stays good for
 * a client that speaks this one.
 */
export const pairRoute = (options: PairRouteOptions): RouteHandler =>
  exchangeRoute<PairRequest, PairError>({
    body: PairRequest,
    what: "a pairing exchange",
    rateLimiter: options.rateLimiter,
    clientAddress: options.clientAddress,
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
      const outcome = options.atomically((tx) => options.pairings.exchange(tx, body.code, { kind: body.kind, label: body.label }));
      return outcome.ok ? outcome : { ok: false, refusal: REFUSALS[outcome.refusal] };
    },
  });
