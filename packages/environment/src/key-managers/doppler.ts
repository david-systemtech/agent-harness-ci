import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { z } from "zod";
import type { DopplerReference, KeyManagerTokenInformation } from "@agent-harness/contracts";
import { sameValue } from "./same-value.js";
import { KEY_MANAGER_BUDGET_MS, type ConnectionProvider, type LoginFailure, type ProviderFailure, type SignInTarget } from "./provider.js";

/** Doppler REST API. Identity and a names-only list prove the kept token; no CLI or token cache is involved. */
const actor = z.object({ name: z.string(), type: z.string() });
const names = z.object({ names: z.array(z.string()) });
const values = z.object({ secrets: z.record(z.string(), z.object({ computed: z.string().nullable() })) });
const LIFE = { issuedAt: null, creationTtlSeconds: 0, periodSeconds: 0, explicitMaxTtlSeconds: 0 } as const;
const SECRET_PATH = "/v3/configs/config/secrets";

/** A browse uses mount as project and path as config; null omits each, leaving the token's scope in force. */
const scope = (project?: string | null, config?: string | null): Record<string, string> => ({ ...(project != null && { project }), ...(config != null && { config }) });
const referenceScope = (reference: DopplerReference) => scope(reference.project, reference.config);

export type DopplerFetch = (url: URL, options: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<Response>;

/** The default transport always verifies TLS, including when the host has disabled it globally. It follows no redirects. */
const secureFetch: DopplerFetch = (url, options) => new Promise((resolve, reject) => {
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
  const sent = transport(url, { method: options.method, headers: options.headers, signal: options.signal, rejectUnauthorized: true, timeout: KEY_MANAGER_BUDGET_MS }, (response) => {
    const chunks: Buffer[] = [];
    let length = 0;
    response.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > 2 * 1024 * 1024) response.destroy(new Error("Doppler's answer is too large."));
      else chunks.push(chunk);
    });
    response.on("end", () => resolve(new Response([204, 205, 304].includes(response.statusCode ?? 0) ? null : Buffer.concat(chunks).toString("utf8"), { status: response.statusCode ?? 503 })));
    response.on("error", reject);
  });
  sent.on("timeout", () => sent.destroy(new Error("Doppler did not answer within its budget.")));
  sent.on("error", reject);
  sent.end(options.body);
});

