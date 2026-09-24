import type { IncomingMessage, ServerResponse } from "node:http";
import {
  invalidParams,
  type ClientSessionCredential,
  type EnvironmentReadiness,
  type IssueInput,
  type WireError,
} from "@agent-harness/contracts";
import { BodyTooLargeError, readBody, sendJson, type RouteHandler } from "../serve/http.js";
import type { RateLimiter } from "./rate-limit.js";

/** The most an exchange's body may be; a label is at most 200 characters. */
export const MAX_EXCHANGE_BYTES = 16 * 1024;

/** An exchange's refusal: its HTTP status and the typed error the body carries. */
export interface Refusal {
  readonly status: number;
  readonly error: WireError;
  readonly headers?: Record<string, string>;
}

/** What an exchange's own handler answers: a client session, or why not. */
export type ExchangeOutcome = { readonly ok: true; readonly credential: ClientSessionCredential } | { readonly ok: false; readonly refusal: Refusal };

/** A schema the body is read through. */
interface BodySchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: readonly IssueInput[] } };
}

export interface ExchangeRouteOptions<T> {
  /** What the body must be, and how to name it in a refusal. */
  readonly body: BodySchema<T>;
  readonly what: string;
  /** Every exchange past `admit`, refused or not, spends from its remote address's bucket. */
  readonly rateLimiter: RateLimiter;
  /** The environment's readiness; the exchange answers `unavailable` unless it is `ready`. */
  readonly readiness: () => EnvironmentReadiness;
  /** A check before anything else, the rate limit included: the bootstrap exchange's loopback gate. */
  readonly admit?: (request: IncomingMessage) => Refusal | undefined;
  /** The exchange itself, synchronous so no two exchanges interleave. */
  readonly exchange: (body: T) => ExchangeOutcome;
}

const answer = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void =>
  sendJson(response, status, body, { "cache-control": "no-store", ...headers });

/**
 * An unauthenticated exchange route (`/api/bootstrap`, `/api/pair`): the
 * admission check, the rate limit, the startup gate, the body, then the
 * exchange. It answers only with a client session or a typed error, a
 * failure of the environment's own included.
 */
export const exchangeRoute =
  <T>(options: ExchangeRouteOptions<T>): RouteHandler =>
  async (request, response) => {
    try {
      const refused = options.admit?.(request);
      if (refused) return answer(response, refused.status, refused.error, refused.headers);

      const taken = options.rateLimiter.take(request.socket.remoteAddress ?? "");
      if (!taken.ok) {
        const seconds = Math.ceil(taken.retryAfterMs / 1000);
        return answer(
          response,
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
        return answer(response, 503, {
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
        return answer(response, 413, invalidParams([{ code: "too_big", path: [], message: error.message }], error.message));
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return answer(response, 400, invalidParams([{ code: "custom", path: [], message: "The body is not JSON." }], "The body is not JSON."));
      }
      const parsed = options.body.safeParse(json);
      if (!parsed.success) return answer(response, 400, invalidParams(parsed.error.issues, `The body is not ${options.what}.`));

      const outcome = options.exchange(parsed.data);
      if (!outcome.ok) return answer(response, outcome.refusal.status, outcome.refusal.error, outcome.refusal.headers);
      answer(response, 200, outcome.credential);
    } catch (error) {
      console.error(`The ${options.what} failed:`, error);
      if (response.headersSent) return void response.destroy();
      answer(response, 500, { code: "internal", message: "The environment failed.", data: {} });
    }
  };
