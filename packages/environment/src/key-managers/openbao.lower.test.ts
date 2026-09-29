import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { manualClock } from "../../test/clock.js";
import { UNREACHABLE_OPENBAO, startFakeOpenBao, testCertificates, type FakeOpenBao } from "../../test/fake-openbao.js";
import { PERSON_TOKEN, approle } from "../../test/key-manager-connections.js";
import { createOpenBaoProvider } from "./openbao.js";
import type { SignInTarget } from "./provider.js";

/**
 * The OpenBao provider against the fake OpenBao without the wire
 * (key-managers spec, "Testing Decisions"; #366): what a verification asks
 * and how it reads the answers, the write flag it reads from each policy's
 * text, and the categories every error falls into; a reference's read and a
 * path's list on KV version 1 and 2 mounts, the version detected per mount
 * from its UI endpoint (#370).
 */

const { onCleanup } = useCleanups();

const openBaoProvider = createOpenBaoProvider();

const fakeOpenBao = async (): Promise<FakeOpenBao> => {
  const clock = manualClock();
  const bao = await startFakeOpenBao({ now: () => clock.now() });
  onCleanup(() => bao.close());
  return bao;
};

const targetOf = (bao: FakeOpenBao, overrides: Partial<SignInTarget> = {}): SignInTarget => ({ address: bao.address, ca: bao.ca, method: "token", mount: "token", username: null, ...overrides });

/** A token on `bao` holding `policies`, and a verification of it. */
const verifying = async (bao: FakeOpenBao, policies: readonly string[], tokenRole: string | null = null) => {
  bao.token(PERSON_TOKEN, { policies });
  return openBaoProvider.verify(targetOf(bao), PERSON_TOKEN, { tokenRole });
};

/** A policy that lets its holder read every policy's text. */
const READS_POLICIES = `path "sys/policies/acl/*" { capabilities = ["read", "list"] }`;

describe("a verification", () => {
  it("reads the seal status, the token's own lookup, its capabilities on the token-create path and each policy's text, in that order", async () => {
    const bao = await fakeOpenBao();
    bao.policy("reader", READS_POLICIES);

    const answer = await verifying(bao, ["default", "reader"]);

    expect(answer).toEqual({
      outcome: "verified",
      information: { displayName: "token", policies: ["default", "reader"], ttlSeconds: 3600, renewable: true, expiresAt: "2026-09-24T01:00:00.000Z" },
      root: false,
      canMint: false,
      policies: [
        { name: "default", writes: "no" },
        { name: "reader", writes: "no" },
      ],
    });
    expect(bao.requests).toEqual([
      { method: "GET", path: "sys/seal-status" },
      { method: "GET", path: "auth/token/lookup-self" },
      { method: "POST", path: "sys/capabilities-self" },
      { method: "GET", path: "sys/policies/acl/default" },
      { method: "GET", path: "sys/policies/acl/reader" },
    ]);
  });

  it("can mint with update on the token-create path, the one operation OpenBao's ACL checks there, or on its token role's path when there is one", async () => {
    const bao = await fakeOpenBao();
    const grants = (path: string, capabilities: string) => `path "${path}" { capabilities = [${capabilities}] }`;
    const cases = [
      { text: grants("auth/token/create", `"create", "update"`), tokenRole: null, canMint: true },
      { text: grants("auth/token/create", `"update"`), tokenRole: null, canMint: true },
      { text: grants("auth/token/create", `"create"`), tokenRole: null, canMint: false },
      { text: grants("auth/token/*", `"create", "update", "sudo"`), tokenRole: null, canMint: true },
      { text: `${grants("auth/token/create", `"create", "update"`)}\n${grants("auth/token/create", `"deny"`)}`, tokenRole: null, canMint: false },
      { text: grants("auth/token/create", `"create", "update"`), tokenRole: "agent-runs", canMint: false },
      { text: grants("auth/token/create/agent-runs", `"update"`), tokenRole: "agent-runs", canMint: true },
      { text: "", tokenRole: null, canMint: false },
    ];
    for (const { text, tokenRole, canMint } of cases) {
      bao.policy("minter", text);
      const answer = await verifying(bao, ["default", "minter"], tokenRole);
      expect(answer.outcome === "verified" && answer.canMint, `${text} with role ${String(tokenRole)}`).toBe(canMint);
    }
  });

  it("answers sealed before asking anything else, and a refused lookup as the credential rejected", async () => {
    const bao = await fakeOpenBao();
    bao.seal();
    expect(await verifying(bao, ["default"])).toEqual({ outcome: "sealed", message: `OpenBao at ${bao.address} is sealed: unseal it to sign in.` });
    expect(bao.requests).toEqual([{ method: "GET", path: "sys/seal-status" }]);

    bao.unseal();
    expect(await openBaoProvider.verify(targetOf(bao), "token-nobody-gave-for-tests", { tokenRole: null })).toEqual({
      outcome: "credential-rejected",
      message: `OpenBao at ${bao.address} refused the credential (HTTP 403: permission denied).`,
    });
  });
});

