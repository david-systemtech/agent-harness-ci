import { randomUUID } from "node:crypto";
import type { OnePasswordEntry, OnePasswordSdk, OnePasswordSession } from "../src/key-managers/onepassword-sdk.js";

/**
 * A scripted 1Password behind the provider's SDK seam (key-managers spec,
 * "Testing Decisions"; #378): one account whose vaults, items and fields a
 * test sets, the service-account tokens it accepts, and failures scripted
 * per call, thrown as the SDK throws them: its own error classes for a rate
 * limit and an expired session, else an `Error` with the SDK's message. It
 * records each call by name and the ids it named, never a value. Nothing
 * here reaches 1Password.
 */

/** The account host the test tokens name. */
export const FAKE_ACCOUNT_HOST = "example.1password.com";

/** Its account URL, as a connection keeps it. */
export const FAKE_ACCOUNT_URL = `https://${FAKE_ACCOUNT_HOST}`;

/**
 * A fake service-account token naming `host` as its sign-in address: `ops_`
 * and a base64 JSON, as 1Password's are, built at run time so no source
 * holds a token's shape, and different for each `name`.
 */
export const serviceAccountToken = (name = "token-for-tests", host = FAKE_ACCOUNT_HOST): string =>
  ["ops", "_", Buffer.from(JSON.stringify({ signInAddress: host, email: `${name}@example.test` })).toString("base64")].join("");

/** The SDK's error for a rate limit, by its class's name. */
export class RateLimitExceededError extends Error {}

/** The SDK's error for a session that expired, by its class's name. */
export class AuthExpiredError extends Error {}

/** The SDK's message for a token it does not accept. */
export const REJECTED_TOKEN_MESSAGE = "invalid service account token, please make sure you provide a valid service account token as parameter: authentication failed";

/** The SDK's message for a call the service account has no permission for. */
export const NO_PERMISSION_MESSAGE = "you don't have the right permissions to access this resource";

export interface FakeField {
  readonly id: string;
  readonly title: string;
  readonly concealed: boolean;
  readonly value: string;
}

export interface FakeItem {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly notes: string;
  readonly fields: FakeField[];
}

export interface FakeVault {
  readonly id: string;
  readonly title: string;
  readonly items: FakeItem[];
  /** Whether the service account may only read it: a write is refused. */
  readOnly: boolean;
}

/** The calls the provider makes through the seam. */
export type FakeOnePasswordCall = "signIn" | "vaults" | "items" | "item" | "resolve" | "create" | "setField";

export interface FakeOnePassword {
  readonly sdk: OnePasswordSdk;
  /** Accepts `token` at sign-in from now on. */
  accept(token: string): void;
  /** Refuses `token` from now on: at sign-in, and on every call of a session it made. */
  reject(token: string): void;
  /** Expires every session `token` made so far: their calls throw the SDK's expired-session error until it signs in again. */
  expire(token: string): void;
  /** Adds a vault titled `title`, each item's fields titled by `items`' keys, each concealed; answers it. */
  vault(title: string, items?: Readonly<Record<string, Readonly<Record<string, string>>>>): FakeVault;
  /** Throws `error` from the next call named `call`, once. */
  failNext(call: FakeOnePasswordCall, error: Error): void;
  /** Every call so far, in order, by name. */
  calls(): FakeOnePasswordCall[];
  readonly vaults: readonly FakeVault[];
}

/** An entry's id or title naming it, as `op://` references and the provider name them. */
const naming = <T extends OnePasswordEntry>(entries: readonly T[], name: string): T | undefined => entries.find((entry) => entry.title === name) ?? entries.find((entry) => entry.id === name);

