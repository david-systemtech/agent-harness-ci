import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { composedManifest } from "../test/instruction-fixtures.js";
import {
  EVENT_TYPES,
  INSTRUCTION_LAYERS,
  INSTRUCTIONS_STREAM_KIND,
  InstructionManifest,
  MAX_INSTRUCTION_BODY,
  MAX_INSTRUCTION_TITLE,
  OwnedInstruction,
  SETTINGS,
  STEP_REGISTRY,
  RunInstructionsComposedPayload,
  exportedSchemas,
  isListEvent,
  methodPath,
  methods,
  publishedEventPayloads,
  registry,
} from "./index.js";

/**
 * The contract tests of the standing-instruction vocabulary (skills
 * spec, "Standing instructions and the composer"; #493): the layers in their
 * order, `instructions.preview` in the registry, `run.instructions.composed`
 * in the event-type table, and both in the JSON Schema export, through which
 * a manifest and the event round-trip.
 */

const schemaDir = join(import.meta.dirname, "..", "schema");
const exported = (path: string): Record<string, unknown> => JSON.parse(readFileSync(join(schemaDir, path), "utf8")) as Record<string, unknown>;

const validator = () => {
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
  addFormats.default(ajv);
  return ajv;
};

const sessionId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const runId = "3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b";
const workspace = { kind: "directory", path: "/home/david/work/agent-harness" };

describe("the layers", () => {
  it("run from general to specific: user, team bank, project, session, persona, always-on", () => {
    expect(INSTRUCTION_LAYERS).toEqual(["user", "team-bank", "project", "session", "persona", "always-on"]);
  });
});

describe("instructions.preview", () => {
  it("is a query at read, registered and indexed with its documents", () => {
    expect(registry["instructions.preview"]).toMatchObject({ name: "instructions.preview", kind: "query", scope: "read" });
    const index = exported("index.json") as { methods: { name: string; scope: string; params: string; result: string }[] };
    expect(index.methods).toContainEqual(expect.objectContaining({ name: "instructions.preview", scope: "read", params: methodPath("instructions.preview", "params") }));
  });

  it("takes a session, or an account and a workspace, never both and never part of the second", () => {
    const params = registry["instructions.preview"].params;
    expect(params.safeParse({ sessionId }).success).toBe(true);
    expect(params.safeParse({ accountId: "claude-max", workspace }).success).toBe(true);
    for (const wrong of [{}, { accountId: "claude-max" }, { workspace }, { sessionId, accountId: "claude-max" }, { sessionId, accountId: "claude-max", workspace }]) {
      expect(params.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false);
    }
  });

  it("answers each part with its layer, id, title and text, then the text and the manifest", () => {
    const { result } = registry["instructions.preview"];
    expect(Object.keys(result.shape)).toEqual(["parts", "text", "manifest"]);
    expect(result.shape.manifest).toBe(InstructionManifest);
  });
});

describe("run.instructions.composed", () => {
  it("is on the session stream and changes nothing listed", () => {
    expect(EVENT_TYPES.session["run.instructions.composed"].payload).toBe(RunInstructionsComposedPayload);
    expect(isListEvent("session", "run.instructions.composed")).toBe(false);
    expect(publishedEventPayloads()).toContainEqual(["run.instructions.composed", RunInstructionsComposedPayload]);
  });

  it("carries the manifest and the text's digest, never the text", () => {
    expect(Object.keys(RunInstructionsComposedPayload.shape)).toEqual(["runId", "manifest", "digest"]);
    expect(Object.keys(InstructionManifest.shape)).toEqual(["channel", "layers", "alwaysOn", "skillSetFingerprint", "unreadRegistries", "leftOut"]);
  });

  it("round-trips through the JSON Schema export: what it writes validates against the published document and reads back the same", () => {
    const path = "sessions/events/run.instructions.composed.json";
    expect(exportedSchemas().find((schema) => schema.path === path)?.schema).toBe(RunInstructionsComposedPayload);
    const ajv = validator();
    const validate = ajv.compile(exported(path));
    const payload = { runId, manifest: composedManifest, digest: "b".repeat(64) };
    const written = JSON.parse(JSON.stringify(RunInstructionsComposedPayload.parse(payload))) as unknown;
    expect(validate(written), ajv.errorsText(validate.errors)).toBe(true);
    expect(RunInstructionsComposedPayload.parse(written)).toEqual(payload);
  });
});