describe("a policy's write flag", () => {
  const flagOf = async (text: string): Promise<string> => {
    const bao = await fakeOpenBao();
    bao.policy("reader", READS_POLICIES);
    bao.policy("subject", text);
    const answer = await verifying(bao, ["reader", "subject"]);
    if (answer.outcome !== "verified") throw new Error(JSON.stringify(answer));
    return answer.policies.find((policy) => policy.name === "subject")?.writes ?? "absent";
  };

  it("is yes when the text grants create, update, patch or delete on a path outside auth/, sys/, cubbyhole/ and identity/", async () => {
    for (const capability of ["create", "update", "patch", "delete"]) {
      expect(await flagOf(`path "personal/data/*" { capabilities = ["read", "${capability}"] }`), capability).toBe("yes");
    }
    // A pattern that does not start inside the key manager's own paths may reach outside them.
    expect(await flagOf(`path "*" { capabilities = ["update"] }`)).toBe("yes");
    expect(await flagOf(`path "+/data/harness" { capabilities = ["create"] }`)).toBe("yes");
  });

  it("is no when it grants reads alone, writes only inside auth/, sys/, cubbyhole/ and identity/, or denies", async () => {
    const own = `path "auth/token/create" { capabilities = ["create", "update"] }
path "sys/policies/acl/*" { capabilities = ["create", "update", "delete"] }
path "cubbyhole/*" { capabilities = ["create", "update", "delete"] }
path "identity/entity/*" { capabilities = ["update"] }`;
    expect(await flagOf(own)).toBe("no");
    expect(await flagOf(`path "personal/*" { capabilities = ["read", "list"] }`)).toBe("no");
    expect(await flagOf(`path "personal/*" { capabilities = ["deny", "update"] }`)).toBe("no");
    expect(await flagOf("")).toBe("no");
  });

  it("reads the capabilities the legacy policy parameter grants: write and sudo write, read and deny do not", async () => {
    expect(await flagOf(`path "personal/*" { policy = "write" }`)).toBe("yes");
    expect(await flagOf(`path "personal/*" { policy = "sudo" }`)).toBe("yes");
    expect(await flagOf(`path "personal/*" { policy = "read" }`)).toBe("no");
    expect(await flagOf(`path "personal/*" { policy = "deny" }`)).toBe("no");
    expect(await flagOf(`path "sys/policies/acl/*" { policy = "write" }`)).toBe("no");
    expect(await flagOf(JSON.stringify({ path: { "personal/*": { policy: "write" } } }))).toBe("yes");
  });

  it("reads the policy language with comments and nested parameters, and its JSON form", async () => {
    const hcl = `# Agents write their notes here.
// Nothing else is written.
/* path "personal/*" { capabilities = ["update"] } */
path "notes/*" {
  capabilities = ["create",
                  "read"]
  allowed_parameters = {
    "kind" = ["memo"]
  }
}`;
    expect(await flagOf(hcl)).toBe("yes");
    expect(await flagOf(hcl.replace(`"create",`, `"list",`))).toBe("no");
    expect(await flagOf(JSON.stringify({ path: { "notes/*": { capabilities: ["read", "patch"] } } }))).toBe("yes");
    expect(await flagOf(JSON.stringify({ path: [{ "notes/*": { capabilities: ["read"] } }, { "sys/*": { capabilities: ["update"] } }] }))).toBe("no");
  });

  it("is possibly when the login may not read the text, or the text is neither the language nor its JSON form", async () => {
    const bao = await fakeOpenBao();
    bao.policy("reader", `path "sys/policies/acl/reader" { capabilities = ["read"] }`);
    bao.policy("hidden", `path "personal/*" { capabilities = ["read"] }`);
    const answer = await verifying(bao, ["reader", "hidden", "missing"]);
    expect(answer.outcome === "verified" && answer.policies).toEqual([
      { name: "reader", writes: "no" },
      { name: "hidden", writes: "possibly" },
      { name: "missing", writes: "possibly" },
    ]);
    expect(await flagOf(`path "personal/*" { capabilities = ["update"]`)).toBe("possibly");
    expect(await flagOf(`{"path": "personal/*"`)).toBe("possibly");
  });
});

