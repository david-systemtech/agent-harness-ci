import { markdown, memory } from "../../contracts/test/fixture-banks.js";

/** Invented team facts only; no content from a live bank. */
export const TEAM_MIGRATION_FIXTURE: Record<string, string> = {
  "BANK.md": markdown({ name: "fixture-team", description: "Synthetic team projects and shared company facts", index: { file: "INDEX.md" } }, "Keep these authored bank instructions.\n"),
  "INDEX.md": "Generated fixture index\n",
  "brands/sample-brand/PROJECT.md": markdown({ summary: "A synthetic brand", code: [] }),
  "brands/sample-brand/memories/brand-fact.md": memory("brand-fact", { body: "Follow [[system-fact]] and [[holding-fact]].\n" }),
  "brands/sample-brand/ops/SYSTEM.md": markdown({ summary: "Synthetic operations", code: ["sample-repo"] }, "Keep this authored area body.\n"),
  "brands/sample-brand/ops/memories/system-fact.md": memory("system-fact", { appliesTo: ["sample-repo"], body: "Follow [[brand-fact]].\n" }),
  "brands/sample-brand/product/SYSTEM.md": markdown({ summary: "Synthetic product facts", code: [] }),
  "brands/sample-brand/product/sample-line/memories/product-fact.md": memory("product-fact", { body: "Follow [[brand-fact]].\n" }),
  "shared/ops/SYSTEM.md": markdown({ summary: "Synthetic holding operations", code: [] }),
  "shared/ops/memories/holding-fact.md": memory("holding-fact", { body: "Follow [[product-fact]].\n" }),
  ".github/workflows/secrets.yml": "name: scan\njobs:\n  secrets:\n    steps:\n      - run: gitleaks detect --source .\n",
};

export const TEAM_MIGRATION_CHOICES = {
  team: { org: "brandsolidate", owners: ["david-systemtech"] },
  scopeMoves: { "shared/ops/": "fixture-team:brandsolidate/holding/ops/" },
  topicDeclarations: { "fixture-team:brandsolidate/sample-brand/product/": { "sample-line": "Synthetic product line" } },
  repositoryMappings: { "sample-repo": "https://github.com/example-fixture/sample-repo" },
  orientationDrafts: [{ name: "team-pointers", description: "Before using the synthetic team bank - follow its brand and holding fact pointers", body: "See [[brand-fact]] and [[holding-fact]].\n" }],
};
