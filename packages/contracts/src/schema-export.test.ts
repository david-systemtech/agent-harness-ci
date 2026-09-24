import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { schemaFixtures } from "../test/fixtures.js";
import * as contracts from "./index.js";
import { JSON_SCHEMA_DRAFT, exportedSchemas, jsonSchemaFiles, methods } from "./index.js";

/** The committed export, which CI regenerates and diffs. */
const schemaDir = join(import.meta.dirname, "..", "schema");

const filesOnDisk = (): string[] =>
  readdirSync(schemaDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(schemaDir, join(entry.parentPath, entry.name)))
    .sort();

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(schemaDir, path), "utf8")) as Record<string, unknown>;

/**
 * A validator that knows only the published documents: what a client in
 * another language would have. Strict, but for Ajv's own lint against
 * `type: [..]` lists, which draft 2020-12 allows (a schema issue's path).
 */
const validator = () => {
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
  addFormats.default(ajv);
  return ajv;
};

describe("the JSON Schema export", () => {
  it("is current: the committed files are exactly what the export writes", () => {
    const files = jsonSchemaFiles();
    expect(filesOnDisk()).toEqual([...files.keys()].sort());
    for (const [path, content] of files) expect(readFileSync(join(schemaDir, path), "utf8"), path).toBe(content);
  });

  it("exports every schema the package exports", () => {
    const exported = new Set<z.ZodType>(exportedSchemas().map((entry) => entry.schema));
    const packageSchemas = Object.entries(contracts).filter(([, value]) => value instanceof z.ZodType);
    expect(packageSchemas.length).toBeGreaterThan(0);
    for (const [name, schema] of packageSchemas) expect(exported.has(schema as z.ZodType), name).toBe(true);
  });

  it("indexes every schema file and every method with its scope", () => {
    const index = readJson("index.json") as {
      protocolVersion: number;
      schemas: { path: string; title: string }[];
      methods: { name: string; scope: string; stream: boolean; mutating: boolean; params: string; result: string; error: string }[];
    };
    expect(index.protocolVersion).toBe(contracts.PROTOCOL_VERSION);
    expect(index.schemas.map((s) => s.path).sort()).toEqual(filesOnDisk().filter((p) => p !== "index.json"));
    expect(index.methods).toEqual(
      methods.map((m) => ({
        name: m.name,
        scope: m.scope,
        stream: m.stream,
        mutating: m.mutating,
        params: `methods/${m.name}/params.json`,
        result: `methods/${m.name}/result.json`,
        error: `methods/${m.name}/error.json`,
      })),
    );
  });

  it("has fixtures for every schema it exports", () => {
    expect(Object.keys(schemaFixtures).sort()).toEqual(exportedSchemas().map((e) => e.path).sort());
  });

  describe.each(exportedSchemas().map((entry) => [entry.path, entry] as const))("%s", (path, entry) => {
    it("is a JSON Schema draft 2020-12 document", () => {
      const document = readJson(path);
      expect(document.$schema).toBe(JSON_SCHEMA_DRAFT);
      expect(document.title).toBe(entry.title);
      const ajv = validator();
      expect(ajv.validateSchema(document), ajv.errorsText(ajv.errors)).toBe(true);
    });

    it("accepts and rejects its fixtures exactly as the zod schema does", () => {
      const validate = validator().compile(readJson(path));
      const fixtures = schemaFixtures[path];
      if (!fixtures) throw new Error(`no fixtures for ${path}`);
      expect(fixtures.valid.length).toBeGreaterThan(0);
      expect(fixtures.invalid.length).toBeGreaterThan(0);
      for (const instance of fixtures.valid) {
        expect(entry.schema.safeParse(instance).success, `zod accepts ${JSON.stringify(instance)}`).toBe(true);
        expect(validate(instance), `the export accepts ${JSON.stringify(instance)}`).toBe(true);
      }
      for (const instance of fixtures.invalid) {
        expect(entry.schema.safeParse(instance).success, `zod rejects ${JSON.stringify(instance)}`).toBe(false);
        expect(validate(instance), `the export rejects ${JSON.stringify(instance)}`).toBe(false);
      }
    });
  });
});
