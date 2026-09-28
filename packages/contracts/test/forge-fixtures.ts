/**
 * Fixtures for the forge schemas and methods (forge spec; ADR 0020): a valid
 * and an invalid instance of every forge schema the export writes, the
 * record, its event payloads and its errors among them, and params and
 * results for the forge account methods. `fixtures.ts` folds them into the
 * package's fixture table.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const forgeAccountId = "5b1c6f3e-2a4d-4e8f-9b0a-1c2d3e4f5a6b";
const otherId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const environmentId = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const at = "2026-09-24T01:02:03.456Z";
const origin = "https://git.systemtech.dev:5526";
const entry = `forge:${forgeAccountId}:${otherId}`;
const identity = { login: "david", userId: "42" };
const stored = { kind: "stored", provenance: "pasted", entry };
const pasted = { kind: "stored", provenance: "pasted", token: "token-for-tests" };
const handed = { kind: "stored", provenance: "client-gh", token: "token-for-tests" };
const handedOverBy = { clientSessionId: otherId, label: "David's laptop" };
const handedStored = { kind: "stored", provenance: "client-gh", entry, handedOverBy, followsGhRotations: false };
const gh = { kind: "gh", login: "david" };
const connectionId = "9b2f4c1e-3d5a-4b6c-8d7e-0f1a2b3c4d5e";
const openbao = { provider: "openbao", connectionId, mount: "personal", path: "harness/forge-github", key: "token" };
const doppler = { provider: "doppler", connectionId, name: "FORGE_GITHUB_TOKEN" };
const onepassword = { provider: "onepassword", connectionId, vault: "Harness", item: "forge-github", field: "credential" };
const bitwarden = { provider: "bitwarden", connectionId, secretId: otherId, key: "forge-github" };
const reference = { kind: "reference", reference: openbao };
const signedIn = { host: "github.com", login: "david", active: true, tokenKind: "oauth", scopes: ["gist", "read:org", "repo"] };
const probe = { installed: true, version: "2.63.2", minimum: "2.40.0", meetsMinimum: true, accounts: [signedIn, { ...signedIn, login: "david-work", active: false, tokenKind: "fine-grained", scopes: null }] };
const unknown = { state: "unknown", verifiedAt: null, status: null };
const capabilities = {
  readRepository: { state: "verified", verifiedAt: at, status: null },
  writeIssues: unknown,
  pullRequests: unknown,
  createRepository: { state: "failed", verifiedAt: null, status: 403 },
  readReleases: unknown,
};
const problem = { kind: "unreachable", since: at, message: "The forge at https://git.systemtech.dev:5526 answered HTTP 503." };
const tokenInformation = { kind: "fine-grained", scopes: null, expiresAt: at };
const variables = { url: ["FORGE_GIT_SYSTEMTECH_DEV_URL", "FORGE_URL"], token: ["FORGE_GIT_SYSTEMTECH_DEV_TOKEN", "FORGE_TOKEN"], kind: ["FORGE_GIT_SYSTEMTECH_DEV_KIND", "FORGE_KIND"] };
const record = {
  id: forgeAccountId,
  origin,
  aliases: [{ origin: "http://100.101.102.103:3000", verifiedAt: at }],
  kind: "forgejo",
  slug: "git_systemtech_dev",
  identity,
  credential: stored,
  capabilities,
  primary: true,
  problem: null,
  tokenInformation,
  variables,
  createdAt: at,
  copiedFrom: null,
};
const unreachableCopy = {
  ...record,
  aliases: [],
  identity: null,
  credential: { kind: "none" },
  primary: false,
  problem: { ...problem, kind: "needs-credential", message: "Give this forge account a credential." },
  tokenInformation: null,
  variables: { url: [], token: [], kind: [] },
  copiedFrom: { environmentId, environmentName: "SYSTEM-SERVER" },
};

const added = {
  forgeAccountId,
  origin,
  aliases: [],
  kind: "forgejo",
  slug: "git_systemtech_dev",
  identity,
  credential: stored,
  primary: true,
  clearedPrimary: null,
  problem: null,
  copiedFrom: null,
};

export const forgeSchemaFixtures: Record<string, Fixtures> = {
  "forge/kind.json": { valid: ["github", "forgejo", "gitea", "gitlab"], invalid: ["GitHub", "bitbucket", ""] },
  "forge/slug.json": {
    valid: ["github", "git_systemtech_dev", "100_101_102_103", "x".repeat(40)],
    invalid: ["", "x".repeat(41), "GitHub", "git-systemtech", "forge/work", ".."],
  },
  "forge/origin.json": {
    valid: ["https://github.com", "https://git.systemtech.dev:5526", "http://100.101.102.103:3000", "http://nas.lan:443", "http://[fd7a:115c:a1e0::1]:3000"],
    invalid: [
      "https://github.com/",
      "https://github.com:443",
      "http://nas.lan:80",
      "https://GitHub.com",
      "ssh://github.com",
      "https://x-access-token@github.com",
      "https://github.com/david/agent-harness",
      "https://github.com:0",
      "https://github.com:65536",
      "github.com",
      "",
    ],
  },
  "forge/account-id.json": { valid: [forgeAccountId], invalid: ["github", "", "c232ab00-9414-11ec-b3c8-9f6bdeced846"] },
  "forge/identity.json": { valid: [identity, { login: "x-bot", userId: "9007199254740993" }], invalid: [{ login: "david", userId: 42 }, { login: "", userId: "42" }, { login: "david", userId: "4 2" }, { login: "david" }] },
  "forge/alias.json": { valid: [{ origin, verifiedAt: null }, { origin, verifiedAt: at }], invalid: [{ origin: "git.systemtech.dev", verifiedAt: null }, { origin }] },
  "forge/stored-token-provenance.json": { valid: ["pasted", "client-gh", "imported", "oauth"], invalid: ["gh", "Pasted", ""] },
  "forge/vault-entry.json": { valid: [entry], invalid: ["token-for-tests", `forge:${forgeAccountId}`, `vault:${forgeAccountId}:${otherId}`, ""] },
  "forge/gh-login.json": { valid: ["david", "x-bot", "david_corp", "7"], invalid: ["", "-david", "da vid", "david\n", "x".repeat(101)] },
  "forge/handing-client.json": { valid: [handedOverBy], invalid: [{ clientSessionId: "", label: "laptop" }, { clientSessionId: otherId }] },
  "forge/credential-source.json": {
    valid: [gh, stored, { ...stored, provenance: "imported" }, { ...stored, provenance: "oauth" }, handedStored, reference, { kind: "reference", reference: bitwarden }, { kind: "none" }],
    invalid: [
      { kind: "gh" },
      { kind: "gh", login: "--user" },
      { kind: "stored", provenance: "pasted" },
      pasted,
      { kind: "stored", provenance: "typed", entry },
      { ...stored, provenance: "client-gh" },
      { ...handedStored, followsGhRotations: true },
      { kind: "reference" },
      { kind: "reference", reference: { ...openbao, connectionId: "vault" } },
      { kind: "keychain" },
      {},
    ],
  },
  "forge/token.json": { valid: ["token-for-tests", "token+for/tests=", "x"], invalid: ["", "two words", "trailing\n", "tökén", "x".repeat(4097)] },
  "forge/credential-input.json": {
    valid: [pasted, handed, gh, reference],
    invalid: [{ ...pasted, token: "" }, { ...pasted, provenance: "imported" }, { kind: "stored", provenance: "pasted" }, stored, { kind: "gh" }, { kind: "none" }, { kind: "reference", reference: {} }],
  },
  "forge/add-credential.json": {
    valid: [pasted, handed, gh, reference, { kind: "none" }],
    invalid: [{ ...pasted, provenance: "imported" }, { ...pasted, provenance: "oauth" }, handedStored, { kind: "gh", login: "" }, { kind: "reference", reference: null }, {}],
  },
  "forge/gh-signed-in-account.json": {
    valid: [signedIn, { ...signedIn, tokenKind: "classic", scopes: [] }, { ...signedIn, host: "ghe.example.com", tokenKind: "unknown", scopes: null }],
    invalid: [{ ...signedIn, login: "-x" }, { ...signedIn, tokenKind: "pat" }, { ...signedIn, scopes: "repo" }, { ...signedIn, active: undefined }],
  },
  "forge/gh-probe.json": {
    valid: [probe, { installed: false, version: null, minimum: "2.40.0", meetsMinimum: false, accounts: [] }, { ...probe, version: "2.39.2", meetsMinimum: false }],
    invalid: [{ ...probe, accounts: undefined }, { ...probe, version: "" }, { ...probe, installed: "yes" }, { ...probe, accounts: [{ ...signedIn, token: "token-for-tests", login: "" }] }],
  },
  "key-managers/provider.json": { valid: ["openbao", "doppler", "onepassword", "bitwarden"], invalid: ["vault", "1password", ""] },
  "key-managers/connection-id.json": { valid: [connectionId], invalid: ["openbao", "", "c232ab00-9414-11ec-b3c8-9f6bdeced846"] },
  "key-managers/openbao-reference.json": {
    valid: [openbao, { ...openbao, mount: "secret/team", path: "a/b/c" }],
    invalid: [{ ...openbao, mount: "/personal" }, { ...openbao, path: "harness//forge" }, { ...openbao, path: "harness/" }, { ...openbao, key: "" }, { ...openbao, key: "two\nlines" }, { ...openbao, connectionId: undefined }],
  },
  "key-managers/doppler-reference.json": {
    valid: [doppler, { ...doppler, project: "harness", config: "prd" }],
    invalid: [{ ...doppler, name: "forge_github_token" }, { ...doppler, name: "1TOKEN" }, { ...doppler, project: "" }],
  },
  "key-managers/onepassword-reference.json": { valid: [onepassword], invalid: [{ ...onepassword, field: undefined }, { ...onepassword, vault: "" }] },
  "key-managers/bitwarden-reference.json": { valid: [bitwarden], invalid: [{ ...bitwarden, secretId: "forge-github" }, { ...bitwarden, key: undefined }] },
  "key-managers/reference.json": {
    valid: [openbao, doppler, onepassword, bitwarden],
    invalid: [{ ...openbao, provider: "vault" }, { ...doppler, provider: "bitwarden" }, { provider: "openbao", connectionId }, {}],
  },
  "forge/capability-name.json": { valid: ["readRepository", "writeIssues", "pullRequests", "createRepository", "readReleases"], invalid: ["read_repository", "repo", ""] },
  "forge/capability-state.json": { valid: ["verified", "failed", "unknown"], invalid: ["passed", ""] },
  "forge/capability.json": { valid: [unknown, capabilities.readRepository, capabilities.createRepository], invalid: [{ state: "unknown" }, { ...unknown, status: "403" }, { ...unknown, state: "maybe" }] },
  "forge/capabilities.json": { valid: [capabilities], invalid: [{ ...capabilities, readReleases: undefined }, { ...capabilities, writeIssues: { state: "unknown" } }] },
  "forge/problem-kind.json": {
    valid: ["needs-credential", "credential-rejected", "credential-unavailable", "identity-changed", "unreachable", "expiring"],
    invalid: ["expired", "unreachable ", ""],
  },
  "forge/problem.json": { valid: [problem], invalid: [{ ...problem, message: "" }, { ...problem, message: "two\nlines" }, { ...problem, since: "now" }, { kind: "unreachable" }] },
  "forge/token-kind.json": { valid: ["classic", "fine-grained", "oauth", "unknown"], invalid: ["pat", ""] },
  "forge/token-information.json": {
    valid: [tokenInformation, { kind: "classic", scopes: ["repo", "read:org"], expiresAt: null }, { kind: "unknown", scopes: null, expiresAt: null }],
    invalid: [{ ...tokenInformation, scopes: "repo" }, { ...tokenInformation, scopes: [""] }, { kind: "fine-grained", scopes: null }],
  },
  "forge/copied-from.json": { valid: [{ environmentId, environmentName: "SYSTEM-SERVER" }], invalid: [{ environmentId: "laptop", environmentName: "laptop" }, { environmentId, environmentName: "" }] },
  "forge/variables.json": { valid: [variables, { url: [], token: [], kind: [] }], invalid: [{ url: [], token: [] }, { ...variables, token: [""] }] },
  "forge/account-record.json": {
    valid: [record, unreachableCopy],
    invalid: [
      { ...record, credential: pasted },
      { ...record, origin: "https://git.systemtech.dev:5526/" },
      { ...record, slug: "Git" },
      { ...record, primary: "yes" },
      { ...record, variables: undefined },
      { id: forgeAccountId },
    ],
  },
  "forge/events/forge.account.added.json": {
    valid: [added, { ...added, identity: null, problem, primary: false }, { ...added, clearedPrimary: otherId }],
    invalid: [{ ...added, credential: pasted }, { ...added, clearedPrimary: undefined }, { forgeAccountId }],
  },
  "forge/events/forge.account.updated.json": {
    valid: [{ forgeAccountId }, { forgeAccountId, slug: "forgejo" }, { forgeAccountId, credential: stored, identity, problem: null }, { forgeAccountId, aliases: [] }],
    invalid: [{ forgeAccountId, slug: "Forgejo" }, { forgeAccountId, credential: pasted }, { slug: "forgejo" }],
  },
  "forge/events/forge.account.primary-set.json": {
    valid: [{ forgeAccountId, cleared: null }, { forgeAccountId, cleared: otherId }],
    invalid: [{ forgeAccountId }, { forgeAccountId, cleared: "none" }],
  },
  "forge/events/forge.account.verified.json": {
    valid: [{ forgeAccountId, identity, capabilities, tokenInformation, problem: null }, { forgeAccountId, identity: null, capabilities, tokenInformation: null, problem }],
    invalid: [{ forgeAccountId, identity, capabilities, tokenInformation }, { forgeAccountId, identity, capabilities: {}, tokenInformation, problem: null }],
  },
  "forge/events/forge.account.capability-learned.json": {
    valid: [{ forgeAccountId, capability: "writeIssues", state: "verified", operation: "open an issue", status: 201 }, { forgeAccountId, capability: "pullRequests", state: "failed", operation: "read a pull request", status: null }],
    invalid: [{ forgeAccountId, capability: "writeIssues", state: "unknown", operation: "open an issue", status: 201 }, { forgeAccountId, capability: "issues", state: "failed", operation: "x", status: 403 }],
  },
  "forge/events/forge.account.git-rejected.json": { valid: [{ forgeAccountId, origin }], invalid: [{ forgeAccountId }, { forgeAccountId, origin: "ssh://git.systemtech.dev" }] },
  "forge/events/forge.account.removed.json": { valid: [{ forgeAccountId }], invalid: [{}, { forgeAccountId: "github" }] },
  "forge/events/forge.origin-missing.json": { valid: [{ origin, operation: "clone a skill source" }], invalid: [{ origin }, { origin, operation: "" }] },
  "errors/verification_failed.json": {
    valid: [{ code: "verification_failed", message: "The forge refused the token.", data: { origin, status: 401 } }],
    invalid: [{ code: "verification_failed", message: "m", data: { origin } }, { code: "verification_failed", message: "m", data: { origin: "nowhere", status: 401 } }, { code: "identity_mismatch", message: "m", data: { origin, status: 401 } }],
  },
  "errors/credential_source_unavailable.json": {
    valid: [{ code: "credential_source_unavailable", message: "No key-manager connection holds this reference.", data: { connectionId } }],
    invalid: [{ code: "credential_source_unavailable", message: "m", data: {} }, { code: "credential_source_unavailable", message: "m", data: { connectionId: "openbao" } }],
  },
  "errors/identity_mismatch.json": {
    valid: [{ code: "identity_mismatch", message: "m", data: { forgeAccountId, expected: identity, found: { login: "someone", userId: "7" } } }],
    invalid: [{ code: "identity_mismatch", message: "m", data: { forgeAccountId, expected: identity } }, { code: "identity_mismatch", message: "m", data: {} }],
  },
};

/** Params and results for every forge account method. */
export const forgeMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "forge.accounts.list": {
    params: { valid: [{}], invalid: [[], "all"] },
    result: {
      valid: [{ accounts: [] }, { accounts: [record, unreachableCopy] }, { accounts: [{ ...record, credential: gh }, { ...record, credential: handedStored }, { ...record, credential: reference }] }],
      invalid: [{}, { accounts: [{ id: forgeAccountId }] }, { accounts: [{ ...record, credential: pasted }] }, { accounts: [{ ...record, credential: handed }] }],
    },
  },
  "forge.accounts.add": {
    params: {
      valid: [
        { commandId, forgeAccountId, url: "https://github.com", credential: pasted },
        { commandId, forgeAccountId, url: "git@git.systemtech.dev:david/agent-harness.git", kind: "forgejo", slug: "work", primary: true, credential: pasted },
        { commandId, forgeAccountId, url: "https://github.com", credential: gh },
        { commandId, forgeAccountId, url: "https://github.com", credential: handed },
        { commandId, forgeAccountId, url: origin, kind: "forgejo", credential: reference, copiedFrom: { environmentId, environmentName: "SYSTEM-SERVER" } },
        { commandId, forgeAccountId, url: origin, kind: "forgejo", primary: true, credential: { kind: "none" }, copiedFrom: { environmentId, environmentName: "SYSTEM-SERVER" } },
      ],
      invalid: [
        { commandId, forgeAccountId, url: "https://github.com", credential: { ...pasted, provenance: "imported" } },
        { commandId, forgeAccountId, url: "https://github.com", credential: { kind: "none" }, copiedFrom: { environmentId: "laptop", environmentName: "laptop" } },
        { commandId, forgeAccountId, url: "https://github.com" },
        { commandId, forgeAccountId, url: "", credential: pasted },
        { commandId, forgeAccountId, url: "https://gitlab.com", kind: "gitlab", credential: pasted },
        { commandId, forgeAccountId, url: "https://github.com", slug: "Work", credential: pasted },
        { commandId, forgeAccountId: "github", url: "https://github.com", credential: pasted },
        { forgeAccountId, url: "https://github.com", credential: pasted },
      ],
    },
    result: { valid: [{ account: record }], invalid: [{}, { account: { ...record, credential: pasted } }] },
  },
  "forge.accounts.update": {
    params: {
      valid: [
        { commandId, forgeAccountId },
        { commandId, forgeAccountId, slug: "work" },
        { commandId, forgeAccountId, credential: pasted },
        { commandId, forgeAccountId, credential: handed },
        { commandId, forgeAccountId, credential: gh },
        { commandId, forgeAccountId, credential: reference },
      ],
      invalid: [{ commandId }, { commandId, forgeAccountId, slug: "" }, { commandId, forgeAccountId, credential: stored }, { commandId, forgeAccountId, credential: { kind: "none" } }],
    },
    result: { valid: [{ account: record }], invalid: [{}, { account: null }] },
  },
  "forge.accounts.remove": {
    params: { valid: [{ commandId, forgeAccountId }], invalid: [{ commandId }, { forgeAccountId }] },
    result: { valid: [{ forgeAccountId }], invalid: [{}, { forgeAccountId: "" }] },
  },
  "forge.accounts.setPrimary": {
    params: { valid: [{ commandId, forgeAccountId }], invalid: [{ commandId }, { commandId, forgeAccountId: null }] },
    result: { valid: [{ account: record }], invalid: [{}, { account: { ...record, primary: 1 } }] },
  },
  "forge.gh.probe": {
    params: { valid: [{}], invalid: [[], "gh"] },
    result: { valid: [probe], invalid: [{}, { ...probe, meetsMinimum: undefined }] },
  },
};
