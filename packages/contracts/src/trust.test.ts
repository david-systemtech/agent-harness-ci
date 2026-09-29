import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_NOTICE_TYPES,
  EVENT_TYPES,
  EnvironmentNotice,
  TRUST_STREAM_KIND,
  TrustKey,
  TrustOffer,
  TrustRecord,
  eventTypeEntry,
  isListEvent,
  methods,
  registry,
  trustOfferEmpty,
  type TrustOffer as TrustOfferType,
} from "./index.js";

/**
 * The trust gate's contract (skills spec, "The trust gate", "Wire summary"
 * and "Events and notices"; #500): the four methods and their scopes, the
 * trust stream's events in the event-type table, the notice, the key, the
 * record and the offer, in the contracts and in the published JSON Schema.
 */

/** A published document, compiled as a client in another language would: from the committed file alone. */
const published = (path: string) => {
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
  addFormats.default(ajv);
  return ajv.compile(JSON.parse(readFileSync(join(import.meta.dirname, "..", "schema", path), "utf8")) as object);
};

const NOTHING: TrustOfferType = { instructionFiles: [], skillRoots: [], commands: 0, hooks: [], permissionRules: { allow: 0, ask: 0, deny: 0 }, subagents: 0, mcpServers: [] };

describe("the trust methods", () => {
  it("read with trust.get and trust.list at read, and decide and revoke with trust.decide and trust.revoke at admin, both commands", () => {
    const trust = methods.filter((method) => method.name.startsWith("trust."));
    expect(trust.map((method) => [method.name, method.kind, method.scope])).toEqual([
      ["trust.get", "query", "read"],
      ["trust.list", "query", "read"],
      ["trust.decide", "command", "admin"],
      ["trust.revoke", "command", "admin"],
    ]);
  });

  it("decide on a session or a recorded key, never both and never neither, in the contracts and the published schema", () => {
    const params = registry["trust.decide"].params;
    const check = published("methods/trust.decide/params.json");
    const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const sessionId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const key = "https://git.systemtech.dev/david/agent-harness";
    for (const valid of [
      { commandId, sessionId, decision: "trusted" },
      { commandId, key, decision: "declined" },
    ]) {
      expect(params.safeParse(valid).success, JSON.stringify(valid)).toBe(true);
      expect(check(valid), JSON.stringify(valid)).toBe(true);
    }
    for (const invalid of [
      { commandId, decision: "trusted" },
      { commandId, sessionId, key, decision: "trusted" },
    ]) {
      expect(params.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
      expect(check(invalid), JSON.stringify(invalid)).toBe(false);
    }
  });
});

describe("the trust stream", () => {
  it("carries trust.granted, trust.declined and trust.revoked, none of which changes the session list", () => {
    expect(TRUST_STREAM_KIND).toBe("trust");
    expect(Object.keys(EVENT_TYPES.trust)).toEqual(["trust.granted", "trust.declined", "trust.revoked"]);
    for (const type of ["trust.granted", "trust.declined", "trust.revoked"]) expect(isListEvent("trust", type), type).toBe(false);
    expect(eventTypeEntry("environment", "trust.granted")).toBeUndefined();
  });

  it("records a decision with the record's fields, and a revoke with the key and its kind", () => {
    const decided = { key: "/work/remoteless", keyKind: "checkout", clientSessionId: "cs-1", clientLabel: "David's laptop", sessionId: null };
    expect(eventTypeEntry("trust", "trust.granted")?.payload.parse(decided)).toEqual(decided);
    expect(eventTypeEntry("trust", "trust.declined")?.payload.parse(decided)).toEqual(decided);
    expect(eventTypeEntry("trust", "trust.revoked")?.payload.parse({ key: "/work/remoteless", keyKind: "checkout" })).toEqual({ key: "/work/remoteless", keyKind: "checkout" });
    expect(published("trust/events/trust.granted.json")(decided)).toBe(true);
  });

  it("is followed by the trust.updated notice on the environment stream", () => {
    expect(ENVIRONMENT_NOTICE_TYPES).toContain("trust.updated");
    expect(EnvironmentNotice.parse({ type: "trust.updated", payload: {} })).toEqual({ type: "trust.updated", payload: {} });
    expect(eventTypeEntry("environment", "trust.updated")).toMatchObject({ list: false });
  });
});

describe("a trust key and its record", () => {
  it("is a repository identity or an absolute path, never a remote as typed", () => {
    for (const key of ["https://github.com/david/app", "/work/app", "C:\\work\\app"]) expect(TrustKey.safeParse(key).success, key).toBe(true);
    for (const key of ["git@github.com:david/app.git", "work/app", ""]) expect(TrustKey.safeParse(key).success, key).toBe(false);
  });

  it("holds the key, its kind, the decision, when, the client session and its label then, and the session it was asked in", () => {
    expect(Object.keys(TrustRecord.shape)).toEqual(["key", "keyKind", "decision", "decidedAt", "clientSessionId", "clientLabel", "sessionId"]);
  });
});

describe("an offer", () => {
  it("counts instruction files, members per skill root, commands, hooks by event, permission rules and subagents, and lists MCP servers marked not loaded", () => {
    expect(Object.keys(TrustOffer.shape)).toEqual(["instructionFiles", "skillRoots", "commands", "hooks", "permissionRules", "subagents", "mcpServers"]);
    expect(TrustOffer.safeParse({ ...NOTHING, mcpServers: [{ name: "github", loaded: true }] }).success).toBe(false);
  });

  it("is empty with nothing trust would load, MCP servers alone included, and not with any one thing it would", () => {
    expect(trustOfferEmpty(NOTHING)).toBe(true);
    expect(trustOfferEmpty({ ...NOTHING, mcpServers: [{ name: "github", loaded: false }] })).toBe(true);
    for (const offer of [
      { ...NOTHING, instructionFiles: ["CLAUDE.md"] },
      { ...NOTHING, skillRoots: [{ root: ".agents/skills", directory: ".", members: 1 }] },
      { ...NOTHING, commands: 1 },
      { ...NOTHING, hooks: [{ event: "SessionStart", hooks: 1 }] },
      { ...NOTHING, permissionRules: { allow: 0, ask: 1, deny: 0 } },
      { ...NOTHING, subagents: 1 },
    ] satisfies TrustOfferType[]) {
      expect(trustOfferEmpty(offer), JSON.stringify(offer)).toBe(false);
    }
  });
});
