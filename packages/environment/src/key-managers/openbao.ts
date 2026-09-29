import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { KeyManagerLoginPolicy, KeyManagerTokenInformation } from "@agent-harness/contracts";
import { policyWrites } from "./policy-writes.js";
import type { ConnectionProvider, ListAnswer, LoginFailure, MintAnswer, ProviderFailure, RenewAnswer, SignInTarget, WriteAnswer, WriteCheckAnswer } from "./provider.js";
import { sameValue } from "./same-value.js";

/**
 * The OpenBao provider (key-managers spec, "Providers": OpenBao and Vault
 * over the HTTP API, the same paths on both). AppRole logs in at
 * `auth/<mount>/login` with its role id and secret id, userpass at
 * `auth/<mount>/login/<username>` with its password, and a token is its own
 * login; a login's token is looked up at `auth/token/lookup-self` and
 * revoked at `auth/token/revoke-self`, each with the token itself.
 *
 * A verification (#366) reads `sys/seal-status` first, so sealed is its own
 * finding; then the token's own lookup; then its capabilities on the
 * token-create path, or its token role's (`sys/capabilities-self`): it can
 * mint run tokens with `update` there, the one operation OpenBao's ACL
 * checks on those paths, which register no existence check; then each of
 * its policies' texts (`sys/policies/acl/<name>`), a policy it may not read
 * possibly writing.
 *
 * A reference is read (#370) from a KV mount of either version: version 1
 * at `<mount>/<path>`, version 2 at `<mount>/data/<path>`, its value the
 * text at the reference's key. Each mount's version is read from its UI
 * endpoint (`sys/internal/ui/mounts/<mount>`), where options name version 2,
 * and version 1 when a server has no such endpoint, as older ones answer
 * 404; it is kept for the provider's life, which is the environment's, and
 * nothing else is: every value is read again. A list is OpenBao's
 * (`?list=true`), under `metadata/` on version 2; with no mount, the KV
 * mounts the UI endpoint names.
 *
 * A run token (#368) is created with the login's token at
 * `auth/token/create`, or at its token role's `auth/token/create/<role>`,
 * with its policies, time to live, display name and metadata, renewable; it
 * renews itself at `auth/token/renew-self` and revokes itself as a login
 * does, the `default` policy it holds letting it.
 *
 * Whether a login may write a secret (#371) is its capabilities on the
 * secret's path, as `sys/capabilities-self` answers them: `create` (or
 * `root`) there, which a new entry needs, `<mount>/data/<path>` on version
 * 2. A write
 * reads the secret first: a different value at the key is left as it was
 * unless the write overwrites, and the secret is written back whole, with
 * the value and the fields given beside what else it held, the body itself
 * on version 1 and under `data` on version 2.
 *
 * An answer other than a success falls into one of the provider's
 * categories: a 503 read against the seal status, sealed or not; a 429
 * rate-limited; any other server error unreachable; on a login's own paths
 * any other refusal is the credential refused; elsewhere a 404 is
 * not-found and any other refusal denied. Every request verifies the
 * certificate of an `https` address, against the pinned CA when there is
 * one, which is then the only trust anchor (a pinned leaf or intermediate
 * anchors the chain itself), and the system's trusted CAs otherwise,
 * whatever the process's environment says: TLS verification is never
 * turned off.
 *
 * A call goes out on a connection kept from an earlier one when there is
 * one. When OpenBao closed it meanwhile (a restart, its idle timeout) and
 * the call is reset before any answer, that says nothing of OpenBao: the
 * call is made once more on a new connection, whose handshake verifies the
 * certificate OpenBao presents now (#681), under the same signal.
 */

/**
 * How long an attempt at a call may go without an answer (Node's socket
 * timeout, each attempt's own), past which OpenBao counts as unreachable.
 * ADR 0031's budget for a whole verification, read, list or write is the
 * caller's signal, which a retried call carries too.
 */
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

