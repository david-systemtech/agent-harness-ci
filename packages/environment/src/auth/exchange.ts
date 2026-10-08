import type { ServerResponse } from "node:http";
import {
  invalidParams,
  type ClientSessionCredential,
  type EnvironmentReadiness,
  type InternalError,
  type InvalidParamsError,
  type IssueInput,
  type RateLimitedError,
  type UnavailableError,
} from "@agent-harness/contracts";
import { BodyTooLargeError, readBody, sendJson, type RouteHandler } from "../serve/http.js";
import type { ClientAddress, ClientAddressOf } from "../serve/client-address.js";
import type { RateLimiter } from "./rate-limit.js";

/** The most an exchange's body may be; a label is at most 200 characters. */
export const MAX_EXCHANGE_BYTES = 16 * 1024;

/** What an exchange of a secret or a code comes to: a client session, or why not. */
export type Outcome<R> = { readonly ok: true; readonly credential: ClientSessionCredential } | { readonly ok: false; readonly refusal: R };

/** An exchange's refusal: its HTTP status and the route's own typed error. */
export interface Refusal<E> {
  readonly status: number;
  readonly error: E;
  readonly headers?: Record<string, string>;
}

/** The refusals every exchange route makes itself, which each route's error union must hold. */
type RouteError = RateLimitedError | UnavailableError | InvalidParamsError | InternalError;

/** A schema the body is read through. */
interface BodySchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: readonly IssueInput[] } };
}

export interface ExchangeRouteOptions<T, E> {
  /** What the body must be, and how to name it in a refusal. */
  readonly body: BodySchema<T>;
  readonly what: string;
  /** Every exchange past `admit`, refused or not, spends from its client address's bucket. */
  readonly rateLimiter: RateLimiter;
  /** Where an exchange came from: the TCP peer, or the client a proxy in front of the web origin forwarded. */
  readonly clientAddress: ClientAddressOf;
  /** The environment's readiness; the exchange answers `unavailable` unless it is `ready`. */
  readonly readiness: () => EnvironmentReadiness;
  /** A check before anything else, the rate limit included: the bootstrap exchange's loopback gate. */
  readonly admit?: (client: ClientAddress) => Refusal<E> | undefined;
  /** The exchange itself, synchronous so no two exchanges interleave. */
  readonly exchange: (body: T) => Outcome<Refusal<E>>;
}

const answer = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void =>
  sendJson(response, status, body, { "cache-control": "no-store", ...headers });

/**
 * An unauthenticated exchange route (`/api/bootstrap`, `/api/pair`): the
 * admission check, the rate limit, the startup gate, the body, then the
 * exchange. It answers only with a client session or an error of `E`, the
 * route's own union (`BootstrapError`, `PairError`), which must hold the
 * refusals made here: a union without them does not compile.
 */
export const exchangeRoute =
  <T, E>(options: ExchangeRouteOptions<T, E> & (RouteError extends E ? unknown : never)): RouteHandler =>
  async (request, response) => {
    const refuse = (status: number, error: E | RouteError, headers?: Record<string, string>) => answer(response, status, error, headers);
    try {
      const client = options.clientAddress(request);
      const refused = options.admit?.(client);
      if (refused) return refuse(refused.status, refused.error, refused.headers);

      const taken = options.rateLimiter.take(client.address ?? "");
      if (!taken.ok) {
        const seconds = Math.ceil(taken.retryAfterMs / 1000);
        return refuse(
          429,
          {
            code: "rate_limited",
            message: `Too many exchanges from this address; try again in ${seconds} seconds.`,
            data: { retryAfterMs: taken.retryAfterMs },
          },
          { "retry-after": String(seconds) },
        );
      }
      const readiness = options.readiness();
      if (readiness !== "ready") {
        return refuse(503, { code: "unavailable", message: `The environment is ${readiness}; try again once it is ready.`, data: { readiness } });
      }
      let text: string;
      try {
        text = await readBody(request, MAX_EXCHANGE_BYTES);
      } catch (error) {
        if (!(error instanceof BodyTooLargeError)) throw error;
        return refuse(413, invalidParams([{ code: "too_big", path: [], message: error.message }], error.message));
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return refuse(400, invalidParams([{ code: "custom", path: [], message: "The body is not JSON." }], "The body is not JSON."));
      }
      const parsed = options.body.safeParse(json);
      if (!parsed.success) return refuse(400, invalidParams(parsed.error.issues, `The body is not ${options.what}.`));

      const outcome = options.exchange(parsed.data);
      if (!outcome.ok) return refuse(outcome.refusal.status, outcome.refusal.error, outcome.refusal.headers);
      answer(response, 200, outcome.credential);
    } catch (error) {
      console.error(`The ${options.what} failed:`, error);
      if (response.headersSent) return void response.destroy();
      refuse(500, { code: "internal", message: "The environment failed.", data: {} });
    }
  };