export const createDopplerProvider = (fetcher: DopplerFetch = secureFetch): ConnectionProvider => {
  const request = async (target: SignInTarget, token: string, path: string, query: Record<string, string>, signal?: AbortSignal, body?: unknown): Promise<{ outcome: "answered"; body: unknown } | ProviderFailure> => {
    const url = new URL(path, target.address);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    try {
      const response = await fetcher(url, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body !== undefined && { "Content-Type": "application/json" }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: signal ?? AbortSignal.timeout(KEY_MANAGER_BUDGET_MS),
      });
      if (!response.ok) {
        const outcome = (response.status === 401 || (response.status === 400 && path === "/v3/me")) ? "credential-rejected" : response.status === 403 ? "denied" : response.status === 404 ? "not-found" : response.status === 429 ? "rate-limited" : "unreachable";
        return { outcome, message: `Doppler at ${target.address} answered HTTP ${response.status}.` };
      }
      const responseBody: unknown = await response.json();
      if (z.object({ success: z.literal(false) }).safeParse(responseBody).success) return { outcome: "unreachable", message: `Doppler at ${target.address} did not accept the request.` };
      return { outcome: "answered", body: responseBody };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(code)) {
        return { outcome: "certificate-rejected", message: `The certificate of Doppler at ${target.address} does not verify against the system's trusted CAs.` };
      }
      return { outcome: "unreachable", message: `Doppler at ${target.address} could not be reached or answered no valid JSON.` };
    }
  };
  const malformed = (target: SignInTarget): LoginFailure => ({ outcome: "unreachable", message: `Doppler at ${target.address} answered an unexpected response.` });
  const loginFailure = (failure: ProviderFailure): LoginFailure => failure.outcome === "denied" || failure.outcome === "not-found" ? { ...failure, outcome: "credential-rejected" } : { outcome: failure.outcome, message: failure.message };
  const lookUp: ConnectionProvider["lookUp"] = async (target, token, signal) => {
    const identity = await request(target, token, "/v3/me", {}, signal);
    if (identity.outcome !== "answered") return loginFailure(identity);
    const parsed = actor.safeParse(identity.body);
    if (!parsed.success) return malformed(target);
    const proof = await request(target, token, `${SECRET_PATH}/names`, { include_dynamic_secrets: "false" }, signal);
    if (proof.outcome !== "answered") return loginFailure(proof);
    if (!names.safeParse(proof.body).success) return malformed(target);
    const information: KeyManagerTokenInformation = { displayName: `${parsed.data.name} (${parsed.data.type})`, policies: [], ttlSeconds: 0, renewable: false, expiresAt: null };
    return { outcome: "found", information, life: LIFE, root: false };
  };
  const read: ConnectionProvider["read"] = async (target, token, reference, signal) => {
    if (reference.provider !== "doppler") return { outcome: "not-found", message: "This is not a Doppler reference." };
    const answer = await request(target, token, SECRET_PATH, { ...referenceScope(reference), secrets: reference.name, include_dynamic_secrets: "false" }, signal);
    if (answer.outcome !== "answered") return answer;
    const parsed = values.safeParse(answer.body);
    if (!parsed.success) return malformed(target);
    const value = parsed.data.secrets[reference.name]?.computed;
    return value == null ? { outcome: "not-found", message: `Doppler holds no secret named ${reference.name}.` } : { outcome: "read", value };
  };
  return {
    async logIn(_target, credential) {
      return credential.method === "token" ? { outcome: "logged-in", token: credential.token, minted: false } : { outcome: "credential-rejected", message: "Doppler signs in with a token." };
    },
    lookUp,
    async verify(target, token, options) {
      const found = await lookUp(target, token, options.signal);
      return found.outcome === "found" ? { outcome: "verified", information: found.information, root: false, canMint: true, policies: [] } : found;
    },
    async readPolicy() { return { outcome: "not-found", message: "Doppler has no OpenBao policies." }; },
    async revoke() { return { outcome: "revoked" }; },
    async mint(_target, token) { return { outcome: "minted", token }; },
    async renew() { return { outcome: "credential-rejected", message: "A Doppler token is not renewable." }; },
    read,
    async list(target, token, location, signal) {
      const answer = await request(target, token, `${SECRET_PATH}/names`, { ...scope(location.mount, location.path), include_dynamic_secrets: "false" }, signal);
      if (answer.outcome !== "answered") return answer;
      const parsed = names.safeParse(answer.body);
      return parsed.success ? { outcome: "listed", names: parsed.data.names } : malformed(target);
    },
    async canWrite(target, token, location, signal) {
      // The update endpoint's OpenAPI secrets object has no required keys or minimum size.
      // An empty patch checks write access without changing values; its answer is a secrets map.
      const answer = await request(target, token, SECRET_PATH, scope(location.mount || null, location.path || null), signal, { secrets: {} });
      if (answer.outcome === "denied") return { outcome: "checked", writable: false };
      if (answer.outcome !== "answered") return answer;
      return values.safeParse(answer.body).success ? { outcome: "checked", writable: true } : malformed(target);
    },
    async write(target, token, requestToWrite, signal) {
      const { reference, value, overwrite } = requestToWrite;
      if (reference.provider !== "doppler") return { outcome: "not-found", message: "This is not a Doppler reference." };
      const existing = await read(target, token, reference, signal);
      if (existing.outcome === "read") {
        if (sameValue(existing.value, value)) return { outcome: "written" };
        if (!overwrite) return { outcome: "exists" };
      } else if (existing.outcome !== "not-found") return existing;
      const answer = await request(target, token, SECRET_PATH, referenceScope(reference), signal, { secrets: { [reference.name]: value } });
      if (answer.outcome !== "answered") return answer;
      return values.safeParse(answer.body).success ? { outcome: "written" } : malformed(target);
    },
  };
};