/** How a kept connection the other end had closed fails a call written to it: reset, or written to after its end. */
const CLOSED_CONNECTION_ERRORS = new Set(["ECONNRESET", "EPIPE"]);

/** What a call came back with: OpenBao's status and its JSON answer, or why there was none. */
type Reply = { readonly outcome: "answered"; readonly status: number; readonly body: unknown } | LoginFailure;

const unreachable = (target: SignInTarget, reason: string): LoginFailure => ({ outcome: "unreachable", message: `OpenBao at ${target.address} could not be reached: ${reason}.` });

/** What a request that failed before an answer comes to: a certificate that does not verify, or no answer at all. */
const failureOf = (target: SignInTarget, error: NodeJS.ErrnoException): LoginFailure => {
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

/** How one call is made: with the token, a JSON body, and until `signal` aborts. */
interface CallOptions {
  readonly token?: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal | undefined;
}

/**
 * One call to OpenBao's API under `/v1/`: `X-Vault-Token` carries the token
 * when there is one, and a JSON body the request's fields. The certificate is
 * verified against the pinned CA, or the system's with none, always. A kept
 * connection found closed before any answer is tried once more on a new one.
 */
const call = (target: SignInTarget, method: "GET" | "POST", path: string, options: CallOptions = {}): Promise<Reply> =>
  new Promise((resolve) => {
    if (options.signal?.aborted === true) {
      resolve(unreachable(target, "the verification's time ran out"));
      return;
    }
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
      // A pinned CA is the trust anchor as it is, root or not: a person may pin the leaf or intermediate a preview answered.
      ...(target.ca !== null && { ca: target.ca, allowPartialTrustChain: true }),
      ...(options.signal !== undefined && { signal: options.signal }),
    };
    /** Sends the call, on a new connection when `anew`, else on one kept from an earlier call if there is one. */
    const send = (anew: boolean): void => {
      let answered = false;
      const read = (response: IncomingMessage): void => {
        answered = true;
        readBody(response).then(
          (text) => resolve({ outcome: "answered", status: response.statusCode ?? 0, body: parse(text) }),
          (error: unknown) => resolve(failureOf(target, error as NodeJS.ErrnoException)),
        );
      };
      const sendOptions: RequestOptions = anew ? { ...requestOptions, agent: false } : requestOptions;
      const sent = url.protocol === "https:" ? httpsRequest(url, sendOptions, read) : httpRequest(url, sendOptions, read);
      sent.on("timeout", () => sent.destroy(Object.assign(new Error(`no answer within ${OPENBAO_CALL_TIMEOUT_MS / 1000} seconds`), { code: "ETIMEDOUT" })));
      sent.on("error", (error: NodeJS.ErrnoException) => {
        // A kept connection OpenBao had closed: the call never reached it, so it is made once more, on a new connection.
        if (!anew && !answered && sent.reusedSocket && CLOSED_CONNECTION_ERRORS.has(error.code ?? "")) send(true);
        else resolve(failureOf(target, error));
      });
      sent.end(body);
    };
    send(false);
  });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The first error line OpenBao gave, on one line; empty for none. */
const firstError = (body: unknown): string => {
  const errors = isRecord(body) ? body["errors"] : undefined;
  const [first] = Array.isArray(errors) ? errors.filter((error): error is string => typeof error === "string" && error.trim() !== "") : [];
  return first === undefined ? "" : first.replace(/\s+/g, " ").trim();
};

const sealedFailure = (target: SignInTarget): LoginFailure => ({ outcome: "sealed", message: `OpenBao at ${target.address} is sealed: unseal it to sign in.` });

/**
 * What an answer other than a success to a login's own call comes to: a 503
 * read against the seal status, sealed or not; a 429 rate-limited; any
 * other server error unreachable; the rest is the credential refused.
 */
