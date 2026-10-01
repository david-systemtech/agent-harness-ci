/** The official SDK behind a loadable seam. No state file or secret cache is used. */
export interface BitwardenSecret {
  readonly id: string;
  readonly key: string;
  readonly value: string;
  readonly projectId?: string | null;
  readonly note?: string;
}
export interface BitwardenSdk {
  login(token: string): Promise<void>;
  projects(): Promise<readonly { id: string; name: string }[]>;
  identifiers(projectId?: string): Promise<readonly { id: string; key: string }[]>;
  get(id: string): Promise<BitwardenSecret>;
  create(projectId: string, key: string, value: string, note: string): Promise<BitwardenSecret>;
  update(secret: BitwardenSecret, value: string, note: string): Promise<BitwardenSecret>;
}
export type BitwardenSdkLoader = (address: string) => Promise<BitwardenSdk>;

/** Cloud API/identity hosts differ from the vault host; a self-host uses /api and /identity. */
export const bitwardenUrls = (address: string): { apiUrl: string; identityUrl: string } => {
  const url = new URL(address);
  if (["vault.bitwarden.com", "vault.bitwarden.eu"].includes(url.hostname)) {
    const region = url.hostname.endsWith(".eu") ? "eu" : "com";
    return { apiUrl: `https://api.bitwarden.${region}`, identityUrl: `https://identity.bitwarden.${region}` };
  }
  return { apiUrl: `${url.origin}/api`, identityUrl: `${url.origin}/identity` };
};

export const loadBitwardenSdk: BitwardenSdkLoader = async (address) => {
  const { BitwardenClient } = await import("@bitwarden/sdk-napi");
  new BitwardenClient({ ...bitwardenUrls(address), userAgent: "agent-harness" }, 4);
  // sdk-napi 1.0 requires an organization id for list/create but does not
  // expose the authenticated machine account's organization. Do not guess
  // an id, decode a credential or persist/decrypt an SDK state file to find
  // it. A capable SDK must expose the Rust client's discovery operation.
  throw new Error("The official Node SDK does not expose the access token's organization id required to list projects (sdk-napi 1.0.0; follow-up #1122).");
};