export const fakeOnePassword = (): FakeOnePassword => {
  const accepted = new Set<string>();
  const epochs = new Map<string, number>();
  const vaults: FakeVault[] = [];
  const failures = new Map<FakeOnePasswordCall, Error[]>();
  const calls: FakeOnePasswordCall[] = [];

  /** Records the call, and throws the failure scripted for it, if any. */
  const called = (call: FakeOnePasswordCall): void => {
    calls.push(call);
    const failure = failures.get(call)?.shift();
    if (failure !== undefined) throw failure;
  };

  const vaultById = (id: string): FakeVault => {
    const found = vaults.find((vault) => vault.id === id);
    if (found === undefined) throw new Error("resource not found");
    return found;
  };

  const itemById = (vault: FakeVault, id: string): FakeItem => {
    const found = vault.items.find((item) => item.id === id);
    if (found === undefined) throw new Error("resource not found");
    return found;
  };

  const writable = (vault: FakeVault): FakeVault => {
    if (vault.readOnly) throw new Error(NO_PERMISSION_MESSAGE);
    return vault;
  };

  const titled = ({ id, title }: OnePasswordEntry): OnePasswordEntry => ({ id, title });

  const sessionFor = (token: string): OnePasswordSession => {
    const epoch = epochs.get(token) ?? 0;
    /** Records the call, refusing a token no longer accepted and a session expired since it was made. */
    const live = (call: FakeOnePasswordCall): void => {
      called(call);
      if (!accepted.has(token)) throw new Error("you are not authenticated");
      if ((epochs.get(token) ?? 0) !== epoch) throw new AuthExpiredError("the session expired: sign in again");
    };
    return {
      vaults: async () => {
        live("vaults");
        return vaults.map(titled);
      },
      items: async (vaultId) => {
        live("items");
        return vaultById(vaultId).items.map(titled);
      },
      item: async (vaultId, itemId) => {
        live("item");
        const item = itemById(vaultById(vaultId), itemId);
        return { id: item.id, title: item.title, fields: item.fields.map(titled) };
      },
      resolve: async (reference) => {
        live("resolve");
        const [vaultName = "", itemName = "", fieldName = ""] = reference.replace(/^op:\/\//, "").split("/");
        const vault = naming(vaults, vaultName);
        if (vault === undefined) throw new Error("error resolving secret reference: no vault matched the secret reference query");
        const item = naming(vault.items, itemName);
        if (item === undefined) throw new Error("error resolving secret reference: no item matched the secret reference query");
        const field = naming(item.fields, fieldName);
        if (field === undefined) throw new Error("error resolving secret reference: the specified field cannot be found within the item");
        return field.value;
      },
      create: async (vaultId, { title, notes, field, value }) => {
        live("create");
        writable(vaultById(vaultId)).items.push({ id: randomUUID(), title, category: "ApiCredentials", notes, fields: [{ id: field, title: field, concealed: true, value }] });
      },
      setField: async (vaultId, itemId, title, value) => {
        live("setField");
        const item = itemById(writable(vaultById(vaultId)), itemId);
        const index = item.fields.findIndex((field) => field.title === title);
        const field = { id: index < 0 ? title : (item.fields[index]?.id ?? title), title, concealed: true, value };
        if (index < 0) item.fields.push(field);
        else item.fields[index] = field;
      },
    };
  };

  return {
    sdk: {
      async signIn(token) {
        called("signIn");
        if (!accepted.has(token)) throw new Error(REJECTED_TOKEN_MESSAGE);
        return sessionFor(token);
      },
    },
    accept: (token) => void accepted.add(token),
    reject: (token) => void accepted.delete(token),
    expire: (token) => void epochs.set(token, (epochs.get(token) ?? 0) + 1),
    vault(title, items = {}) {
      const vault: FakeVault = {
        id: randomUUID(),
        title,
        readOnly: false,
        items: Object.entries(items).map(([itemTitle, fields]) => ({
          id: randomUUID(),
          title: itemTitle,
          category: "Login",
          notes: "",
          fields: Object.entries(fields).map(([fieldTitle, value]) => ({ id: randomUUID(), title: fieldTitle, concealed: true, value })),
        })),
      };
      vaults.push(vault);
      return vault;
    },
    failNext(call, error) {
      failures.set(call, [...(failures.get(call) ?? []), error]);
    },
    calls: () => [...calls],
    vaults,
  };
};
