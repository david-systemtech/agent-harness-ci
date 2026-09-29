import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { KeyManagerTokenInformation } from "@agent-harness/contracts";
import type { ConnectionProvider, ProviderFailure, SignInTarget } from "./provider.js";

/**
 * The OpenBao provider (key-managers spec, "Providers": OpenBao and Vault
 * over the HTTP API, the same paths on both). AppRole logs in at
 * `auth/<mount>/login` with its role id and secret id, userpass at
 * `auth/<mount>/login/<username>` with its password, and a token is its own
 * login; a login's token is looked up at `auth/token/lookup-self` and
 * revoked at `auth/token/revoke-self`, each with the token itself. A 503 is
 * read against `sys/seal-status`, so a sealed OpenBao is told apart from one
 * that cannot answer. Every request verifies the certificate of an `https`
 * address, against the pinned CA when there is one and the system's trusted
 * CAs otherwise, whatever the process's environment says: TLS verification
 * is never turned off.
 */

/** How long one call may take (ADR 0031's budget), past which OpenBao counts as unreachable. */
const OPENBAO_CALL_TIMEOUT_MS = 10_000;

/** The most of an answer read: OpenBao's are small. */
const MAX_ANSWER_BYTES = 1_048_576;

/** The error codes of a certificate that does not verify, as Node's TLS names them. */
const CERTIFICATE_ERRORS = new Set([
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
  "CERT_SIGNATURE_FAILURE",
  "CERT_NOT_YET_VALID",
  "CERT_HAS_EXPIRED",
  "ERROR_IN_CERT_NOT_BEFORE_FIELD",
  "ERROR_IN_CERT_NOT_AFTER_FIELD",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_CHAIN_TOO_LONG",
  "CERT_REVOKED",
  "INVALID_CA",
  "PATH_LENGTH_EXCEEDED",
  "INVALID_PURPOSE",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "HOSTNAME_MISMATCH",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** What a call came back with: OpenBao's status and its JSON answer, or why there was none. */
type Reply = { readonly outcome: "answered"; readonly status: number; readonly body: unknown } | ProviderFailure;

const unreachable = (target: SignInTarget, reason: string): ProviderFailure => ({ outcome: "unreachable", message: `OpenBao at ${target.address} could not be reached: ${reason}.` });

/** What a request that failed before an answer comes to: a certificate that does not verify, or no answer at all. */
const failureOf = (target: SignInTarget, error: NodeJS.ErrnoException): ProviderFailure => {
  const code = error.code ?? "";
  if (CERTIFICATE_ERRORS.has(code)) {
    const message =
      target.ca === null
        ? `The certificate of ${target.address} does not verify against the system's trusted CAs (${code}): pin its CA in Set up, Key manager.`
        : `The certificate of ${target.address} does not verify against the pinned CA (${code}).`;
    return { outcome: "certificate-rejected", message };
  }
  return unreachable(target, error.message.replace(/\s+/g, " ").trim() || code || "no answer");
};

/** A JSON answer, or null for one that is not JSON. */
const parse = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

/** Reads an answer's body, up to the limit. */
const readBody = (response: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_ANSWER_BYTES) response.destroy(new Error("the answer is too long"));
      else chunks.push(chunk);
    });
    response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    response.on("error", reject);
  });

/**
 * One call to OpenBao's API under `/v1/`: `X-Vault-Token` carries the token
 * when there is one, and a JSON body the request's fields. The certificate is
 * verified against the pinned CA, or the system's with none, always.
 */
const call = (target: SignInTarget, method: "GET" | "POST", path: string, options: { readonly token?: string; readonly body?: unknown } = {}): Promise<Reply> =>
  new Promise((resolve) => {
    const url = new URL(`/v1/${path}`, target.address);
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.token !== undefined) headers["x-vault-token"] = options.token;
    if (body !== undefined) headers["content-type"] = "application/json";
    const requestOptions: RequestOptions = {
      method,
      headers,
      timeout: OPENBAO_CALL_TIMEOUT_MS,
      // Never off, whatever NODE_TLS_REJECT_UNAUTHORIZED says: the pinned CA is the only trust added.
      rejectUnauthorized: true,
      ...(target.ca !== null && { ca: target.ca }),
    };
    const answered = (response: IncomingMessage): void => {
      readBody(response).then(
        (text) => resolve({ outcome: "answered", status: response.statusCode ?? 0, body: parse(text) }),
        (error: unknown) => resolve(failureOf(target, error as NodeJS.ErrnoException)),
      );
    };
    const sent = url.protocol === "https:" ? httpsRequest(url, requestOptions, answered) : httpRequest(url, requestOptions, answered);
    sent.on("timeout", () => sent.destroy(Object.assign(new Error(`no answer within ${OPENBAO_CALL_TIMEOUT_MS / 1000} seconds`), { code: "ETIMEDOUT" })));
    sent.on("error", (error: NodeJS.ErrnoException) => resolve(failureOf(target, error)));
    sent.end(body);
  });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The first error line OpenBao gave, on one line; empty for none. */
