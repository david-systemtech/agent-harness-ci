import type { KeyManagerTokenInformation } from "@agent-harness/contracts";
import { loadBitwardenSdk, type BitwardenSdk, type BitwardenSdkLoader } from "./bitwarden-sdk.js";
import { KEY_MANAGER_BUDGET_MS, type ConnectionProvider, type LoginFailure, type ProviderFailure, type SignInTarget } from "./provider.js";
import { sameValue } from "./same-value.js";

const INFORMATION: KeyManagerTokenInformation = { displayName: "", policies: [], ttlSeconds: 0, renewable: false, expiresAt: null };
const LIFE = { issuedAt: null, creationTtlSeconds: 0, periodSeconds: 0, explicitMaxTtlSeconds: 0 } as const;
const AMBIGUOUS_PROJECT = { outcome: "unreachable", message: "The Bitwarden base project is ambiguous; select a unique project id." } as const;

/** Native wrappers report HTTP/TLS failures as text; keep their categories and never include raw response text. */
const failure = (error: unknown): ProviderFailure => {
  const message = error instanceof Error ? error.message : String(error);
  const outcome = /\b401\b|invalid.*(token|client)|unauthorized/i.test(message) ? "credential-rejected"
    : /\b403\b|forbidden/i.test(message) ? "denied"
    : /\b404\b|not found/i.test(message) ? "not-found"
    : /\b429\b|too many requests/i.test(message) ? "rate-limited"
    : /certificate|CERT_|TLS|SSL/i.test(message) ? "certificate-rejected" : "unreachable";
  return { outcome, message: `Bitwarden Secrets Manager: ${outcome}.` };
};
const loginFailure = (answer: ProviderFailure): LoginFailure =>
  answer.outcome === "denied" || answer.outcome === "not-found" ? { ...answer, outcome: "credential-rejected" } : { outcome: answer.outcome, message: answer.message };

