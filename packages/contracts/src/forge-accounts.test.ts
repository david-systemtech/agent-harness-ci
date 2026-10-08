import { describe, expect, it } from "vitest";
import {
  CAPABILITY_FLAG_LIST,
  ENVIRONMENT_NOTICE_TYPES,
  EnvironmentNotice,
  FORGE_CAPABILITIES,
  FORGE_EVENT_PAYLOADS,
  ForgeAccountRecord,
  ForgeCredentialSource,
  GH_MINIMUM_VERSION,
  UNKNOWN_FORGE_CAPABILITIES,
  ForgeCapabilities,
  ForgeUnreachableError,
  KindUnsupportedError,
  NotAForgeError,
  NotAPullRequestError,
  eventTypeEntry,
  forgeCopyCredential,
  forgeTokenPages,
  methods,
  registry,
} from "./index.js";

/**
 * The forge account record, its events and its methods (forge spec, "The
 * forge account record", "Wire methods" and "Events"; ADR 0020): the scopes,
 * what the add takes, and that the record and the events never carry a
 * token.
 */

const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const forgeAccountId = "5b1c6f3e-2a4d-4e8f-9b0a-1c2d3e4f5a6b";
const pasted = { kind: "stored", provenance: "pasted", token: "token-for-tests" } as const;
const connectionId = "9b2f4c1e-3d5a-4b6c-8d7e-0f1a2b3c4d5e";
const reference = { kind: "reference", reference: { provider: "openbao", connectionId, mount: "personal", path: "harness/forge-github", key: "token" } } as const;
const copiedFrom = { environmentId: "1b4e28ba-2fa1-41d2-883f-0016d3cca427", environmentName: "SAMPLE-SERVER" };

