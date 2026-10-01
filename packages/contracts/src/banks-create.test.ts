import { describe, expect, it } from "vitest";
import { registry } from "./registry.js";

const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const bankId = "6f1c2c1e-8a8f-4b5e-9a65-1d7c5b0f2a10";
const personal = { commandId, bankId, name: "maya-memory", creation: { kind: "personal", localOnly: true, personName: "Maya Reyes", org: "personal", project: "homelab" } };
const team = { ...personal, creation: { kind: "team", forgeAccountId: bankId, owner: { kind: "organisation", login: "acme" }, repositoryName: "team-memory", teamName: "Acme", org: "acme", projects: [{ name: "Web", folder: "web" }] } };

describe("banks.create's contract", () => {
  it("is an admin command with client-minted command and bank ids", () => {
    const method = registry["banks.create"];
    expect(method).toMatchObject({ scope: "admin", kind: "command" });
    expect(method.params.parse(personal)).toEqual(personal);
    expect(method.params.parse(team)).toEqual(team);
    expect(method.params.safeParse({ ...personal, creation: { ...personal.creation, personName: undefined } }).success).toBe(true);
    expect(method.params.safeParse({ ...personal, commandId: undefined }).success).toBe(false);
    expect(method.params.safeParse({ ...personal, bankId: undefined }).success).toBe(false);
  });

  it("requires both personal seed answers and safe folder names", () => {
    const params = registry["banks.create"].params;
    expect(params.safeParse({ ...personal, creation: { ...personal.creation, project: undefined } }).success).toBe(false);
    expect(params.safeParse({ ...personal, creation: { ...personal.creation, org: "../escape" } }).success).toBe(false);
    expect(params.safeParse({ ...personal, creation: { ...personal.creation, project: "/absolute" } }).success).toBe(false);
  });

  it("accepts user and organisation ownership, requiring a forge and first projects, with no local-only team choice", () => {
    const params = registry["banks.create"].params;
    expect(params.safeParse({ ...team, creation: { ...team.creation, owner: { kind: "user", login: "maya" } } }).success).toBe(true);
    expect(params.safeParse({ ...team, creation: { ...team.creation, localOnly: true } }).success).toBe(false);
    expect(params.safeParse({ ...team, creation: { ...team.creation, forgeAccountId: undefined } }).success).toBe(false);
    expect(params.safeParse({ ...team, creation: { ...team.creation, projects: [] } }).success).toBe(false);
  });
});
