import { describe, expect, it } from "vitest";
import { KeyManagerReferenceDisplay, KeyManagerReferenceHolder, displayReference, registry, type KeyManagerReference } from "./index.js";

/**
 * Key-manager references as the wire carries them (key-managers spec,
 * "References and resolution"; ADR 0011, ADR 0020): their display form, the
 * check and the browse a reference picker asks, the three refusals a
 * resolve answers, and the removal a reference holds back.
 */

const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const connectionId = "9b2f4c1e-3d5a-4b6c-8d7e-0f1a2b3c4d5e";
const otherId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const openbao: KeyManagerReference = { provider: "openbao", connectionId, mount: "personal", path: "harness/forge-github", key: "token" };

const codes = (name: keyof typeof registry) => registry[name].errors.map((member) => member.shape.code.value);

describe("a reference's display form", () => {
  it("is the provider, the connection's label and the locator, which names where the value sits and never holds it", () => {
    expect(displayReference(openbao, "Personal OpenBao")).toEqual({ provider: "openbao", label: "Personal OpenBao", locator: "personal/harness/forge-github (key token)" });
    expect(displayReference({ provider: "doppler", connectionId, name: "FORGE_TOKEN" }, "Doppler").locator).toBe("FORGE_TOKEN");
    expect(displayReference({ provider: "doppler", connectionId, name: "FORGE_TOKEN", project: "harness", config: "prd" }, "Doppler").locator).toBe("FORGE_TOKEN (project harness, config prd)");
    expect(displayReference({ provider: "doppler", connectionId, name: "FORGE_TOKEN", config: "prd" }, "Doppler").locator).toBe("FORGE_TOKEN (config prd)");
    expect(displayReference({ provider: "onepassword", connectionId, vault: "Harness", item: "forge-github", field: "credential" }, "1Password").locator).toBe("op://Harness/forge-github/credential");
    expect(displayReference({ provider: "bitwarden", connectionId, secretId: otherId, key: "FORGE_TOKEN" }, "Bitwarden").locator).toBe(`FORGE_TOKEN (${otherId})`);
  });

  it("has a null label for a connection this environment does not hold", () => {
    const display = displayReference(openbao, null);
    expect(display.label).toBeNull();
    expect(KeyManagerReferenceDisplay.parse(display)).toEqual(display);
    expect(Object.keys(KeyManagerReferenceDisplay.shape)).toEqual(["provider", "label", "locator"]);
  });
});

describe("keyManagers.references.check and keyManagers.references.browse", () => {
  it("are admin queries", () => {
    expect([registry["keyManagers.references.check"].kind, registry["keyManagers.references.check"].scope]).toEqual(["query", "admin"]);
    expect([registry["keyManagers.references.browse"].kind, registry["keyManagers.references.browse"].scope]).toEqual(["query", "admin"]);
  });

  it("check takes a reference and answers its display form with the refusal a resolve would answer, null when it resolves, and no field for a value", () => {
    const { params, result } = registry["keyManagers.references.check"];
    expect(params.safeParse({ reference: openbao }).success).toBe(true);
    expect(params.safeParse({ reference: { ...openbao, provider: "vault" } }).success).toBe(false);
    expect(Object.keys(result.shape)).toEqual(["display", "problem"]);
    const display = displayReference(openbao, "OpenBao");
    expect(result.safeParse({ display, problem: null }).success).toBe(true);
    for (const code of ["credential_source_unavailable", "reference_not_found", "reference_denied"]) {
      expect(result.safeParse({ display, problem: { code, message: "m", data: { connectionId } } }).success, code).toBe(true);
    }
    expect(result.safeParse({ display, problem: { code: "unreachable", message: "m", data: { connectionId } } }).success).toBe(false);
    expect(codes("keyManagers.references.check")).toEqual([]);
  });

  it("browse takes a connection, an optional mount and a path under it, answers names alone, and errors with the refusals a resolve answers", () => {
    const { params, result } = registry["keyManagers.references.browse"];
    expect(Object.keys(params.shape)).toEqual(["connectionId", "mount", "path"]);
    expect(params.safeParse({ connectionId }).success).toBe(true);
    expect(params.safeParse({ connectionId, mount: "personal", path: "harness" }).success).toBe(true);
    expect(params.safeParse({ connectionId, mount: "/personal" }).success).toBe(false);
    expect(Object.keys(result.shape)).toEqual(["names"]);
    expect(result.safeParse({ names: ["harness/", "notes"] }).success).toBe(true);
    expect(result.safeParse({ names: [{ name: "notes", value: "a value for tests" }] }).success).toBe(false);
    expect(codes("keyManagers.references.browse")).toEqual(["credential_source_unavailable", "reference_not_found", "reference_denied"]);
  });
});

describe("the refusals a resolve answers", () => {
  it("are credential_source_unavailable, reference_not_found and reference_denied, each naming the connection, and forge accounts answer them on add and update", () => {
    const [unavailable, notFound, denied] = registry["keyManagers.references.browse"].errors;
    expect(unavailable?.safeParse({ code: "credential_source_unavailable", message: "m", data: { connectionId } }).success).toBe(true);
    expect(notFound?.safeParse({ code: "reference_not_found", message: "m", data: { connectionId } }).success).toBe(true);
    expect(denied?.safeParse({ code: "reference_denied", message: "m", data: { connectionId } }).success).toBe(true);
    expect(denied?.safeParse({ code: "reference_denied", message: "m", data: {} }).success).toBe(false);
    expect(codes("forge.accounts.add")).toEqual(expect.arrayContaining(["credential_source_unavailable", "reference_not_found", "reference_denied"]));
    expect(codes("forge.accounts.update")).toEqual(expect.arrayContaining(["credential_source_unavailable", "reference_not_found", "reference_denied"]));
  });
});

describe("keyManagers.connections.remove", () => {
  it("takes force, which removes a connection references name; a holder is named by its kind, id and name", () => {
    const { params } = registry["keyManagers.connections.remove"];
    expect(Object.keys(params.shape)).toEqual(["commandId", "connectionId", "force"]);
    expect(params.safeParse({ commandId, connectionId, force: true }).success).toBe(true);
    expect(params.safeParse({ commandId, connectionId, force: "yes" }).success).toBe(false);
    const holder = { kind: "forge-account", id: "5b1c6f3e-2a4d-4e8f-9b0a-1c2d3e4f5a6b", name: "https://git.systemtech.dev:5526" };
    expect(KeyManagerReferenceHolder.parse(holder)).toEqual(holder);
    expect(KeyManagerReferenceHolder.safeParse({ ...holder, kind: "session" }).success).toBe(false);
  });
});