describe("the error categories", () => {
  it("are credential-rejected, unreachable, sealed, certificate-rejected, denied, not-found and rate-limited, each with one line", async () => {
    const bao = await fakeOpenBao();
    const target = targetOf(bao, { method: "approle", mount: "approle" });
    bao.policy("reader", `path "sys/policies/acl/reader" { capabilities = ["read"] }`);
    bao.token(PERSON_TOKEN, { policies: ["reader"] });

    const refusedLogin = await openBaoProvider.logIn(target, approle());
    expect(refusedLogin).toEqual({ outcome: "credential-rejected", message: `OpenBao at ${bao.address} refused the credential (HTTP 400: invalid role or secret ID).` });

    bao.answer("POST auth/approle/login", { status: 429, error: "request path \"auth/approle/login\": rate limit quota exceeded" });
    expect(await openBaoProvider.logIn(target, approle())).toEqual({
      outcome: "rate-limited",
      message: `OpenBao at ${bao.address} asked the harness to slow down (HTTP 429: request path "auth/approle/login": rate limit quota exceeded).`,
    });
    bao.answer("POST auth/approle/login", { status: 500, error: "internal error" });
    expect(await openBaoProvider.logIn(target, approle())).toEqual({ outcome: "unreachable", message: `OpenBao at ${bao.address} could not answer (HTTP 500: internal error).` });
    bao.answer("POST auth/approle/login", null);

    expect(await openBaoProvider.readPolicy(target, PERSON_TOKEN, "hidden")).toEqual({
      outcome: "denied",
      message: `OpenBao at ${bao.address} did not let the login read the policy hidden (HTTP 403: permission denied).`,
    });
    bao.policy("reader", READS_POLICIES);
    expect(await openBaoProvider.readPolicy(target, PERSON_TOKEN, "hidden")).toEqual({
      outcome: "not-found",
      message: `OpenBao at ${bao.address} found nothing to read the policy hidden (HTTP 404: no policy named: hidden).`,
    });

    bao.seal();
    expect(await openBaoProvider.logIn(target, approle())).toMatchObject({ outcome: "sealed" });
    expect(await openBaoProvider.readPolicy(target, PERSON_TOKEN, "reader")).toMatchObject({ outcome: "sealed" });
    bao.unseal();

    expect(await openBaoProvider.lookUp({ ...target, address: UNREACHABLE_OPENBAO }, PERSON_TOKEN)).toMatchObject({ outcome: "unreachable" });
    expect(await openBaoProvider.lookUp({ ...target, ca: testCertificates().otherCa }, PERSON_TOKEN)).toMatchObject({ outcome: "certificate-rejected" });
    expect(await openBaoProvider.lookUp(target, PERSON_TOKEN)).toMatchObject({ outcome: "found" });
  });
});

