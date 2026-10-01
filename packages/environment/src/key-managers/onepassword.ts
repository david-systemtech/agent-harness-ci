import { httpOriginOf, type KeyManagerCredential, type KeyManagerReference, type KeyManagerTokenInformation } from "@agent-harness/contracts";
import type { OnePasswordEntry, OnePasswordSdk, OnePasswordSession } from "./onepassword-sdk.js";
import type { ConnectionProvider, LoginFailure, ProviderFailure, TokenLife } from "./provider.js";
import { sameValue } from "./same-value.js";

/**
 * The 1Password provider (key-managers spec, "Providers"; ADR 0011, ADR
 * 0028; #378): 1Password through its official JavaScript SDK
 * (`onepassword-sdk.ts`), signed in with a service-account token.
 *
 * - **The address** is the account URL the token names: a service-account
 *   token is `ops_` and a base64 JSON whose `signInAddress` is the
 *   account's host, which the SDK signs in at. The connection learns it at
 *   sign-in (`addressOf`), so a token for another account is told apart
 *   before anything is asked.
 * - **Signing in** makes an SDK session from the token, and listing the
 *   vaults the service account can see proves it; a verification lists them
 *   again. The session is the environment's own (`minted`), kept per token
 *   until the login is let go (`revoke`), which ends the session and never
 *   the token, the person's: a verification that finds the session expired
 *   signs in again from the kept token. A service account has no policies,
 *   mints no run tokens (`canMint` null: runs are given the connection's own
 *   token) and has no lease to renew.
 * - **A reference** names a vault, an item and a field, by name or id, read
 *   as the `op://` reference they make; a name an `op://` reference cannot
 *   carry is looked up to its id first.
 * - **A list** names the vaults with no vault, a vault's items with one, and
 *   an item's fields with an item too; never a value.
 * - **A Move's write** goes to the item titled after the target in the base
 *   vault, its concealed field `credential`: an item made as an API
 *   credential, its notes saying what the value is, when there is none, and
 *   the field set on the one there otherwise. 1Password cannot be asked what
 *   a service account may do in a vault, so a write check answers whether
 *   the vault is there to write to; one the account may only read refuses
 *   the write itself (`denied`).
 * - **Failures** are sorted from what the SDK throws: its rate-limit error,
 *   and its expired-session error with a token refused; a permission
 *   refused; a vault, item or field that matched nothing; anything else the
 *   SDK could not get an answer to.
 */

/** A service-account token's prefix. */
const TOKEN_PREFIX = "ops_";

/**
 * The account URL a service-account token names: its `signInAddress`, the
 * account's host, as an https origin. Null for anything that is no
 * service-account token.
 */
export const accountUrlOf = (token: string): string | null => {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(token.slice(TOKEN_PREFIX.length), "base64").toString("utf8"));
    if (typeof payload !== "object" || payload === null || !("signInAddress" in payload) || typeof payload.signInAddress !== "string") return null;
    return /^[a-z0-9.-]+(?::\d+)?$/i.test(payload.signInAddress) ? httpOriginOf(`https://${payload.signInAddress}`) : null;
  } catch {
    return null;
  }
};

/** The field a Move writes the value to (key-managers spec, "Move stored tokens"): an API credential's own. */
export const ONEPASSWORD_MOVE_FIELD = "credential";

/** What a service account's sign-in says of it: no name, policy or lease of its own. */
const INFORMATION: KeyManagerTokenInformation = { displayName: "", policies: [], ttlSeconds: 0, renewable: false, expiresAt: null };

const NO_LIFE: TokenLife = { issuedAt: null, creationTtlSeconds: 0, periodSeconds: 0, explicitMaxTtlSeconds: 0 };

/** The characters an `op://` reference carries in a name; any other has the name looked up to its id. */
const REFERENCE_SAFE = /^[A-Za-z0-9_.\- ]+$/;

/** The SDK's own error classes, which it throws by name for a rate limit and an expired session. */
const RATE_LIMITED = new Set(["RateLimitExceededError"]);
const SESSION_EXPIRED = new Set(["AuthExpiredError", "DesktopSessionExpiredError"]);

