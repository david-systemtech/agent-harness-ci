import { BANK_VALIDATOR_RULES } from "../src/index.js";
import { personalManifest, teamManifest } from "./fixture-banks.js";

/**
 * Fixtures for the bank structure contract's schemas (banks spec, "BANK.md
 * and the folders" and "The validator"): a valid and an invalid instance of
 * each schema the export writes. Each invalid one is refused by the export
 * too, so what only the validator's own checks refuse (a team bank without
 * owners, the reviewed classes each named) is the validator's tests', not
 * these. `fixtures.ts` folds them into the package's fixture table.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const finding = {
  rule: "secret_shaped",
  severity: "refusal",
  path: "projects/personal/homelab/memories/backup-schedule.md",
  field: "body",
  secret: "github",
  message: "projects/personal/homelab/memories/backup-schedule.md's body holds a GitHub token: take it out, keep it in the key manager and name its path instead.",
};

const memory = { name: "backup-schedule", description: "When a backup is missing - the nightly schedule and its logs", metadata: { type: "project" } };

export const bankSchemaFixtures: Record<string, Fixtures> = {
  "banks/name.json": { valid: ["notebook", "maya-memory", "a".repeat(40)], invalid: ["Notebook", "maya_memory", "-maya", "a".repeat(41), ""] },
  "banks/manifest.json": {
    valid: [personalManifest(), teamManifest(), personalManifest({ root: "orgs", write: { ...(personalManifest().write as object), land: "commit" } })],
    invalid: [
      personalManifest({ purpose: undefined }),
      personalManifest({ purpose: "p".repeat(161) }),
      personalManifest({ kind: "shared" }),
      personalManifest({ entities: [{ name: "Maya Reyes", aliases: [] }] }),
      personalManifest({ orientation: ["a", "b", "c", "d", "e", "f"] }),
      personalManifest({ memories: { glob: "brands/*/*/memories/**/*.md", scope: "brands/{brand}/{system}/", schema: "memory" } }),
      personalManifest({ root: "projects" }),
    ],
  },
  "banks/org-file.json": { valid: [{ line: "The Acme team" }, { line: "Acme", status: "active" }], invalid: [{}, { line: "x".repeat(101) }, { line: "two\nlines" }] },
  "banks/scope-file.json": {
    valid: [
      { line: "The storefront", topics: {} },
      { line: "The storefront", topics: { deploys: "Before a deploy - the pipeline" }, repos: ["https://github.com/acme/web"], status: "active" },
    ],
    invalid: [{ line: "The storefront" }, { line: "The storefront", topics: { Deploys: "Before a deploy" } }, { line: "The storefront", topics: {}, repos: ["web"] }],
  },
  "banks/memory.json": {
    valid: [memory, { ...memory, metadata: { type: "reference", applies_to: ["https://github.com/acme/web"], added: "2026-09-30" } }],
    invalid: [{ ...memory, description: "Too short" }, { ...memory, name: "Backup Schedule" }, { ...memory, metadata: { type: "note" } }, { ...memory, metadata: { type: "project", applies_to: ["web"] } }],
  },
  "banks/rule-id.json": { valid: ["manifest_missing", "secret_shaped", "unresolved_link"], invalid: ["missing", ""] },
  "banks/validator-rule.json": { valid: [...BANK_VALIDATOR_RULES], invalid: [{ id: "index_over_cap", severity: "error", summary: "s" }, { id: "index_over_cap", severity: "refusal" }] },
  "banks/finding.json": {
    valid: [finding, { rule: "root_over_cap", severity: "refusal", path: "projects/", message: "The root has 41 breadcrumbs." }],
    invalid: [{ ...finding, message: "" }, { ...finding, secret: "entropy" }, { ...finding, rule: "nope" }],
  },
  "banks/verdict.json": {
    valid: [
      { validator: { name: "bank-validator", version: 1 }, valid: true, findings: [] },
      { validator: { name: "bank-validator", version: 1 }, valid: false, findings: [finding] },
    ],
    invalid: [{ validator: { name: "other-validator", version: 1 }, valid: true, findings: [] }, { validator: { name: "bank-validator", version: 0 }, valid: true, findings: [] }, { valid: true, findings: [] }],
  },
};