describe("a reference's read", () => {
  const V2_VALUE = "value-in-version-2-for-tests";
  const V1_VALUE = "value-in-version-1-for-tests";

  /** A fake OpenBao with a KV version 2 mount `personal` and a version 1 mount `legacy`, each holding a secret, and the test's token reading both. */
  const withSecrets = async (text = `path "personal/data/*" { capabilities = ["read"] }\npath "legacy/*" { capabilities = ["read"] }`) => {
    const bao = await fakeOpenBao();
    bao.kv("personal", 2);
    bao.kv("legacy", 1);
    bao.secret("personal", "harness/forge-github", { token: V2_VALUE, note: "the forge's token" });
    bao.secret("legacy", "forge", { token: V1_VALUE });
    bao.policy("reader", text);
    bao.token(PERSON_TOKEN, { policies: ["default", "reader"] });
    return bao;
  };

  const personal = { provider: "openbao", connectionId: "9b2f4c1e-3d5a-4b6c-8d7e-0f1a2b3c4d5e", mount: "personal", path: "harness/forge-github", key: "token" } as const;
  const legacy = { ...personal, mount: "legacy", path: "forge" } as const;

  it("reads a version 2 mount's secret under data/ and a version 1 mount's at its path, asking each mount's UI endpoint once for the provider's life", async () => {
    const bao = await withSecrets();
    const provider = createOpenBaoProvider();

    expect(await provider.read(targetOf(bao), PERSON_TOKEN, personal)).toEqual({ outcome: "read", value: V2_VALUE });
    expect(await provider.read(targetOf(bao), PERSON_TOKEN, legacy)).toEqual({ outcome: "read", value: V1_VALUE });
    expect(await provider.read(targetOf(bao), PERSON_TOKEN, personal)).toEqual({ outcome: "read", value: V2_VALUE });
    expect(await provider.read(targetOf(bao), PERSON_TOKEN, legacy)).toEqual({ outcome: "read", value: V1_VALUE });

    expect(bao.requests).toEqual([
      { method: "GET", path: "sys/internal/ui/mounts/personal" },
      { method: "GET", path: "personal/data/harness/forge-github" },
      { method: "GET", path: "sys/internal/ui/mounts/legacy" },
      { method: "GET", path: "legacy/forge" },
      { method: "GET", path: "personal/data/harness/forge-github" },
      { method: "GET", path: "legacy/forge" },
    ]);
  });

  it("reads the value as it is now: a rotated secret answers its new value, nothing of the old one kept", async () => {
    const bao = await withSecrets();
    expect(await openBaoProvider.read(targetOf(bao), PERSON_TOKEN, personal)).toEqual({ outcome: "read", value: V2_VALUE });
    bao.secret("personal", "harness/forge-github", { token: "rotated-value-for-tests" });
    expect(await openBaoProvider.read(targetOf(bao), PERSON_TOKEN, personal)).toEqual({ outcome: "read", value: "rotated-value-for-tests" });
  });

  it("takes a mount whose UI endpoint the server does not have for version 1, as older servers answer", async () => {
    const bao = await withSecrets();
    bao.answer("GET sys/internal/ui/mounts/legacy", { status: 404, error: "unsupported path" });
    expect(await createOpenBaoProvider().read(targetOf(bao), PERSON_TOKEN, legacy)).toEqual({ outcome: "read", value: V1_VALUE });
  });

  it("is denied alike for a path the login may not read, a path that is not there and a mount that is not there", async () => {
    const bao = await withSecrets(`path "personal/data/harness/*" { capabilities = ["read"] }`);
    bao.secret("personal", "elsewhere", { token: "a-value-not-granted-for-tests" });
    const provider = createOpenBaoProvider();

    const denied = await provider.read(targetOf(bao), PERSON_TOKEN, { ...personal, path: "elsewhere" });
    expect(denied).toEqual({ outcome: "denied", message: `OpenBao at ${bao.address} did not let the login read personal/elsewhere (HTTP 403: permission denied).` });
    expect(await provider.read(targetOf(bao), PERSON_TOKEN, { ...personal, path: "nothing-here" })).toEqual({
      outcome: "denied",
      message: `OpenBao at ${bao.address} did not let the login read personal/nothing-here (HTTP 403: permission denied).`,
    });
    expect(await provider.read(targetOf(bao), PERSON_TOKEN, { ...personal, mount: "nowhere" })).toEqual({
      outcome: "denied",
      message: `OpenBao at ${bao.address} did not let the login see the mount nowhere (HTTP 403: preflight capability check returned 403, please ensure client's policies grant access to path "nowhere/").`,
    });
  });

  it("is not-found for a path the login may read with nothing there, and for a key the secret lacks, never naming a value", async () => {
    const bao = await withSecrets();
    expect(await openBaoProvider.read(targetOf(bao), PERSON_TOKEN, { ...personal, path: "harness/nothing-here" })).toEqual({
      outcome: "not-found",
      message: `OpenBao at ${bao.address} found nothing to read personal/harness/nothing-here (HTTP 404).`,
    });
    const lacking = await openBaoProvider.read(targetOf(bao), PERSON_TOKEN, { ...personal, key: "password" });
    expect(lacking).toEqual({ outcome: "not-found", message: `OpenBao at ${bao.address} holds no key password with text in personal/harness/forge-github.` });
    bao.secret("personal", "harness/forge-github", { token: 42 });
    expect(await openBaoProvider.read(targetOf(bao), PERSON_TOKEN, personal)).toMatchObject({ outcome: "not-found" });
  });

  it("answers sealed, unreachable and a rejected certificate as a verification does", async () => {
    const bao = await withSecrets();
    bao.seal();
    expect(await createOpenBaoProvider().read(targetOf(bao), PERSON_TOKEN, personal)).toMatchObject({ outcome: "sealed" });
    bao.unseal();
    expect(await openBaoProvider.read(targetOf(bao, { address: UNREACHABLE_OPENBAO }), PERSON_TOKEN, personal)).toMatchObject({ outcome: "unreachable" });
    expect(await openBaoProvider.read(targetOf(bao, { ca: testCertificates().otherCa }), PERSON_TOKEN, personal)).toMatchObject({ outcome: "certificate-rejected" });
  });
});

