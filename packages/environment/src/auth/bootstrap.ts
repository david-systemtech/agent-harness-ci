import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  BOOTSTRAP_GRANT_FILE,
  BootstrapRequest,
  invalidParams,
  type BootstrapError,
  type BootstrapGrant,
  type ClientSessionCredential,
  type EnvironmentReadiness,
} from "@agent-harness/contracts";
import { writeFileAtomic } from "../serve/files.js";
import { BodyTooLargeError, readBody, sendJson, type Address, type RouteHandler } from "../serve/http.js";
import type { ClientSessions } from "./client-sessions.js";

/** The most an exchange's body may be; a label is at most 200 characters. */
export const MAX_EXCHANGE_BYTES = 16 * 1024;

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

const refuse = (response: Parameters<RouteHandler>[1], status: number, error: BootstrapError): void =>
  sendJson(response, status, error, { "cache-control": "no-store" });

export interface BootstrapGrantOptions {
  readonly dataDir: string;
  readonly sessions: ClientSessions;
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

  const exchange: RouteHandler = async (request, response) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      return refuse(response, 403, {
        code: "unauthorized",
        message: "The bootstrap grant is exchanged over loopback only.",
        data: {},
      });
    }
    const readiness = options.readiness();
    if (readiness !== "ready") {
      return refuse(response, 503, {
        code: "unavailable",
        message: `The environment is ${readiness}; try again once it is ready.`,
        data: { readiness },
      });
    }
    let text: string;
    try {
      text = await readBody(request, MAX_EXCHANGE_BYTES);
    } catch (error) {
      if (!(error instanceof BodyTooLargeError)) throw error;
      return refuse(response, 413, invalidParams([{ code: "too_big", path: [], message: error.message }], error.message));
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return refuse(response, 400, invalidParams([{ code: "custom", path: [], message: "The body is not JSON." }], "The body is not JSON."));
    }
    const parsed = BootstrapRequest.safeParse(json);
    if (!parsed.success) return refuse(response, 400, invalidParams(parsed.error.issues, "The body is not a bootstrap exchange."));

    // From here to the answer nothing awaits, so one secret is exchanged once however many requests race.
    if (!current || !sameSecret(parsed.data.secret, current.secret)) {
      return refuse(response, 401, {
        code: "unauthorized",
        message: "The secret is not the grant's current one: read the grant file again.",
        data: {},
      });
    }
    issue(current.address);
    const credential: ClientSessionCredential = options.sessions.issueLocal(parsed.data.kind, parsed.data.label);
    sendJson(response, 200, credential, { "cache-control": "no-store" });
  };

  return {
    issue,
    exchange,
    remove: () => {
      current = undefined;
      rmSync(path, { force: true });
    },
  };
};