const refusal = async (target: SignInTarget, status: number, body: unknown, signal?: AbortSignal): Promise<LoginFailure> => {
  const said = firstError(body);
  const detail = `HTTP ${status}${said === "" ? "" : `: ${said}`}`;
  if (status === 503) {
    const seal = await call(target, "GET", "sys/seal-status", { signal });
    if (seal.outcome === "answered" && isRecord(seal.body) && seal.body["sealed"] === true) return sealedFailure(target);
  }
  if (status === 429) return { outcome: "rate-limited", message: `OpenBao at ${target.address} asked the harness to slow down (${detail}).` };
  if (status >= 500) return { outcome: "unreachable", message: `OpenBao at ${target.address} could not answer (${detail}).` };
  return { outcome: "credential-rejected", message: `OpenBao at ${target.address} refused the credential (${detail}).` };
};

/**
 * What an answer other than a success to any other call, which `asked`
 * names (`read the policy agents`), comes to: as a login's, except that a
 * 404 is not-found and any other refusal denied.
 */
const readRefusal = async (target: SignInTarget, asked: string, status: number, body: unknown, signal?: AbortSignal): Promise<ProviderFailure> => {
  if (status === 429 || status >= 500) return refusal(target, status, body, signal);
  const said = firstError(body);
  const detail = `HTTP ${status}${said === "" ? "" : `: ${said}`}`;
  if (status === 404) return { outcome: "not-found", message: `OpenBao at ${target.address} found nothing to ${asked} (${detail}).` };
  return { outcome: "denied", message: `OpenBao at ${target.address} did not let the login ${asked} (${detail}).` };
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

/** The path a login's run tokens are created at: its token role's, or the token store's own. */
const createPath = (tokenRole: string | null): string => (tokenRole === null ? "auth/token/create" : `auth/token/create/${tokenRole}`);

/** What `sys/capabilities-self` answered for `path`: its capabilities, read where OpenBao puts them (under `data` and beside it); empty for none. */
const capabilitiesIn = (body: unknown, path: string): string[] => {
  const data = isRecord(body) && isRecord(body["data"]) ? body["data"] : body;
  const listed = isRecord(data) ? (data[path] ?? data["capabilities"]) : undefined;
  return Array.isArray(listed) ? listed.filter((capability): capability is string => typeof capability === "string") : [];
};

/** A policy's text as `sys/policies/acl/<name>` answers it; null for an answer holding none. */
const policyTextIn = (body: unknown): string | null => {
  const data = isRecord(body) && isRecord(body["data"]) ? body["data"] : body;
  const text = isRecord(data) ? data["policy"] : undefined;
  return typeof text === "string" ? text : null;
};

/** A category a verification cannot go on past: the key manager did not answer, is sealed, rejects its certificate or asks it to slow down. */
const stopsVerification = (failure: ProviderFailure): failure is LoginFailure => failure.outcome !== "denied" && failure.outcome !== "not-found" && failure.outcome !== "credential-rejected";

const logIn: ConnectionProvider["logIn"] = async (target, credential, signal) => {
  if (credential.method === "token") return { outcome: "logged-in", token: credential.token, minted: false };
  const reply =
    credential.method === "approle"
      ? await call(target, "POST", `auth/${encodedPath(target.mount)}/login`, { body: { role_id: credential.roleId, secret_id: credential.secretId }, signal })
      : await call(target, "POST", `auth/${encodedPath(target.mount)}/login/${encodeURIComponent(target.username ?? "")}`, { body: { password: credential.password }, signal });
  if (reply.outcome !== "answered") return reply;
  if (reply.status < 200 || reply.status > 299) return refusal(target, reply.status, reply.body, signal);
  const auth = isRecord(reply.body) ? reply.body["auth"] : undefined;
  const token = isRecord(auth) ? auth["client_token"] : undefined;
  if (typeof token !== "string" || token === "") return unreachable(target, "its login answered no token");
  return { outcome: "logged-in", token, minted: true };
};

const lookUp: ConnectionProvider["lookUp"] = async (target, token, signal) => {
  const reply = await call(target, "GET", "auth/token/lookup-self", { token, signal });
  if (reply.outcome !== "answered") return reply;
  if (reply.status !== 200) return refusal(target, reply.status, reply.body, signal);
  const found = lookedUp(reply.body);
  return found === null ? unreachable(target, "its token lookup answered no token") : { outcome: "found", ...found };
};

const readPolicy: ConnectionProvider["readPolicy"] = async (target, token, name, signal) => {
  const path = `sys/policies/acl/${encodeURIComponent(name)}`;
  const reply = await call(target, "GET", path, { token, signal });
  if (reply.outcome !== "answered") return reply;
  if (reply.status !== 200) return readRefusal(target, `read the policy ${name}`, reply.status, reply.body, signal);
  const text = policyTextIn(reply.body);
  return text === null ? { outcome: "not-found", message: `OpenBao at ${target.address} answered no text for the policy ${name}.` } : { outcome: "read", text };
};

/** The KV versions a mount is, 1 or 2. */
type KvVersion = 1 | 2;

/** The path of the secret at `path` under a KV mount of `version`, as OpenBao's API and its policies name it: under `data/` on version 2. */
const secretPath = (version: KvVersion, mount: string, path: string): string => (version === 2 ? `${mount}/data/${path}` : `${mount}/${path}`);

/** The capabilities that let a login create a secret where none is, as a new entry needs: `update` alone only replaces one. */
const CREATING = new Set(["create", "root"]);

/** The names a list answered: `keys` under `data`, each a name; a folder's ends in `/`. */
const keysIn = (body: unknown): string[] => {
  const data = isRecord(body) ? body["data"] : undefined;
  const keys = isRecord(data) ? data["keys"] : undefined;
  return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string" && key !== "") : [];
};

/** The KV mounts the UI endpoint's list names, as it names them (`personal/`), in its order. */
const kvMountsIn = (body: unknown): string[] => {
  const data = isRecord(body) ? body["data"] : undefined;
  const secret = isRecord(data) ? data["secret"] : undefined;
  if (!isRecord(secret)) return [];
  return Object.entries(secret)
    .filter(([, mount]) => isRecord(mount) && (mount["type"] === "kv" || mount["type"] === "generic"))
    .map(([name]) => (name.endsWith("/") ? name : `${name}/`));
};

/**
 * A provider for OpenBao and Vault. Each keeps the KV version of every
 * mount it has read from, for its life: the environment makes one, so a
 * mount's version is read once per process.
 */
export const createOpenBaoProvider = (): ConnectionProvider => {
  const kvVersions = new Map<string, KvVersion>();

  /** The version of the KV mount `mount`: kept, else read from its UI endpoint with the login's token; a failure is not kept. */
  const versionOf = async (target: SignInTarget, token: string, mount: string, signal?: AbortSignal): Promise<{ readonly outcome: "detected"; readonly version: KvVersion } | ProviderFailure> => {
    const key = JSON.stringify([target.address, mount]);
    const kept = kvVersions.get(key);
    if (kept !== undefined) return { outcome: "detected", version: kept };
    const reply = await call(target, "GET", `sys/internal/ui/mounts/${encodedPath(mount)}`, { token, signal });
    if (reply.outcome !== "answered") return reply;
    let version: KvVersion = 1;
    if (reply.status === 200) {
      const data = isRecord(reply.body) ? reply.body["data"] : undefined;
      const options = isRecord(data) ? data["options"] : undefined;
      version = isRecord(options) && options["version"] === "2" ? 2 : 1;
    } else if (reply.status !== 404) {
      return readRefusal(target, `see the mount ${mount}`, reply.status, reply.body, signal);
    }
    kvVersions.set(key, version);
    return { outcome: "detected", version };
  };

  return {
    logIn,

    lookUp,

    async verify(target, token, { tokenRole, signal }) {
      const seal = await call(target, "GET", "sys/seal-status", { signal });
      if (seal.outcome !== "answered") return seal;
      if (seal.status !== 200) return refusal(target, seal.status, seal.body, signal);
      if (isRecord(seal.body) && seal.body["sealed"] === true) return sealedFailure(target);

      const found = await lookUp(target, token, signal);
      if (found.outcome !== "found") return found;

      const path = createPath(tokenRole);
      const asked = await call(target, "POST", "sys/capabilities-self", { token, body: { paths: [path] }, signal });
      if (asked.outcome !== "answered") return asked;
      let canMint = false;
      if (asked.status === 200) {
        const capabilities = capabilitiesIn(asked.body, path);
        canMint = capabilities.includes("update") || capabilities.includes("root");
      } else {
        // A login that may not ask its own capabilities cannot be shown to mint.
        const refused = await readRefusal(target, "ask its capabilities", asked.status, asked.body, signal);
        if (stopsVerification(refused)) return refused;
      }

      const policies: KeyManagerLoginPolicy[] = [];
      for (const name of found.information.policies) {
        const text = await readPolicy(target, token, name, signal);
        if (text.outcome !== "read" && stopsVerification(text)) return text;
        policies.push({ name, writes: text.outcome === "read" ? policyWrites(text.text) : "possibly" });
      }
      return { outcome: "verified", information: found.information, root: found.root, canMint, policies };
    },

    readPolicy,

    async revoke(target, token) {
      const reply = await call(target, "POST", "auth/token/revoke-self", { token });
      if (reply.outcome !== "answered") return reply;
      return reply.status >= 200 && reply.status <= 299 ? { outcome: "revoked" } : refusal(target, reply.status, reply.body);
    },

    async mint(target, token, { policies, ttlSeconds, displayName, metadata, tokenRole }, signal): Promise<MintAnswer> {
      const body = { policies: [...policies], ttl: `${ttlSeconds}s`, display_name: displayName, meta: { ...metadata }, renewable: true };
      const reply = await call(target, "POST", tokenRole === null ? createPath(null) : `auth/token/create/${encodeURIComponent(tokenRole)}`, { token, body, signal });
      if (reply.outcome !== "answered") return reply;
      if (reply.status < 200 || reply.status > 299) return readRefusal(target, "mint a run token", reply.status, reply.body, signal);
      const auth = isRecord(reply.body) ? reply.body["auth"] : undefined;
      const minted = isRecord(auth) ? auth["client_token"] : undefined;
      return typeof minted === "string" && minted !== "" ? { outcome: "minted", token: minted } : unreachable(target, "its token creation answered no token");
    },

    async renew(target, token, incrementSeconds, signal): Promise<RenewAnswer> {
      const reply = await call(target, "POST", "auth/token/renew-self", { token, body: { increment: `${incrementSeconds}s` }, signal });
      if (reply.outcome !== "answered") return reply;
      if (reply.status < 200 || reply.status > 299) return refusal(target, reply.status, reply.body, signal);
      const auth = isRecord(reply.body) ? reply.body["auth"] : undefined;
      const lease = isRecord(auth) ? auth["lease_duration"] : undefined;
      return { outcome: "renewed", ttlSeconds: typeof lease === "number" && Number.isInteger(lease) && lease >= 0 ? lease : 0 };
    },

    async read(target, token, reference, signal) {
      if (reference.provider !== "openbao") return { outcome: "not-found", message: `OpenBao at ${target.address} holds no ${reference.provider} reference.` };
      const where = `${reference.mount}/${reference.path}`;
      const detected = await versionOf(target, token, reference.mount, signal);
      if (detected.outcome !== "detected") return detected;
      const reply = await call(target, "GET", encodedPath(secretPath(detected.version, reference.mount, reference.path)), { token, signal });
      if (reply.outcome !== "answered") return reply;
      if (reply.status !== 200) return readRefusal(target, `read ${where}`, reply.status, reply.body, signal);
      const data = isRecord(reply.body) ? reply.body["data"] : undefined;
      const fields = detected.version === 2 && isRecord(data) ? data["data"] : data;
      const value = isRecord(fields) ? fields[reference.key] : undefined;
      // Never the value in a line: a key holding no text is named, and what it holds is not.
      if (typeof value !== "string" || value === "") return { outcome: "not-found", message: `OpenBao at ${target.address} holds no key ${reference.key} with text in ${where}.` };
      return { outcome: "read", value };
    },

    async list(target, token, { mount, path }, signal): Promise<ListAnswer> {
      if (mount === null) {
        const reply = await call(target, "GET", "sys/internal/ui/mounts", { token, signal });
        if (reply.outcome !== "answered") return reply;
        if (reply.status !== 200) return readRefusal(target, "list the mounts", reply.status, reply.body, signal);
        return { outcome: "listed", names: kvMountsIn(reply.body) };
      }
      const detected = await versionOf(target, token, mount, signal);
      if (detected.outcome !== "detected") return detected;
      const base = detected.version === 2 ? `${encodedPath(mount)}/metadata/` : `${encodedPath(mount)}/`;
      const where = path === null ? mount : `${mount}/${path}`;
      const reply = await call(target, "GET", `${base}${path === null ? "" : `${encodedPath(path)}/`}?list=true`, { token, signal });
      if (reply.outcome !== "answered") return reply;
      if (reply.status !== 200) return readRefusal(target, `list ${where}`, reply.status, reply.body, signal);
      return { outcome: "listed", names: keysIn(reply.body) };
    },

    async write(target, token, { reference, value, fields, overwrite }, signal): Promise<WriteAnswer> {
      if (reference.provider !== "openbao") return { outcome: "not-found", message: `OpenBao at ${target.address} holds no ${reference.provider} reference.` };
      const where = `${reference.mount}/${reference.path}`;
      const detected = await versionOf(target, token, reference.mount, signal);
      if (detected.outcome !== "detected") return detected;
      const path = encodedPath(secretPath(detected.version, reference.mount, reference.path));
      const held = await call(target, "GET", path, { token, signal });
      if (held.outcome !== "answered") return held;
      if (held.status !== 200 && held.status !== 404) return readRefusal(target, `read ${where} before writing it`, held.status, held.body, signal);
      const data = held.status === 200 && isRecord(held.body) ? held.body["data"] : undefined;
      const kept = detected.version === 2 && isRecord(data) ? data["data"] : data;
      const existing = isRecord(kept) ? kept : {};
      const there = existing[reference.key];
      // Anything at the key but the same text is a different value, left as it is unless the write overwrites it.
      if (there !== undefined && !overwrite && (typeof there !== "string" || !sameValue(there, value))) return { outcome: "exists" };
      const secret = { ...existing, ...fields, [reference.key]: value };
      const reply = await call(target, "POST", path, { token, body: detected.version === 2 ? { data: secret } : secret, signal });
      if (reply.outcome !== "answered") return reply;
      if (reply.status < 200 || reply.status > 299) return readRefusal(target, `write ${where}`, reply.status, reply.body, signal);
      return { outcome: "written" };
    },

    async canWrite(target, token, { mount, path }, signal): Promise<WriteCheckAnswer> {
      const detected = await versionOf(target, token, mount, signal);
      if (detected.outcome !== "detected") return detected;
      const asked = secretPath(detected.version, mount, path);
      const reply = await call(target, "POST", "sys/capabilities-self", { token, body: { paths: [asked] }, signal });
      if (reply.outcome !== "answered") return reply;
      if (reply.status !== 200) return readRefusal(target, "ask its capabilities", reply.status, reply.body, signal);
      return { outcome: "checked", writable: capabilitiesIn(reply.body, asked).some((capability) => CREATING.has(capability)) };
    },
  };
};
