/**
 * Writes the JSON Schema export to packages/contracts/schema, replacing what
 * is there, so a schema that was removed is removed from the export too.
 * Run: pnpm --filter @agent-harness/contracts export-schemas
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { jsonSchemaFiles } from "../src/schema-export.js";

const out = join(import.meta.dirname, "..", "schema");
const files = jsonSchemaFiles();

rmSync(out, { recursive: true, force: true });
for (const [path, content] of files) {
  const target = join(out, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
console.log(`Wrote ${files.size} files to ${out}`);