describe("a list", () => {
  const withTree = async () => {
    const bao = await fakeOpenBao();
    bao.kv("personal", 2);
    bao.kv("legacy", 1);
    bao.kv("hidden", 2);
    for (const path of ["harness/forge-github", "harness/bank-cortex", "notes"]) bao.secret("personal", path, { value: "a-value-for-tests" });
    bao.secret("legacy", "forge", { token: "a-value-for-tests" });
    bao.policy("browser", `path "personal/metadata/*" { capabilities = ["list"] }\npath "legacy/*" { capabilities = ["list"] }`);
    bao.token(PERSON_TOKEN, { policies: ["default", "browser"] });
    return bao;
  };

  it("names the KV mounts the login can see, each ending in /, and nothing it cannot", async () => {
    const bao = await withTree();
    expect(await openBaoProvider.list(targetOf(bao), PERSON_TOKEN, { mount: null, path: null })).toEqual({ outcome: "listed", names: ["legacy/", "personal/"] });
    expect(bao.requests).toEqual([{ method: "GET", path: "sys/internal/ui/mounts" }]);
  });

  it("lists names under a path on either version, a folder's ending in /, and the mount's top without one", async () => {
    const bao = await withTree();
    const provider = createOpenBaoProvider();
    expect(await provider.list(targetOf(bao), PERSON_TOKEN, { mount: "personal", path: null })).toEqual({ outcome: "listed", names: ["harness/", "notes"] });
    expect(await provider.list(targetOf(bao), PERSON_TOKEN, { mount: "personal", path: "harness" })).toEqual({ outcome: "listed", names: ["bank-cortex", "forge-github"] });
    expect(await provider.list(targetOf(bao), PERSON_TOKEN, { mount: "legacy", path: null })).toEqual({ outcome: "listed", names: ["forge"] });
    expect(bao.requests).toEqual([
      { method: "GET", path: "sys/internal/ui/mounts/personal" },
      { method: "LIST", path: "personal/metadata/" },
      { method: "LIST", path: "personal/metadata/harness/" },
      { method: "GET", path: "sys/internal/ui/mounts/legacy" },
      { method: "LIST", path: "legacy/" },
    ]);
  });

  it("is not-found for a path with nothing under it, and denied where the login may not list", async () => {
    const bao = await withTree();
    expect(await openBaoProvider.list(targetOf(bao), PERSON_TOKEN, { mount: "personal", path: "empty" })).toMatchObject({ outcome: "not-found" });
    expect(await openBaoProvider.list(targetOf(bao), PERSON_TOKEN, { mount: "hidden", path: null })).toMatchObject({ outcome: "denied" });
  });
});

