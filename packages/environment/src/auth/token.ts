import { createHmac, timingSafeEqual } from "node:crypto";
import { Ceiling, ClientKind, ClientSessionId, EnvironmentId, ScopeSet, type Scope } from "@agent-harness/contracts";

/**
 * A client session token: `v1.<claims>.<signature>`, the claims base64url
 * JSON and the signature base64url HMAC-SHA256, under the environment's
 * signing key, of `v1.<claims>`. It carries everything `hello` and the scope
 * check need, so a connection is authenticated with no database read; the
 * environment still refuses a session it does not know or has revoked, from
 * memory. Clients treat it as opaque: they store it and send it in `auth`.
 */
const VERSION = "v1";

export interface TokenClaims {
  /** The client session's id. */
  readonly sid: string;
  /** The environment that issued it, so a token is never taken as another environment's. */
  readonly env: string;
  readonly kind: ClientKind;
  readonly scopes: readonly Scope[];
  readonly ceiling: Ceiling;
  /** Issued through the bootstrap grant rather than by pairing. */
  readonly local: boolean;
  /** Issued at, in milliseconds since the epoch. */
  readonly iat: number;
  /** Expires at, in milliseconds since the epoch. */
  readonly exp: number;
}

const isTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** The claims in `value`, with only the claims' own fields; undefined when it is not claims. */
const claimsOf = (value: unknown): TokenClaims | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { sid, env, kind, scopes, ceiling, local, iat, exp } = value as Record<string, unknown>;
  const parsedKind = ClientKind.safeParse(kind);
  const parsedScopes = ScopeSet.safeParse(scopes);
  const parsedCeiling = Ceiling.safeParse(ceiling);
  if (
    !ClientSessionId.safeParse(sid).success ||
    !EnvironmentId.safeParse(env).success ||
    !parsedKind.success ||
    !parsedScopes.success ||
    !parsedCeiling.success ||
    typeof local !== "boolean" ||
    !isTime(iat) ||
    !isTime(exp)
  ) {
    return undefined;
  }
  return {
    sid: sid as string,
    env: env as string,
    kind: parsedKind.data,
    scopes: parsedScopes.data,
    ceiling: parsedCeiling.data,
    local,
    iat,
    exp,
  };
};

const sign = (key: Buffer, signed: string): Buffer => createHmac("sha256", key).update(signed).digest();

export const signToken = (key: Buffer, claims: TokenClaims): string => {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${VERSION}.${payload}.${sign(key, `${VERSION}.${payload}`).toString("base64url")}`;
};

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** The claims of `token` when it is well formed and signed under `key`; undefined otherwise. Expiry is the caller's. */
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
  return claimsOf(json);
};