describe("the forge account methods", () => {
  it("have one scope each: the list, the gh probe, the owners and a session's pull requests' refresh at read, add, update, remove and setPrimary as admin commands, verify and detect admin queries, and a session's pull request linked and unlinked at sessions:write", () => {
    const owned = methods.filter((m) => m.name.startsWith("forge."));
    expect(Object.fromEntries(owned.map((m) => [m.name, [m.kind, m.scope]]))).toEqual({
      "forge.accounts.list": ["query", "read"],
      "forge.accounts.add": ["command", "admin"],
      "forge.accounts.update": ["command", "admin"],
      "forge.accounts.remove": ["command", "admin"],
      "forge.accounts.setPrimary": ["command", "admin"],
      "forge.accounts.verify": ["query", "admin"],
      "forge.gh.probe": ["query", "read"],
      // The environment calls an address the caller chose.
      "forge.detect": ["query", "admin"],
      "forge.orgs.list": ["query", "read"],
      "forge.pullRequests.link": ["command", "sessions:write"],
      "forge.pullRequests.unlink": ["command", "sessions:write"],
      "forge.pullRequests.refresh": ["query", "read"],
    });
  });

  it("link and unlink take a session and a URL, answering its summary, and refresh takes a session, answering its pull requests", () => {
    const sessionId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const url = "https://git.systemtech.dev:5526/david/agent-harness/pulls/309";
    for (const name of ["forge.pullRequests.link", "forge.pullRequests.unlink"] as const) {
      const params = registry[name].params;
      expect(params.safeParse({ commandId, sessionId, url }).success, name).toBe(true);
      expect(params.safeParse({ commandId, sessionId, url: "" }).success, name).toBe(false);
      expect(params.safeParse({ commandId, url }).success, name).toBe(false);
      expect(params.safeParse({ sessionId, url }).success, name).toBe(false);
      expect(registry[name].result.safeParse({ summary: {} }).success, name).toBe(false);
    }
    const refresh = registry["forge.pullRequests.refresh"];
    expect(refresh.params.safeParse({ sessionId }).success).toBe(true);
    expect(refresh.params.safeParse({}).success).toBe(false);
    expect(refresh.result.safeParse({ pullRequests: [{ url, state: "merged", mergedAt: "2026-09-24T01:02:03.456Z", closedAt: "2026-09-24T01:02:03.456Z" }] }).success).toBe(true);
    expect(refresh.result.safeParse({ pullRequests: [{ url, state: "draft", mergedAt: null, closedAt: null }] }).success).toBe(false);
  });

  it("detect takes a URL in any form and answers the origin, the kind, the version and the token pages, never GitLab's reserved kind", () => {
    const detect = registry["forge.detect"];
    expect(detect.params.safeParse({ url: "git@git.systemtech.dev:david/agent-harness.git" }).success).toBe(true);
    expect(detect.params.safeParse({ url: "" }).success).toBe(false);
    expect(detect.params.safeParse({}).success).toBe(false);
    const detected = { origin: "https://git.systemtech.dev:5526", kind: "forgejo", version: "16.0.3+gitea-1.22.0", tokenPages: forgeTokenPages("forgejo", "https://git.systemtech.dev:5526") };
    expect(detect.result.safeParse(detected).success).toBe(true);
    expect(detect.result.safeParse({ ...detected, version: null }).success).toBe(true);
    expect(detect.result.safeParse({ ...detected, kind: "gitlab" }).success).toBe(false);
    expect(detect.result.safeParse({ ...detected, tokenPages: [] }).success).toBe(false);
    expect(detect.result.safeParse({ ...detected, origin: "https://git.systemtech.dev:5526/" }).success).toBe(false);
  });

  it("orgs.list takes a forge account and answers its owners, each a user or an organisation by login", () => {
    const orgs = registry["forge.orgs.list"];
    expect(orgs.params.safeParse({ forgeAccountId }).success).toBe(true);
    expect(orgs.params.safeParse({}).success).toBe(false);
    const owners = [
      { login: "david", kind: "user" },
      { login: "exampleorg", kind: "organisation" },
    ];
    expect(orgs.result.safeParse({ owners }).success).toBe(true);
    expect(orgs.result.safeParse({ owners: [{ login: "", kind: "user" }] }).success).toBe(false);
    expect(orgs.result.safeParse({ owners: [{ login: "exampleorg", kind: "organization" }] }).success).toBe(false);
  });

  it("verify takes one forge account or none, for every one, and answers the records", () => {
    const verify = registry["forge.accounts.verify"];
    expect(verify.params.safeParse({}).success).toBe(true);
    expect(verify.params.safeParse({ forgeAccountId }).success).toBe(true);
    expect(verify.params.safeParse({ forgeAccountId: "github" }).success).toBe(false);
    expect(verify.result.safeParse({ accounts: [] }).success).toBe(true);
    expect(verify.result.safeParse({}).success).toBe(false);
  });

  it("add and update take aliases, each a URL in any form whose origin is kept", () => {
    const add = registry["forge.accounts.add"].params;
    const update = registry["forge.accounts.update"].params;
    const aliases = ["http://100.101.102.103:3000", "git.systemtech.lan:3000/david/agent-harness"];
    expect(add.safeParse({ commandId, forgeAccountId, url: "https://git.systemtech.dev:5526", kind: "forgejo", credential: pasted, aliases }).success).toBe(true);
    expect(update.safeParse({ commandId, forgeAccountId, aliases }).success).toBe(true);
    expect(update.safeParse({ commandId, forgeAccountId, aliases: [] }).success).toBe(true);
    for (const bad of [[""], "http://100.101.102.103:3000", Array.from({ length: 17 }, (_, at) => `http://10.0.0.${at}:3000`)]) {
      expect(update.safeParse({ commandId, forgeAccountId, aliases: bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("add takes an id, a URL in any form, a kind that may be left out, a slug under the slug rule, a primary flag and a credential", () => {
    const add = registry["forge.accounts.add"].params;
    const base = { commandId, forgeAccountId, url: "https://github.com", credential: pasted };
    expect(add.safeParse(base).success).toBe(true);
    expect(add.safeParse({ ...base, url: "git@git.systemtech.dev:david/agent-harness.git", kind: "forgejo", slug: "work", primary: false }).success).toBe(true);
    expect(add.safeParse({ ...base, kind: "gitea" }).success).toBe(true);
    // GitLab is milestone 2's (ADR 0033), and a slug outside 1 to 40 of a-z, digits and underscore is refused.
    expect(add.safeParse({ ...base, kind: "gitlab" }).success).toBe(false);
    for (const slug of ["", "Work", "git-example", "x".repeat(41)]) expect(add.safeParse({ ...base, slug }).success, slug).toBe(false);
    expect(add.safeParse({ ...base, credential: { ...pasted, token: "two words" } }).success).toBe(false);
    expect(add.safeParse({ ...base, credential: undefined }).success).toBe(false);
  });

  it("take every credential source a client can give: a paste, its own gh's token, the environment's gh for a login, a reference, and none for a copy", () => {
    const add = registry["forge.accounts.add"].params;
    const update = registry["forge.accounts.update"].params;
    const base = { commandId, forgeAccountId, url: "https://github.com" };
    for (const credential of [pasted, { ...pasted, provenance: "client-gh" }, { kind: "gh", login: "david" }, reference]) {
      expect(add.safeParse({ ...base, credential }).success, credential.kind).toBe(true);
      expect(update.safeParse({ commandId, forgeAccountId, credential }).success, credential.kind).toBe(true);
    }
    expect(add.safeParse({ ...base, credential: { kind: "none" }, copiedFrom }).success).toBe(true);
    // None is only ever what a forge account starts with; a client never replaces a credential with it.
    expect(update.safeParse({ commandId, forgeAccountId, credential: { kind: "none" } }).success).toBe(false);
    // Imported is the state import's, in process; oauth is a device flow's, on the environment: no client sends either.
    for (const provenance of ["imported", "oauth"]) expect(add.safeParse({ ...base, credential: { ...pasted, provenance } }).success, provenance).toBe(false);
    // A login goes on gh's command line: one that reads as an option is refused.
    expect(add.safeParse({ ...base, credential: { kind: "gh", login: "--hostname" } }).success).toBe(false);
  });

  it("errors with verification_failed, alias_identity_mismatch and a reference's refusals on add and update, identity_mismatch on update alone, and detection's three on add and detect", () => {
    const own = (name: "forge.accounts.add" | "forge.accounts.update" | "forge.detect" | "forge.orgs.list" | "forge.pullRequests.link" | "forge.pullRequests.unlink" | "forge.pullRequests.refresh") =>
      registry[name].errors.map((member) => member.shape.code.value);
    expect(own("forge.accounts.add")).toEqual([
      "verification_failed",
      "alias_identity_mismatch",
      "credential_source_unavailable",
      "reference_not_found",
      "reference_denied",
      "provider_unavailable",
      "kind_unsupported",
      "not_a_forge",
      "unreachable",
    ]);
    expect(own("forge.accounts.update")).toEqual(["verification_failed", "identity_mismatch", "alias_identity_mismatch", "credential_source_unavailable", "reference_not_found", "reference_denied", "provider_unavailable"]);
    expect(own("forge.detect")).toEqual(["kind_unsupported", "not_a_forge", "unreachable"]);
    expect(own("forge.orgs.list")).toEqual(["credential_unavailable", "verification_failed", "unreachable"]);
    expect(own("forge.pullRequests.link")).toEqual(["not_a_pull_request", "forge_account_missing", "credential_unavailable", "verification_failed", "unreachable"]);
    expect(own("forge.pullRequests.unlink")).toEqual([]);
    expect(own("forge.pullRequests.refresh")).toEqual([]);
  });

  it("name the origin a URL no provider reads as a pull request is on, when it names one", () => {
    expect(NotAPullRequestError.safeParse({ code: "not_a_pull_request", message: "m", data: { origin: "https://github.com" } }).success).toBe(true);
    expect(NotAPullRequestError.safeParse({ code: "not_a_pull_request", message: "m", data: { origin: null } }).success).toBe(true);
    expect(NotAPullRequestError.safeParse({ code: "not_a_pull_request", message: "m", data: { origin: "github.com" } }).success).toBe(false);
    expect(NotAPullRequestError.safeParse({ code: "not_a_pull_request", message: "m", data: {} }).success).toBe(false);
  });

  it("name the forge in detection's errors: GitLab by its reserved kind, an address that is no forge and one that does not answer by origin", () => {
    const origin = "https://gitlab.com";
    expect(KindUnsupportedError.safeParse({ code: "kind_unsupported", message: "m", data: { origin, kind: "gitlab" } }).success).toBe(true);
    expect(KindUnsupportedError.safeParse({ code: "kind_unsupported", message: "m", data: { origin, kind: "bitbucket" } }).success).toBe(false);
    expect(NotAForgeError.safeParse({ code: "not_a_forge", message: "m", data: { origin: "https://example.com" } }).success).toBe(true);
    expect(NotAForgeError.safeParse({ code: "not_a_forge", message: "m", data: { origin: "example.com" } }).success).toBe(false);
    expect(ForgeUnreachableError.safeParse({ code: "unreachable", message: "m", data: { origin } }).success).toBe(true);
    expect(ForgeUnreachableError.safeParse({ code: "unreachable", message: "m", data: {} }).success).toBe(false);
  });

  it("probe gh against the minimum 2.40, the first whose gh auth token takes a user", () => {
    expect(GH_MINIMUM_VERSION).toBe("2.40.0");
  });
});

describe("the forge account record", () => {
  it("has the fields ADR 0020 names, the variables it injects beside them, and no field for a secret", () => {
    expect(Object.keys(ForgeAccountRecord.shape)).toEqual([
      "id",
      "origin",
      "aliases",
      "kind",
      "slug",
      "identity",
      "credential",
      "capabilities",
      "primary",
      "problem",
      "statusSince",
      "tokenInformation",
      "variables",
      "createdAt",
      "copiedFrom",
    ]);
  });

  it("holds a stored credential by its vault entry, and drops a token handed to it", () => {
    const entry = `forge:${forgeAccountId}:${commandId}`;
    expect(ForgeCredentialSource.parse({ kind: "stored", provenance: "pasted", entry, token: "token-for-tests" })).toEqual({ kind: "stored", provenance: "pasted", entry });
    expect(ForgeCredentialSource.safeParse(pasted).success).toBe(false);
  });

  it("says a token a client's gh handed over came from that client session and does not follow gh's rotations", () => {
    const entry = `forge:${forgeAccountId}:${commandId}`;
    const handedOverBy = { clientSessionId: commandId, label: "David's laptop" };
    expect(ForgeCredentialSource.safeParse({ kind: "stored", provenance: "client-gh", entry }).success).toBe(false);
    expect(ForgeCredentialSource.safeParse({ kind: "stored", provenance: "client-gh", entry, handedOverBy, followsGhRotations: true }).success).toBe(false);
    expect(ForgeCredentialSource.parse({ kind: "stored", provenance: "client-gh", entry, handedOverBy, followsGhRotations: false })).toMatchObject({ handedOverBy, followsGhRotations: false });
  });

  it("starts every capability unknown, for a forge account nothing has probed or used", () => {
    expect(ForgeCapabilities.parse(UNKNOWN_FORGE_CAPABILITIES)).toEqual(Object.fromEntries(FORGE_CAPABILITIES.map((name) => [name, { state: "unknown", verifiedAt: null, status: null }])));
  });
});

describe("a copy's credential", () => {
  it("is a gh source as gh, a reference as it is, and none for a stored token or none, since no secret travels between environments", () => {
    const entry = `forge:${forgeAccountId}:${commandId}`;
    expect(forgeCopyCredential({ kind: "gh", login: "david" })).toEqual({ kind: "gh", login: "david" });
    expect(forgeCopyCredential(reference)).toEqual(reference);
    for (const provenance of ["pasted", "imported", "oauth"] as const) expect(forgeCopyCredential({ kind: "stored", provenance, entry })).toEqual({ kind: "none" });
    expect(
      forgeCopyCredential({ kind: "stored", provenance: "client-gh", entry, handedOverBy: { clientSessionId: commandId, label: "laptop" }, followsGhRotations: false }),
    ).toEqual({ kind: "none" });
    expect(forgeCopyCredential({ kind: "none" })).toEqual({ kind: "none" });
  });
});

describe("the forge events", () => {
  it("are the nine on the environment stream, none in the session list, each a notice environment.subscribe carries", () => {
    expect(Object.keys(FORGE_EVENT_PAYLOADS)).toEqual([
      "forge.account.added",
      "forge.account.updated",
      "forge.account.primary-set",
      "forge.account.verified",
      "forge.account.capability-learned",
      "forge.account.git-rejected",
      "forge.account.removed",
      "forge.origin-missing",
      "forge.origin-answered",
    ]);
    for (const type of Object.keys(FORGE_EVENT_PAYLOADS)) {
      expect(ENVIRONMENT_NOTICE_TYPES, type).toContain(type);
      expect(eventTypeEntry("environment", type)?.list, type).toBe(false);
    }
    const notice = { type: "forge.account.primary-set", payload: { forgeAccountId, cleared: null } };
    expect(EnvironmentNotice.parse(notice)).toEqual(notice);
    expect(EnvironmentNotice.safeParse({ type: "forge.account.removed", payload: {} }).success).toBe(false);
  });
});

describe("the forge capability flag", () => {
  it("is on the flag list, for hello and the discovery document", () => {
    expect(CAPABILITY_FLAG_LIST).toContain("forge");
  });
});