export const createBitwardenProvider = (load: BitwardenSdkLoader = loadBitwardenSdk): ConnectionProvider => {
  const withSdk = async <T>(target: SignInTarget, token: string, work: (sdk: BitwardenSdk, signal: AbortSignal) => Promise<T>, givenSignal?: AbortSignal): Promise<T | ProviderFailure> => {
    const signal = givenSignal ?? AbortSignal.timeout(KEY_MANAGER_BUDGET_MS);
    const aborted: ProviderFailure = { outcome: "unreachable", message: "Bitwarden SDK operation was aborted or exceeded its budget." };
    if (signal.aborted) return aborted;
    let onAbort: () => void = () => undefined;
    const interrupted = new Promise<ProviderFailure>((resolve) => {
      onAbort = () => resolve(aborted);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const ask = async (): Promise<T | ProviderFailure> => {
      let sdk: BitwardenSdk;
      try { sdk = await load(target.address); }
      catch (error) { return { outcome: "provider-unavailable", message: `Bitwarden SDK unavailable: ${error instanceof Error ? error.message : String(error)}` }; }
      if (signal.aborted) return aborted;
      try {
        await sdk.login(token);
        if (signal.aborted) return aborted;
        return await work(sdk, signal);
      } catch (error) { return failure(error); }
    };
    try { return await Promise.race([ask(), interrupted]); }
    finally { signal.removeEventListener("abort", onAbort); }
  };
  const lookUp: ConnectionProvider["lookUp"] = async (target, token, signal) => {
    const answer = await withSdk(target, token, async (sdk) => {
      await sdk.projects();
      return { outcome: "found", information: INFORMATION, life: LIFE, root: false } as const;
    }, signal);
    return answer.outcome === "found" ? answer : loginFailure(answer);
  };
  return {
    async logIn(target, credential, signal) {
      if (credential.method !== "token") return { outcome: "credential-rejected", message: "Bitwarden Secrets Manager signs in with an access token." };
      const found = await lookUp(target, credential.token, signal);
      return found.outcome === "found" ? { outcome: "logged-in", token: credential.token, minted: false } : found;
    },
    lookUp,
    async verify(target, token, options) {
      const found = await lookUp(target, token, options.signal);
      return found.outcome === "found" ? { outcome: "verified", information: found.information, root: false, canMint: true, policies: [] } : found;
    },
    async readPolicy() { return { outcome: "not-found", message: "Bitwarden has no OpenBao policies." }; },
    async revoke() { return { outcome: "revoked" }; },
    async mint(_target, token) { return { outcome: "minted", token }; },
    async renew() { return { outcome: "credential-rejected", message: "A Bitwarden access token is not renewable." }; },
    async read(target, token, reference, signal) {
      if (reference.provider !== "bitwarden") return { outcome: "not-found", message: "This is not a Bitwarden reference." };
      return withSdk(target, token, async (sdk) => ({ outcome: "read", value: (await sdk.get(reference.secretId)).value } as const), signal);
    },
    async list(target, token, location, signal) {
      return withSdk(target, token, async (sdk) => {
        if (location.mount === null) return { outcome: "listed", names: (await sdk.projects()).map((project) => project.name) } as const;
        const projects = (await sdk.projects()).filter((project) => project.id === location.mount || project.name === location.mount);
        if (projects.length > 1) return AMBIGUOUS_PROJECT;
        const project = projects.length === 1 ? projects[0] : undefined;
        if (!project) return { outcome: "not-found", message: "Bitwarden holds no such project." } as const;
        return { outcome: "listed", names: (await sdk.identifiers(project.id)).map((identifier) => identifier.key) } as const;
      }, signal);
    },
    async canWrite(target, token, location, signal) {
      return withSdk(target, token, async (sdk) => {
        const projects = (await sdk.projects()).filter((project) => project.id === location.mount || project.name === location.mount);
        if (projects.length > 1) return AMBIGUOUS_PROJECT;
        const project = projects.length === 1 ? projects[0] : undefined;
        // There is no non-mutating SDK permission probe. The write itself
        // decides permission; a denied write is handled by Move's copy offer.
        return project ? { outcome: "checked", writable: true } as const : { outcome: "not-found", message: "Bitwarden holds no such base project." } as const;
      }, signal);
    },
    async locateMove(target, token, locator, signal) {
      if (locator.provider !== "bitwarden" || !("project" in locator)) return { outcome: "not-found", message: "This is not a Bitwarden Move target." };
      return withSdk(target, token, async (sdk) => {
        const projects = (await sdk.projects()).filter((project) => project.id === locator.project || project.name === locator.project);
        if (projects.length > 1) return AMBIGUOUS_PROJECT;
        const project = projects.length === 1 ? projects[0] : undefined;
        const matches = [];
        if (project) for (const identifier of await sdk.identifiers()) {
          if (identifier.key !== locator.key) continue;
          const secret = await sdk.get(identifier.id);
          if (secret.projectId === project.id) matches.push(secret);
        }
        if (matches.length > 1) return { outcome: "unreachable", message: "The Bitwarden Move target is ambiguous; choose a unique project and key." } as const;
        const secret = matches[0];
        return secret ? { outcome: "located", reference: { provider: "bitwarden", connectionId: locator.connectionId, secretId: secret.id, key: secret.key } } as const : { outcome: "not-found", message: "Bitwarden holds no secret at the Move target." } as const;
      }, signal);
    },
    async write(target, token, request, signal) {
      const { reference: locator, value, overwrite } = request;
      if (locator.provider !== "bitwarden" || !("project" in locator)) return { outcome: "not-found", message: "This is not a Bitwarden Move target." };
      return withSdk(target, token, async (sdk, budget) => {
        const projects = (await sdk.projects()).filter((project) => project.id === locator.project || project.name === locator.project);
        if (projects.length > 1) return AMBIGUOUS_PROJECT;
        if (projects.length !== 1) return { outcome: "not-found", message: "Select a unique Bitwarden base project by its id or name." } as const;
        const project = projects[0]!;
        const matches = [];
        for (const identifier of await sdk.identifiers()) {
          if (identifier.key !== locator.key) continue;
          const secret = await sdk.get(identifier.id);
          if (secret.projectId === project.id) matches.push(secret);
        }
        if (matches.length > 1) return { outcome: "unreachable", message: "The Bitwarden base project has more than one secret with this key; choose a unique target first." } as const;
        const existing = matches[0];
        if (existing && !sameValue(existing.value, value) && !overwrite) return { outcome: "exists" } as const;
        const note = Object.entries(request.fields).map(([key, field]) => `${key}: ${field}`).join("\n");
        budget.throwIfAborted();
        const secret = existing === undefined ? await sdk.create(project.id, locator.key, value, note)
          : sameValue(existing.value, value) ? existing : await sdk.update(existing, value, existing.note ?? note);
        return { outcome: "written", reference: { provider: "bitwarden", connectionId: locator.connectionId, secretId: secret.id, key: secret.key } } as const;
      }, signal);
    },
  };
};
