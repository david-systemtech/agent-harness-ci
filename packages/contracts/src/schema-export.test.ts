import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { schemaFixtures } from "../test/fixtures.js";
import * as contracts from "./index.js";
import { JSON_SCHEMA_DRAFT, exportedSchemas, jsonSchemaFiles, methodPath, methods } from "./index.js";

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

  it("indexes every schema file, every case table, every data table and every method with its scope", () => {
    const index = readJson("index.json") as {
      protocolVersion: number;
      schemas: { path: string; title: string }[];
      cases: { path: string; title: string }[];
      data: { path: string; title: string; schema: string }[];
      methods: { name: string; scope: string; kind: string; stream: boolean; params: string; result: string; response?: string; error: string }[];
    };
    expect(index.protocolVersion).toBe(contracts.PROTOCOL_VERSION);
    expect(index.cases).toEqual([{ path: "cases/repository-identity.json", title: "Repository identity" }]);
    expect(index.data).toEqual([
      { path: "data/settings-bands.json", title: "Settings bands", schema: "settings/band.json" },
      { path: "data/settings-rows.json", title: "Settings rows", schema: "settings/row.json" },
      { path: "data/settings-addresses.json", title: "Settings addresses", schema: "settings/address-row.json" },
    ]);
    const tablePaths = new Set([...index.cases, ...index.data].map((c) => c.path));
    expect(index.schemas.map((s) => s.path).sort()).toEqual(filesOnDisk().filter((p) => p !== "index.json" && !tablePaths.has(p)));
    expect(index.methods).toEqual(
      methods.map((m) => ({
        name: m.name,
        scope: m.scope,
        kind: m.kind,
        stream: m.kind === "stream",
        params: methodPath(m.name, "params"),
        result: methodPath(m.name, "result"),
        ...(m.kind === "command" && { response: methodPath(m.name, "response") }),
        error: methodPath(m.name, "error"),
      })),
    );
  });

  it("publishes the repository identity rule's cases, which a client reading only the file can run the rule against", () => {
    const published = readJson("cases/repository-identity.json") as {
      title: string;
      description: string;
      cases: { note: string; remote: string; forgeAccounts: { origin: string; aliases: string[] }[]; identity: string | null }[];
    };
    expect(published.title).toBe("Repository identity");
    expect(published.description).toContain("repositoryIdentityOf");
    expect(published.cases).toHaveLength(contracts.REPOSITORY_IDENTITY_CASES.length);
    expect(published.cases).toContainEqual({
      note: "ssh with sshd's port",
      remote: "ssh://git@git.systemtech.dev:2222/david/agent-harness.git",
      forgeAccounts: [],
      identity: "https://git.systemtech.dev/david/agent-harness",
    });
    expect(published.cases).toContainEqual({
      note: "ssh to the alias's host",
      remote: "ssh://git@100.101.102.103:2222/david/agent-harness.git",
      forgeAccounts: [{ origin: "https://git.systemtech.dev:5526", aliases: ["http://100.101.102.103:3000"] }],
      identity: "https://git.systemtech.dev/david/agent-harness",
    });
    for (const entry of published.cases) expect(contracts.repositoryIdentityOf(entry.remote, entry.forgeAccounts), entry.note).toBe(entry.identity);
  });

  it("publishes the bands, the row registry and the address table as data, each entry valid against the schema the file names", () => {
    const ajv = validator();
    for (const path of filesOnDisk().filter((p) => p !== "index.json" && !p.startsWith("data/"))) ajv.addSchema(readJson(path), path);
    const tables = Object.fromEntries(
      ["data/settings-bands.json", "data/settings-rows.json", "data/settings-addresses.json"].map((path) => {
        const table = readJson(path) as { title: string; description: string; schema: string; entries: unknown[] };
        const validate = ajv.getSchema(table.schema);
        if (validate === undefined) throw new Error(`${path} names ${table.schema}, which is not published`);
        for (const entry of table.entries) expect(validate(entry), `${path}: ${JSON.stringify(entry)}`).toBe(true);
        expect(table.description, path).not.toBe("");
        return [path, table.entries];
      }),
    );
    expect(tables["data/settings-bands.json"]).toEqual(contracts.SETTINGS_BANDS);
    expect(tables["data/settings-rows.json"]).toEqual(contracts.SETTINGS_ROWS);
    expect(tables["data/settings-rows.json"]).toContainEqual(expect.objectContaining({ id: "access.key-managers", scope: "environment", homeOf: ["key-manager"] }));
    expect(tables["data/settings-addresses.json"]).toHaveLength(16);
    expect(tables["data/settings-addresses.json"]).toContainEqual({ address: "secrets", row: "access.key-managers" });
    expect(tables["data/settings-addresses.json"]).toEqual(contracts.SETTINGS_ADDRESSES.map((address) => ({ address, row: contracts.rowOfAddress(address) })));
  });

  it("publishes the row, scope and address shapes", () => {
    for (const path of ["settings/band.json", "settings/row-id.json", "settings/row-scope.json", "settings/row.json", "settings/address.json", "settings/address-row.json", "setup/step-id.json"]) {
      expect(filesOnDisk(), path).toContain(path);
    }
    expect(readJson("settings/row-scope.json")).toMatchObject({ enum: ["environment", "everywhere", "client"] });
    expect((readJson("settings/address.json") as { enum: string[] }).enum).toHaveLength(16);
  });

  it("describes every enum, so a client developer knows what each set of values is", () => {
    const undescribed: string[] = [];
    const walk = (node: unknown, where: string): void => {
      if (Array.isArray(node)) return node.forEach((child, i) => walk(child, `${where}/${i}`));
      if (typeof node !== "object" || node === null) return;
      if ("enum" in node && !("description" in node)) undescribed.push(where);
      for (const [key, child] of Object.entries(node)) if (key !== "enum") walk(child, `${where}/${key}`);
    };
    for (const path of filesOnDisk().filter((p) => p !== "index.json")) walk(readJson(path), path);
    expect(undescribed).toEqual([]);
  });

  it("speaks the glossary: the environment and the client, never a server", () => {
    const offending: string[] = [];
    for (const path of filesOnDisk()) {
      const text = readFileSync(join(schemaDir, path), "utf8");
      for (const match of text.matchAll(/"description": "([^"]*)"/g)) {
        if (/\bserver\b/i.test(match[1] ?? "")) offending.push(`${path}: ${match[1]}`);
      }
    }
    expect(offending).toEqual([]);
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