const firstError = (body: unknown): string => {
  const errors = isRecord(body) ? body["errors"] : undefined;
  const [first] = Array.isArray(errors) ? errors.filter((error): error is string => typeof error === "string" && error.trim() !== "") : [];
  return first === undefined ? "" : first.replace(/\s+/g, " ").trim();
};

/**
 * What an answer other than a success comes to: a 503 read against the
 * seal status, sealed or not; any other server error or a rate limit is
 * unreachable; the rest is the credential refused.
 */
const refusal = async (target: SignInTarget, status: number, body: unknown): Promise<ProviderFailure> => {
  const said = firstError(body);
  const detail = `HTTP ${status}${said === "" ? "" : `: ${said}`}`;
  if (status === 503) {
    const seal = await call(target, "GET", "sys/seal-status");
    if (seal.outcome === "answered" && isRecord(seal.body) && seal.body["sealed"] === true) {
      return { outcome: "sealed", message: `OpenBao at ${target.address} is sealed: unseal it to sign in.` };
    }
  }
  if (status >= 500 || status === 429) return { outcome: "unreachable", message: `OpenBao at ${target.address} could not answer (${detail}).` };
  return { outcome: "credential-rejected", message: `OpenBao at ${target.address} refused the credential (${detail}).` };
};

/** A mount path as it goes into a URL: each of its names encoded. */
const encodedPath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

/** An expiry as the record keeps it, in UTC; null for none or one that is no time. */
const expiryOf = (value: unknown): string | null => {
  if (typeof value !== "string" || value === "") return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
};

/** What `lookup-self` answered, read: null for an answer that is not a token's. */
const lookedUp = (body: unknown): { readonly information: KeyManagerTokenInformation; readonly root: boolean } | null => {
  const data = isRecord(body) ? body["data"] : undefined;
  if (!isRecord(data)) return null;
  const policies = Array.isArray(data["policies"]) ? data["policies"].filter((policy): policy is string => typeof policy === "string" && policy !== "") : [];
  const ttl = data["ttl"];
  return {
    root: policies.includes("root"),
    information: {
      displayName: typeof data["display_name"] === "string" ? data["display_name"] : "",
      policies: policies.filter((policy) => policy !== "root" && !/[,\p{Cc}]/u.test(policy)),
      ttlSeconds: typeof ttl === "number" && Number.isInteger(ttl) && ttl > 0 ? ttl : 0,
      renewable: data["renewable"] === true,
      expiresAt: expiryOf(data["expire_time"]),
    },
  };
};

export const openBaoProvider: ConnectionProvider = {
  async logIn(target, credential) {
    if (credential.method === "token") return { outcome: "logged-in", token: credential.token, minted: false };
    const reply =
      credential.method === "approle"
        ? await call(target, "POST", `auth/${encodedPath(target.mount)}/login`, { body: { role_id: credential.roleId, secret_id: credential.secretId } })
        : await call(target, "POST", `auth/${encodedPath(target.mount)}/login/${encodeURIComponent(target.username ?? "")}`, { body: { password: credential.password } });
    if (reply.outcome !== "answered") return reply;
    if (reply.status < 200 || reply.status > 299) return refusal(target, reply.status, reply.body);
    const auth = isRecord(reply.body) ? reply.body["auth"] : undefined;
    const token = isRecord(auth) ? auth["client_token"] : undefined;
    if (typeof token !== "string" || token === "") return unreachable(target, "its login answered no token");
    return { outcome: "logged-in", token, minted: true };
  },

  async lookUp(target, token) {
    const reply = await call(target, "GET", "auth/token/lookup-self", { token });
    if (reply.outcome !== "answered") return reply;
    if (reply.status !== 200) return refusal(target, reply.status, reply.body);
    const found = lookedUp(reply.body);
    return found === null ? unreachable(target, "its token lookup answered no token") : { outcome: "found", ...found };
  },

  async revoke(target, token) {
    const reply = await call(target, "POST", "auth/token/revoke-self", { token });
    if (reply.outcome !== "answered") return reply;
    return reply.status >= 200 && reply.status <= 299 ? { outcome: "revoked" } : refusal(target, reply.status, reply.body);
  },
};
