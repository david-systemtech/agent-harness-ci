import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UPDATE_CONFLICT_REASONS, UPDATE_PATH, UpdateAnswer, UpdateError, UpdateRequest } from "./index.js";

/**
 * `POST /api/update` (launcher-update spec, "Across a protocol gap"; #335):
 * a stable HTTP route outside the wire, which a newer client uses to update
 * an older environment it no longer shares a protocol with. Its path,
 * request, answer and refusals never change shape, whatever the wire's
 * protocol version, so this test pins them as the export publishes them and
 * never reads the protocol version.
 */

const readExport = (path: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, "..", "schema", path), "utf8")) as unknown;

/** A document with its descriptions and title left out: its shape alone. */
const shapeOf = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(shapeOf);
  if (typeof node !== "object" || node === null) return node;
  return Object.fromEntries(Object.entries(node).flatMap(([key, value]) => (key === "description" || key === "title" ? [] : [[key, shapeOf(value)]])));
};

const SEMVER =
  "^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$";
const UUID4 = "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$";
const DRAFT = "https://json-schema.org/draft/2020-12/schema";

describe("POST /api/update", () => {
  it("is at /api/update, beside the pairing exchange", () => {
    expect(UPDATE_PATH).toBe("/api/update");
  });

  it("takes a version and, from a local client session, an artefact path, and nothing of the wire's protocol", () => {
    expect(UpdateRequest.parse({ version: "0.5.0" })).toEqual({ version: "0.5.0" });
    expect(UpdateRequest.safeParse({ version: "0.5.0", artefactPath: "/opt/agent-harness-linux-x64.tar.gz" }).success).toBe(true);
    expect(UpdateRequest.safeParse({}).success).toBe(false);
    expect(UpdateRequest.safeParse({ version: "v0.5.0" }).success).toBe(false);
    expect(UpdateRequest.safeParse({ version: "0.5.0", artefactPath: "" }).success).toBe(false);
    expect(shapeOf(readExport("update/request.json"))).toEqual({
      $schema: DRAFT,
      type: "object",
      properties: { version: { type: "string", pattern: SEMVER }, artefactPath: { type: "string", minLength: 1 } },
      required: ["version"],
    });
  });

  it("answers the update id and its target, as updates.apply does", () => {
    const answer = { updateId: "7d0f2b1e-2c55-4a8e-9f0b-3a1c5d7e9b20", toVersion: "0.5.0" };
    expect(UpdateAnswer.parse(answer)).toEqual(answer);
    expect(shapeOf(readExport("update/answer.json"))).toEqual({
      $schema: DRAFT,
      type: "object",
      properties: { updateId: { type: "string", format: "uuid", pattern: UUID4 }, toVersion: { type: "string", minLength: 1 } },
      required: ["updateId", "toVersion"],
    });
  });

  it("refuses with a code, a message and data: unauthorized, forbidden (without admin, or an artefact path from a paired session), invalid_params, not_found, conflict with the reason, unavailable or internal", () => {
    const refusal = (code: string, data: Record<string, unknown>) => UpdateError.safeParse({ code, message: "m", data }).success;
    expect(refusal("unauthorized", {})).toBe(true);
    expect(refusal("forbidden", { scope: "admin" })).toBe(true);
    expect(refusal("forbidden", { scope: "admin", reason: "local" })).toBe(true);
    expect(refusal("invalid_params", { issues: [] })).toBe(true);
    expect(refusal("not_found", {})).toBe(true);
    for (const reason of UPDATE_CONFLICT_REASONS) expect(refusal("conflict", { reason }), reason).toBe(true);
    expect(refusal("conflict", {})).toBe(false);
    expect(refusal("conflict", { reason: "busy" })).toBe(false);
    expect(refusal("unavailable", { readiness: "starting" })).toBe(true);
    expect(refusal("internal", {})).toBe(true);
    expect(refusal("rate_limited", { retryAfterMs: 5 })).toBe(false);
    const error = readExport("update/error.json") as { oneOf: { properties: { code: { const: string } } }[] };
    expect(error.oneOf.map((member) => member.properties.code.const)).toEqual(["unauthorized", "forbidden", "invalid_params", "not_found", "conflict", "unavailable", "internal"]);
  });
});