/** Sorts what the SDK threw into the provider's categories, saying what was being done. */
export const onePasswordFailure = (doing: string, error: unknown): ProviderFailure => {
  const text = error instanceof Error ? error.message : String(error);
  const kind = error instanceof Error ? error.constructor.name : "";
  const message = `${doing} failed: ${text}`;
  if (RATE_LIMITED.has(kind) || /rate limit|too many requests/i.test(text)) return { outcome: "rate-limited", message };
  if (SESSION_EXPIRED.has(kind) || /service account token|not authenticated|unauthori[sz]ed|authentication/i.test(text)) return { outcome: "credential-rejected", message };
  if (/right permissions|permission denied|forbidden|not allowed/i.test(text)) return { outcome: "denied", message };
  if (/matched|cannot be found|not found|no such|not in an active state|secret reference/i.test(text)) return { outcome: "not-found", message };
  return { outcome: "unreachable", message };
};

/** A failure of the login's own calls: nothing it asks is a path that may be refused or missing, so either is the token refused. */
const asLoginFailure = (failure: ProviderFailure): LoginFailure =>
  failure.outcome === "denied" || failure.outcome === "not-found" ? { outcome: "credential-rejected", message: failure.message } : (failure as LoginFailure);

/** What a lookup by name or id found nothing for. */
class NotFound extends Error {}

/** The name a list gives an entry: its title, or its id when it has none (1Password allows an untitled field), which `named` finds it by too. */
const nameOf = ({ id, title }: OnePasswordEntry): string => (title === "" ? id : title);

/** The entry named `name`, by title or id: one titled so, else the one with that id. */
const named = (entries: readonly OnePasswordEntry[], name: string, what: string, where: string): OnePasswordEntry => {
  const titled = entries.filter((entry) => entry.title === name);
  if (titled.length > 1) throw new NotFound(`More than one ${what} ${where}is titled ${name}: name it by its id.`);
  const found = titled[0] ?? entries.find((entry) => entry.id === name);
  if (found === undefined) throw new NotFound(`No ${what} ${where}is titled ${name}, or has that id.`);
  return found;
};

