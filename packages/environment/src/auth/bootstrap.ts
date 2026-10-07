import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  BOOTSTRAP_GRANT_FILE,
  BootstrapRequest,
  type BootstrapError,
  type BootstrapGrant,
  type EnvironmentReadiness,
} from "@agent-harness/contracts";
import type { Tx } from "../event-log/event-log.js";
import type { ClientAddressOf } from "../serve/client-address.js";
import { writeFileAtomic } from "../serve/files.js";
import type { Address, RouteHandler } from "../serve/http.js";
import type { ClientSessions } from "./client-sessions.js";
import { exchangeRoute } from "./exchange.js";
import type { RateLimiter } from "./rate-limit.js";

const SECRET_BYTES = 32;

/**
 * Whether a socket's remote address is loopback: 127.0.0.0/8, `::1`, or
 * 127.0.0.0/8 mapped into IPv6. The exchange judges by this, not by the Host
 * header, which the caller writes.
 */
export const isLoopbackAddress = (address: string | undefined): boolean => {
  if (address === undefined) return false;
  const v4 = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return address === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
};

const digest = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest();

/** Compares in constant time over digests, so neither the length nor a prefix of the secret leaks. */
const sameSecret = (given: string, expected: string): boolean => timingSafeEqual(digest(given), digest(expected));

export interface BootstrapGrantOptions {
  readonly dataDir: string;
  readonly clientSessions: Pick<ClientSessions, "issueLocal">;
  /** Opens the transaction the exchange's client session and access-log events are written in. */
  readonly atomically: <T>(work: (tx: Tx) => T) => T;
  /** Every exchange past the loopback gate, refused or not, spends from its client address's bucket. */
  readonly rateLimiter: RateLimiter;
  /** Where an exchange came from; one a proxy forwarded from the tailnet is not loopback. */
  readonly clientAddress: ClientAddressOf;
  /** The environment's readiness; the exchange answers `unavailable` unless it is `ready`. */
  readonly readiness: () => EnvironmentReadiness;
}

/** The bootstrap grant: its file, rotated on every exchange, and the exchange that consumes it. */
export interface BootstrapGrantHandle {
  /** Writes the grant file with a fresh secret and `address`: on start, once the listener is bound. */
  issue(address: Address): void;
  /** `POST /api/bootstrap`. */
  readonly exchange: RouteHandler;
  /** Removes the grant file, so none is left naming an environment that has stopped. */
  remove(): void;
}

export const createBootstrapGrant = (options: BootstrapGrantOptions): BootstrapGrantHandle => {
  const path = join(options.dataDir, BOOTSTRAP_GRANT_FILE);
  let current: BootstrapGrant | undefined;

  /** The file first, then memory: a grant that could not be written leaves the old secret valid. */
  const issue = (address: Address): void => {
    const grant: BootstrapGrant = {
      secret: randomBytes(SECRET_BYTES).toString("base64url"),
      address: { host: address.host, port: address.port },
    };
    writeFileAtomic(path, `${JSON.stringify(grant, null, 2)}\n`, 0o600);
    current = grant;
  };

  const exchange: RouteHandler = exchangeRoute<BootstrapRequest, BootstrapError>({
    body: BootstrapRequest,
    what: "a bootstrap exchange",
    rateLimiter: options.rateLimiter,
    clientAddress: options.clientAddress,
    readiness: options.readiness,
    admit: (client) =>
      isLoopbackAddress(client.address)
        ? undefined
        : { status: 403, error: { code: "unauthorized", message: "The bootstrap grant is exchanged over loopback only.", data: {} } },
    // Nothing here awaits, so one secret is exchanged once however many requests race.
    exchange: (body) => {
      if (!current || !sameSecret(body.secret, current.secret)) {
        return {
          ok: false,
          refusal: {
            status: 401,
            error: { code: "unauthorized", message: "The secret is not the grant's current one: read the grant file again.", data: {} },
          },
        };
      }
      issue(current.address);
      return { ok: true, credential: options.atomically((tx) => options.clientSessions.issueLocal(tx, body.kind, body.label)) };
    },
  });

  return {
    issue,
    exchange,
    remove: () => {
      current = undefined;
      rmSync(path, { force: true });
    },
  };
};
