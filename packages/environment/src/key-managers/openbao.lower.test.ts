import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { manualClock } from "../../test/clock.js";
import { UNREACHABLE_OPENBAO, startFakeOpenBao, testCertificates, type FakeOpenBao } from "../../test/fake-openbao.js";
import { PERSON_TOKEN, approle } from "../../test/key-manager-connections.js";
import { openBaoProvider } from "./openbao.js";
import type { SignInTarget } from "./provider.js";

/**
 * The OpenBao provider against the fake OpenBao without the wire
 * (key-managers spec, "Testing Decisions"; #366): what a verification asks
 * and how it reads the answers, the write flag it reads from each policy's
 * text, and the categories every error falls into.
 */

const { onCleanup } = useCleanups();

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