export const createOnePasswordProvider = (sdk: OnePasswordSdk): ConnectionProvider => {
  /** Each token's session, made at its sign-in, or by the first call that found none. */
  const sessions = new Map<string, Promise<OnePasswordSession>>();

  /** Signs in afresh with `token`, in place of any session it had. */
  const signIn = (token: string): Promise<OnePasswordSession> => {
    const session = sdk.signIn(token);
    sessions.set(token, session);
    session.catch(() => {
      if (sessions.get(token) === session) sessions.delete(token);
    });
    return session;
  };

  /** Runs `work` with the token's session, answering what the SDK threw as its category. */
  const using = async <A>(token: string, doing: string, signal: AbortSignal | undefined, work: (session: OnePasswordSession) => Promise<A>): Promise<A | ProviderFailure> => {
    try {
      if (signal?.aborted === true) return { outcome: "unreachable", message: `${doing} was stopped: 1Password did not answer in time.` };
      return await work(await (sessions.get(token) ?? signIn(token)));
    } catch (error) {
      return error instanceof NotFound ? { outcome: "not-found", message: error.message } : onePasswordFailure(doing, error);
    }
  };

  const vaultNamed = async (session: OnePasswordSession, vault: string): Promise<OnePasswordEntry> => named(await session.vaults(), vault, "vault", "the service account can see ");

  const itemNamed = async (session: OnePasswordSession, vaultId: string, item: string, vault: string): Promise<OnePasswordEntry> =>
    named(await session.items(vaultId), item, "item", `in the vault ${vault} `);

  /** The `op://` reference to a field: by the names given where each is one a reference carries, else by ids looked up. */
  const referenceTo = async (session: OnePasswordSession, vault: string, item: string, field: string): Promise<string> => {
    if ([vault, item, field].every((name) => REFERENCE_SAFE.test(name))) return `op://${vault}/${item}/${field}`;
    const vaultId = (await vaultNamed(session, vault)).id;
    const found = await itemNamed(session, vaultId, item, vault);
    const fieldId = REFERENCE_SAFE.test(field) ? field : named((await session.item(vaultId, found.id)).fields, field, "field", `of the item ${item} `).id;
    return `op://${vaultId}/${found.id}/${fieldId}`;
  };

  const notOnePassword = (reference: KeyManagerReference): ProviderFailure => ({
    outcome: "not-found",
    message: `A ${reference.provider} reference is not read through 1Password.`,
  });

  return {
    addressOf: (credential: KeyManagerCredential) => (credential.method === "token" ? accountUrlOf(credential.token) : null),

    async logIn(_target, credential) {
      if (credential.method !== "token" || accountUrlOf(credential.token) === null) {
        return { outcome: "credential-rejected", message: "That is no 1Password service-account token: give one from the service account's page in 1Password, which starts ops_." };
      }
      const { token } = credential;
      try {
        await (await signIn(token)).vaults();
        return { outcome: "logged-in", token, minted: true };
      } catch (error) {
        sessions.delete(token);
        return asLoginFailure(onePasswordFailure("Signing in to 1Password with the service-account token", error));
      }
    },

    async lookUp(_target, token, signal) {
      const answer = await using(token, "Listing the vaults the service account can see", signal, (session) => session.vaults());
      return "outcome" in answer ? asLoginFailure(answer) : { outcome: "found", information: INFORMATION, life: NO_LIFE, root: false };
    },

    async verify(_target, token, { signal }) {
      const answer = await using(token, "Listing the vaults the service account can see", signal, (session) => session.vaults());
      return "outcome" in answer ? asLoginFailure(answer) : { outcome: "verified", information: INFORMATION, root: false, canMint: null, policies: [] };
    },

    async readPolicy() {
      return { outcome: "not-found", message: "A 1Password service account has no policies: what it may do is set per vault in 1Password." };
    },

    async revoke(_target, token) {
      sessions.delete(token);
      return { outcome: "revoked" };
    },

    async mint() {
      return { outcome: "denied", message: "A 1Password service account mints no run tokens: runs are given the connection's own token." };
    },

    async renew() {
      return { outcome: "renewed", ttlSeconds: 0 };
    },

    async read(_target, token, reference, signal) {
      if (reference.provider !== "onepassword") return notOnePassword(reference);
      const { vault, item, field } = reference;
      const value = await using(token, `Reading op://${vault}/${item}/${field}`, signal, async (session) => session.resolve(await referenceTo(session, vault, item, field)));
      return typeof value === "string" ? { outcome: "read", value } : value;
    },

    async list(_target, token, { mount: vault, path: item }, signal) {
      const names = await using(token, "Listing 1Password's names", signal, async (session): Promise<readonly string[]> => {
        if (vault === null) return (await session.vaults()).map((entry) => `${nameOf(entry)}/`);
        const vaultId = (await vaultNamed(session, vault)).id;
        if (item === null) return (await session.items(vaultId)).map((entry) => `${nameOf(entry)}/`);
        return (await session.item(vaultId, (await itemNamed(session, vaultId, item, vault)).id)).fields.map(nameOf);
      });
      if ("outcome" in names) return names;
      if (names.length === 0) {
        const where = vault === null ? "the service account can see no vault" : item === null ? `the vault ${vault} holds no item` : `the item ${item} has no field`;
        return { outcome: "not-found", message: `Nothing to list: ${where}.` };
      }
      return { outcome: "listed", names };
    },

    async canWrite(_target, token, { mount: vault }, signal) {
      const found = await using(token, `Finding the vault ${vault}`, signal, (session) => vaultNamed(session, vault));
      return "outcome" in found ? found : { outcome: "checked", writable: true };
    },

    async write(_target, token, { reference, value, fields, overwrite }, signal) {
      if (reference.provider !== "onepassword") return notOnePassword(reference);
      const { vault, item, field } = reference;
      return await using(token, `Writing op://${vault}/${item}/${field}`, signal, async (session) => {
        const vaultId = (await vaultNamed(session, vault)).id;
        const titled = (await session.items(vaultId)).filter((each) => each.title === item);
        const [existing, ...others] = titled;
        if (others.length > 0) throw new NotFound(`More than one item in the vault ${vault} is titled ${item}: keep one, then move again.`);
        if (existing === undefined) {
          await session.create(vaultId, { title: item, notes: fields["note"] ?? "", field, value });
          return { outcome: "written" } as const;
        }
        const held = (await session.item(vaultId, existing.id)).fields.find((each) => each.title === field);
        if (held !== undefined) {
          const there = await session.resolve(`op://${vaultId}/${existing.id}/${held.id}`);
          if (sameValue(there, value)) return { outcome: "written" } as const;
          if (!overwrite) return { outcome: "exists" } as const;
        }
        await session.setField(vaultId, existing.id, field, value);
        return { outcome: "written" } as const;
      });
    },
  };
};
