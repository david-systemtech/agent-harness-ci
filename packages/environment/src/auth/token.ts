import { createHmac, timingSafeEqual } from "node:crypto";
import { ClientSessionId, EnvironmentId } from "@agent-harness/contracts";
import { z } from "zod";

/**
 * A client session token: `v1.<claims>.<signature>`, the version first, the
 * claims base64url JSON and the signature base64url HMAC-SHA256, under the
 * environment's signing key, of `v1.<claims>`. The claims name the client
 * session and the environment that issued it, and when; everything else
 * (kind, scopes, ceiling, the local flag, expiry) lives in the client
 * sessions table, which the environment mirrors in memory, so a ceiling
 * raised or an expiry moved applies at the next auth. Verifying reads no
 * database. Clients treat the token as opaque: they store it and send it in
 * `auth`.
 */
const VERSION = "v1";

const TokenClaims = z.object({
  /** The client session's id. */
  sid: ClientSessionId,
  /** The environment that issued it, so a token is never taken as another environment's. */
  env: EnvironmentId,
  /** Issued at, in milliseconds since the epoch. */
  iat: z.int().nonnegative(),
});
export type TokenClaims = z.infer<typeof TokenClaims>;

const sign = (key: Buffer, signed: string): Buffer => createHmac("sha256", key).update(signed).digest();

export const signToken = (key: Buffer, claims: TokenClaims): string => {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${VERSION}.${payload}.${sign(key, `${VERSION}.${payload}`).toString("base64url")}`;
};

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** The claims of `token` when it is well formed and signed under `key`; undefined otherwise. */
export const readToken = (key: Buffer, token: string): TokenClaims | undefined => {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const [version, payload, signature] = parts as [string, string, string];
  if (version !== VERSION || !BASE64URL.test(payload) || !BASE64URL.test(signature)) return undefined;
  const expected = sign(key, `${version}.${payload}`);
  const given = Buffer.from(signature, "base64url");
  // Only the one canonical spelling of a signature is taken, so a token has exactly one form.
  if (given.length !== expected.length || given.toString("base64url") !== signature) return undefined;
  if (!timingSafeEqual(given, expected)) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  const claims = TokenClaims.safeParse(json);
  return claims.success ? claims.data : undefined;
};
