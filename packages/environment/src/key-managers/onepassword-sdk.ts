import { PRODUCT_NAME } from "@agent-harness/contracts";

/**
 * The seam the 1Password provider reaches 1Password through (key-managers
 * spec, "Providers"; #378): its official JavaScript SDK, `@1password/sdk`,
 * signed in with a service-account token. The provider's rules
 * (`onepassword.ts`) sit above it, and the in-process environment's tests
 * give a scripted double in its place, so no test reaches 1Password.
 *
 * The SDK is loaded on the first sign-in, never at the environment's start:
 * its core is a WebAssembly module of some 14 MB, which an environment with
 * no 1Password connection never needs. Its failures are thrown as the SDK
 * throws them (an `Error`, or its `RateLimitExceededError` and
 * `AuthExpiredError`), and the provider sorts them into its categories.
 */

/** A vault or an item as 1Password lists it: its id and its title, never what it holds. */
export interface OnePasswordEntry {
  readonly id: string;
  readonly title: string;
}

/** An item with its fields' ids and titles, never their values. */
export interface OnePasswordItem extends OnePasswordEntry {
  readonly fields: readonly OnePasswordEntry[];
}

/** An item a Move creates: its title, its notes, and one concealed field holding the value. */
export interface OnePasswordNewItem {
  readonly title: string;
  readonly notes: string;
  /** The concealed field's title, which is its id too. */
  readonly field: string;
  readonly value: string;
}

/** What one service-account token signed in to: every call goes through it, with the token's access. */
export interface OnePasswordSession {
  /** The vaults the service account can see. */
  vaults(): Promise<readonly OnePasswordEntry[]>;
  /** The active items in the vault with id `vaultId`. */
  items(vaultId: string): Promise<readonly OnePasswordEntry[]>;
  /** The item `itemId` in the vault `vaultId`, with its fields' titles. */
  item(vaultId: string, itemId: string): Promise<OnePasswordItem>;
  /** The value an `op://` reference names. */
  resolve(reference: string): Promise<string>;
  /** Creates an API credential item in the vault, its one concealed field holding the value. */
  create(vaultId: string, item: OnePasswordNewItem): Promise<void>;
  /** Sets the field titled `field` on the item to `value`, adding it concealed when the item has none, and keeping everything else the item holds. */
  setField(vaultId: string, itemId: string, field: string, value: string): Promise<void>;
}

export interface OnePasswordSdk {
  /** Signs in with a service-account token: a session, or the SDK's failure thrown. */
  signIn(token: string): Promise<OnePasswordSession>;
}

/** The official SDK, which names the harness and its version to 1Password as the integration making each call. */
export const officialOnePasswordSdk = (integrationVersion: string): OnePasswordSdk => ({
  async signIn(token) {
    const sdk = await import("@1password/sdk");
    const client = await sdk.createClient({ auth: token, integrationName: PRODUCT_NAME, integrationVersion });
    const titled = ({ id, title }: OnePasswordEntry): OnePasswordEntry => ({ id, title });
    return {
      vaults: async () => (await client.vaults.list()).map(titled),
      items: async (vaultId) => (await client.items.list(vaultId)).map(titled),
      async item(vaultId, itemId) {
        const item = await client.items.get(vaultId, itemId);
        return { id: item.id, title: item.title, fields: item.fields.map(titled) };
      },
      resolve: (reference) => client.secrets.resolve(reference),
      async create(vaultId, { title, notes, field, value }) {
        await client.items.create({
          category: sdk.ItemCategory.ApiCredentials,
          vaultId,
          title,
          notes,
          fields: [{ id: field, title: field, fieldType: sdk.ItemFieldType.Concealed, value }],
        });
      },
      async setField(vaultId, itemId, field, value) {
        const item = await client.items.get(vaultId, itemId);
        const held = item.fields.some((each) => each.title === field);
        const fields = held
          ? item.fields.map((each) => (each.title === field ? { ...each, value } : each))
          : [...item.fields, { id: field, title: field, fieldType: sdk.ItemFieldType.Concealed, value }];
        await client.items.put({ ...item, fields });
      },
    };
  },
});
