import type { ServerResponse } from "node:http";
import {
  GitCredentialRequest,
  forgeGitUsername,
  invalidParams,
  normaliseRemote,
  type ForgeAccountRecord,
  type GitCredentialAnswer,
  type GitCredentialError,
} from "@agent-harness/contracts";
import { isLoopbackAddress } from "../auth/bootstrap.js";
import { EXCHANGE_RATE, createRateLimiter } from "../auth/rate-limit.js";
import type { ClientAddressOf } from "../serve/client-address.js";
import type { Clock } from "../serve/clock.js";
import { BodyTooLargeError, readBody, sendJson, type RouteHandler } from "../serve/http.js";
import type { BankCredentials } from "../banks/credentials.js";
import type { ForgeService } from "./forge-service.js";
import { servedOrigins } from "./git-helper.js";

/**
 * The credential route, `POST /api/internal/git-credential` (forge spec,
 * "The helper and the credential route"; ADR 0020): what the credential
 * helper asks for git. It answers loopback sockets only, behind the Host
 * check every route has; the run-scoped secret is its bearer credential,
 * compared in constant time, and no client session or scope is involved. It
 * serves the canonical origins and verified aliases of the forge accounts
 * the secret names and the environment still holds, reading the credential
 * on every request, so a replaced token is served at once and a removed
 * forge account is not; one whose credential answers as another user is
 * given nothing until it is replaced. `erase`, git's word that it was refused the
 * credential, is reported and verified again, and nothing is forgotten.
 * Everything else is `unauthorized`.
 */

/** The most a request's body may be: git's attributes are a few short lines. */
const MAX_REQUEST_BYTES = 4 * 1024;

/**
 * The rate a secret the environment holds may ask at (a chosen default): a
 * burst of 300 a minute, so an agent's git in a loop is never refused, and a
 * runaway one is bounded. Requests with no secret it holds share one bucket at
 * the exchanges' rate.
 */
export const CREDENTIAL_ROUTE_RATE = { capacity: 300, windowMs: 60_000 } as const;

/** What the route reads of the ForgeService. */
export type CredentialRouteForge = Pick<ForgeService, "secrets" | "list" | "resolveCredential" | "gitRejected">;

export interface CredentialRouteOptions {
  readonly forge: CredentialRouteForge;
  readonly clock: Clock;
  /** Where a request came from: one the web origin's proxy forwarded from the tailnet is not loopback (#1809). */
  readonly clientAddress: ClientAddressOf;
  readonly banks?: Pick<BankCredentials, "find" | "resolveCredential">;
}

const answer = (response: ServerResponse, status: number, body: GitCredentialAnswer | GitCredentialError, headers: Record<string, string> = {}): void =>
  sendJson(response, status, body, { "cache-control": "no-store", ...headers });

const unauthorized = (message: string): GitCredentialError => ({ code: "unauthorized", message, data: {} });

/** The secret an `Authorization: Bearer` header carries; null for none, or another scheme. */
const bearer = (header: string | undefined): string | null => {
  const match = /^Bearer ([^\s]+)$/i.exec(header?.trim() ?? "");
  return match?.[1] ?? null;
};

export const createCredentialRoute = ({ forge, clock, clientAddress, banks }: CredentialRouteOptions): RouteHandler => {
  const bySecret = createRateLimiter({ clock, ...CREDENTIAL_ROUTE_RATE });
  const unmatched = createRateLimiter({ clock, ...EXCHANGE_RATE });

  /** The forge account in `forgeAccountIds` the environment holds and serves on `origin`; null for none. */
  const servedOn = (forgeAccountIds: readonly string[], origin: string): ForgeAccountRecord | null =>
    forge.list().find((account) => forgeAccountIds.includes(account.id) && servedOrigins(account).includes(origin)) ?? null;

  return async (request, response) => {
    if (!isLoopbackAddress(clientAddress(request).address)) return answer(response, 403, unauthorized("The credential route answers over loopback only."));

    const given = bearer(request.headers.authorization);
    const bankGrant = given === null ? null : banks?.find(given) ?? null;
    const held = given === null ? null : forge.secrets.find(given) ?? bankGrant;
    const taken = held === null ? unmatched.take("unmatched") : bySecret.take(held.id);
    if (!taken.ok) {
      const seconds = Math.ceil(taken.retryAfterMs / 1000);
      return answer(
        response,
        429,
        { code: "rate_limited", message: `Too many credential requests; try again in ${seconds} seconds.`, data: { retryAfterMs: taken.retryAfterMs } },
        { "retry-after": String(seconds) },
      );
    }
    if (held === null) return answer(response, 401, unauthorized("The run-scoped secret is missing, or not one this environment holds: it has ended, or the environment restarted."));

    let text: string;
    try {
      text = await readBody(request, MAX_REQUEST_BYTES);
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
    const parsed = GitCredentialRequest.safeParse(json);
    if (!parsed.success) return answer(response, 400, invalidParams(parsed.error.issues, "The body is not a credential request."));
    const { protocol, host } = parsed.data;

    const origin = normaliseRemote(`${protocol}://${host}`)?.origin;
    if (bankGrant !== null) {
      if (origin !== bankGrant.origin) return answer(response, 401, unauthorized("This bank operation does not serve that origin."));
      if (parsed.data.action === "erase") {
        response.writeHead(204, { "cache-control": "no-store" });
        return void response.end();
      }
      try {
        const credential = await banks!.resolveCredential(bankGrant);
        if (credential === null) return answer(response, 503, { code: "credential_unavailable", message: "The bank credential is unavailable; check its source in Set up.", data: { origin } });
        return answer(response, 200, { username: credential.username, password: credential.token });
      } catch {
        return answer(response, 503, { code: "credential_unavailable", message: "The bank credential could not be read; check its source in Set up.", data: { origin } });
      }
    }
    const account = origin === undefined ? null : servedOn(held.forgeAccountIds, origin);
    if (origin === undefined || account === null) {
      return answer(response, 401, unauthorized(`No forge account this secret names serves ${protocol}://${host}.`));
    }

    if (parsed.data.action === "erase") {
      forge.gitRejected(account.id, origin);
      response.writeHead(204, { "cache-control": "no-store" });
      return void response.end();
    }

    // A credential answering as another user is unused until it is replaced (forge spec, "Problem").
    if (account.problem?.kind === "identity-changed") {
      return answer(response, 503, { code: "credential_unavailable", message: account.problem.message, data: { origin } });
    }
    const credential = await forge.resolveCredential(account.id, "git");
    if (credential === null) return answer(response, 401, unauthorized(`No forge account this secret names serves ${origin}.`));
    if (credential.outcome === "unavailable") {
      return answer(response, 503, { code: "credential_unavailable", message: credential.problem.message, data: { origin } });
    }
    try {
      const username = forgeGitUsername(account.kind, account.identity?.login ?? "");
      if (username === "") {
        const message = `The forge account's login on ${origin} is not known yet, so git has no username for it: check it again in Set up, Forges.`;
        return answer(response, 503, { code: "credential_unavailable", message, data: { origin } });
      }
      answer(response, 200, { username, password: credential.token });
    } finally {
      credential.release();
    }
  };
};