describe("a write (#371)", () => {
  /** A fake OpenBao whose version 2 mount personal and version 1 mount legacy the token may write under harness, and read. */
  const withWritable = async () => {
    const bao = await fakeOpenBao();
    bao.policy("writer", `path "personal/data/harness/*" { capabilities = ["create", "update", "read"] }
path "legacy/harness/*" { capabilities = ["create", "update", "read"] }
path "personal/data/notes" { capabilities = ["read"] }
path "personal/data/replacing/*" { capabilities = ["update", "read"] }`);
    bao.token(PERSON_TOKEN, { policies: ["default", "writer"] });
    bao.kv("personal", 2);
    bao.kv("legacy", 1);
    return bao;
  };
  const reference = (mount: string, path: string) => ({ provider: "openbao", connectionId: "9b2f4c1e-3d5a-4b6c-8d7e-0f1a2b3c4d5e", mount, path, key: "token" }) as const;
  const fields = { note: "a note", service: "git.example.com", added: "2026-09-24" };

  it("writes the value with its fields on either version, keeping what else the entry held, and asks for the entry first", async () => {
    const bao = await withWritable();
    bao.secret("legacy", "harness/forge-home", { owner: "david" });
    const provider = createOpenBaoProvider();

    expect(await provider.write(targetOf(bao), PERSON_TOKEN, { reference: reference("personal", "harness/forge-home"), value: "value-for-tests", fields, overwrite: false })).toEqual({ outcome: "written" });
    expect(await provider.write(targetOf(bao), PERSON_TOKEN, { reference: reference("legacy", "harness/forge-home"), value: "value-for-tests", fields, overwrite: false })).toEqual({ outcome: "written" });

    expect(bao.stored("personal", "harness/forge-home")).toEqual({ token: "value-for-tests", ...fields });
    expect(bao.stored("legacy", "harness/forge-home")).toEqual({ owner: "david", token: "value-for-tests", ...fields });
    expect(bao.requests.filter((request) => !request.path.startsWith("sys/"))).toEqual([
      { method: "GET", path: "personal/data/harness/forge-home" },
      { method: "POST", path: "personal/data/harness/forge-home" },
      { method: "GET", path: "legacy/harness/forge-home" },
      { method: "POST", path: "legacy/harness/forge-home" },
    ]);
  });

  it("leaves a different value there as it was unless it overwrites; the same value is written again", async () => {
    const bao = await withWritable();
    bao.secret("personal", "harness/forge-home", { token: "another-value-for-tests" });
    const at = reference("personal", "harness/forge-home");

    expect(await openBaoProvider.write(targetOf(bao), PERSON_TOKEN, { reference: at, value: "value-for-tests", fields, overwrite: false })).toEqual({ outcome: "exists" });
    expect(bao.stored("personal", "harness/forge-home")).toEqual({ token: "another-value-for-tests" });
    expect(await openBaoProvider.write(targetOf(bao), PERSON_TOKEN, { reference: at, value: "value-for-tests", fields, overwrite: true })).toEqual({ outcome: "written" });
    expect(await openBaoProvider.write(targetOf(bao), PERSON_TOKEN, { reference: at, value: "value-for-tests", fields: { note: "again" }, overwrite: false })).toEqual({ outcome: "written" });
    expect(bao.stored("personal", "harness/forge-home")).toMatchObject({ token: "value-for-tests", note: "again" });
  });

  it("takes a value at the key that is no text for a different value too", async () => {
    const bao = await withWritable();
    bao.secret("personal", "harness/forge-home", { token: { nested: "value" } });
    const at = reference("personal", "harness/forge-home");

    expect(await openBaoProvider.write(targetOf(bao), PERSON_TOKEN, { reference: at, value: "value-for-tests", fields, overwrite: false })).toEqual({ outcome: "exists" });
    expect(bao.stored("personal", "harness/forge-home")).toEqual({ token: { nested: "value" } });
  });

  it("is denied where the login may not write, and a write check answers whether it may create an entry", async () => {
    const bao = await withWritable();
    expect(await openBaoProvider.write(targetOf(bao), PERSON_TOKEN, { reference: reference("personal", "notes"), value: "value-for-tests", fields, overwrite: false })).toMatchObject({ outcome: "denied" });
    expect(await openBaoProvider.canWrite(targetOf(bao), PERSON_TOKEN, { mount: "personal", path: "harness/entry" })).toEqual({ outcome: "checked", writable: true });
    expect(await openBaoProvider.canWrite(targetOf(bao), PERSON_TOKEN, { mount: "personal", path: "notes" })).toEqual({ outcome: "checked", writable: false });
    expect(await openBaoProvider.canWrite(targetOf(bao), PERSON_TOKEN, { mount: "legacy", path: "harness/entry" })).toEqual({ outcome: "checked", writable: true });
    // update alone replaces a secret that is there and creates none.
    expect(await openBaoProvider.canWrite(targetOf(bao), PERSON_TOKEN, { mount: "personal", path: "replacing/entry" })).toEqual({ outcome: "checked", writable: false });
  });
});