describe("owned instructions (#505)", () => {
  const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const record = { id, title: "Coding style", body: "Prefer small modules.", origin: null, scope: "all", enabled: true, position: "n" };

  it("are a record of id, title, body, origin, scope, enabled and position, held to their bounds", () => {
    expect(Object.keys(OwnedInstruction.shape)).toEqual(["id", "title", "body", "origin", "scope", "enabled", "position"]);
    expect([MAX_INSTRUCTION_TITLE, MAX_INSTRUCTION_BODY]).toEqual([120, 20000]);
    expect(OwnedInstruction.safeParse(record).success).toBe(true);
    expect(OwnedInstruction.safeParse({ ...record, scope: ["claude-max", "claude-work"], origin: { catalogueId: "coding.small-modules", version: 2 } }).success).toBe(true);
    for (const broken of [
      { ...record, title: "" },
      { ...record, title: "   " },
      { ...record, title: "t".repeat(121) },
      { ...record, body: "b".repeat(20001) },
      { ...record, scope: [] },
      { ...record, scope: "some" },
      { ...record, position: "na" },
      { ...record, id: "not-a-uuid" },
    ]) {
      expect(OwnedInstruction.safeParse(broken).success, JSON.stringify(broken).slice(0, 80)).toBe(false);
    }
    expect(OwnedInstruction.safeParse({ ...record, title: "t".repeat(120), body: "b".repeat(20000) }).success).toBe(true);
  });

  it("are one stream per environment whose six events change nothing listed", () => {
    expect(INSTRUCTIONS_STREAM_KIND).toBe("instructions");
    const types = Object.keys(EVENT_TYPES.instructions);
    expect(types).toEqual(["instructions.created", "instructions.edited", "instructions.scope-set", "instructions.enabled-set", "instructions.moved", "instructions.removed"]);
    for (const type of types) expect(isListEvent("instructions", type), type).toBe(false);
  });

  it("are driven by six commands at admin and listed by a query at read", () => {
    const owned = methods.filter((m) => m.name.startsWith("instructions.")).map((m) => [m.name, m.kind, m.scope]);
    expect(owned).toEqual([
      ["instructions.preview", "query", "read"],
      ["instructions.list", "query", "read"],
      ["instructions.create", "command", "admin"],
      ["instructions.edit", "command", "admin"],
      ["instructions.setScope", "command", "admin"],
      ["instructions.setEnabled", "command", "admin"],
      ["instructions.move", "command", "admin"],
      ["instructions.remove", "command", "admin"],
    ]);
  });

  it("list the Orientation row first, which no command can name, then the owned instructions, every row with the environment's accounts", () => {
    const accounts = [
      { accountId: "claude-max", label: "Claude Max", channel: { kind: "system-prompt-append", maxCharacters: null }, reason: null },
      { accountId: "local", label: "Local", channel: { kind: "none", maxCharacters: null }, reason: "Local has no instruction channel: its runs are handed no standing instructions." },
    ];
    const orientation = { enabled: true, text: "# Orientation", unreadRegistries: [], accounts };
    const { result } = registry["instructions.list"];
    expect(Object.keys(result.shape)).toEqual(["orientation", "instructions"]);
    expect(result.safeParse({ orientation, instructions: [{ ...record, accounts }] }).success).toBe(true);
    expect(result.safeParse({ orientation: { ...orientation, id }, instructions: [] }).success).toBe(false);
    expect(result.safeParse({ orientation: { ...record, accounts }, instructions: [] }).success).toBe(false);
  });

  it("put instructions.orientation, preset on, on the Instructions step's registry entry", () => {
    expect(SETTINGS["instructions.orientation"]).toMatchObject({ preset: true, step: { id: "instructions", row: "knowledge.instructions" } });
    expect(STEP_REGISTRY.find((step) => step.id === "instructions")).toMatchObject({ home: "knowledge.instructions", writes: ["instructions.orientation"], skippable: false });
  });
});
