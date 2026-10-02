import { expect, it } from "vitest";
import { readBankMarkdown } from "@agent-harness/contracts/bank-validator";
import { PERSONAL_BANK, markdown, personalManifest } from "../../../contracts/test/fixture-banks.js";
import { planBankMigration } from "./migration-planner.js";

const oldManifest = personalManifest();
delete oldManifest.kind;
delete oldManifest.entities;
delete oldManifest.orientation;
oldManifest.description = oldManifest.purpose;
delete oldManifest.purpose;
oldManifest.index = { file: "INDEX.md" };
const source: Record<string, string> = { ...PERSONAL_BANK, "BANK.md": markdown(oldManifest, "Keep the bank's authored instructions.\n"), "INDEX.md": "Generated index\n", "projects/personal/homelab/PROJECT.md": markdown({ summary: "The lab", code: ["lab"], topics: { deploys: "Deploys" } }), "projects/personal/homelab/memories/backup-schedule.md": PERSONAL_BANK["projects/personal/homelab/memories/backup-schedule.md"]!.replace("https://github.com/maya-reyes/homelab", "lab") };
it("plans key renames and explicit identities on a copy while preserving existing memory bytes and links", () => {
  const original = JSON.stringify(source);
  const plan = planBankMigration(source, { repositoryMappings: { lab: "https://github.com/maya-reyes/homelab" } }, { name: "maya-memory", land: "pull-request", forge: "forgejo", validator: "// validator-for-tests\n" });
  expect(plan.report.valid).toBe(true);
  expect(plan.report.memories).toEqual({ before: 5, after: 6, added: 1 });
  expect(plan.files["BANK.md"]).toContain("purpose:");
  expect(plan.files["BANK.md"]).not.toContain("description:");
  expect(plan.files["BANK.md"]).toContain("Keep the bank's authored instructions.");
  expect(plan.files["INDEX.md"]).toBeUndefined();
  expect(plan.files["projects/personal/homelab/PROJECT.md"]).toContain("repos:");
  expect(plan.files["projects/personal/homelab/memories/deploys/rollback-steps.md"]).toBe(source["projects/personal/homelab/memories/deploys/rollback-steps.md"]);
  expect(plan.files["projects/personal/memory-bank/memories/bank-orientation.md"]).toContain("[[");
  expect(JSON.stringify(source)).toBe(original);
});

it("reports unresolved identities and both malformed projects without losing their content", () => {
  const malformed = { ...source, "projects/personal/broken/PROJECT.md": "---\nsummary: A fact: without quotes\n---\nKeep this body.\n", "projects/personal/other/PROJECT.md": "---\nsummary: [unterminated\n---\nKeep this too.\n" };
  const plan = planBankMigration(malformed, {}, { name: "maya-memory", land: "pull-request", forge: "forgejo", validator: "// validator-for-tests\n" });
  expect(plan.report.valid).toBe(false);
  expect(plan.report.decisions).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: "projects/personal/broken/PROJECT.md", value: "frontmatter" }),
    expect.objectContaining({ path: "projects/personal/other/PROJECT.md", value: "frontmatter" }),
    expect.objectContaining({ value: "lab", reason: expect.stringContaining("repository identity") }),
  ]));
  expect(plan.files["projects/personal/broken/PROJECT.md"]).toBe(malformed["projects/personal/broken/PROJECT.md"]);
  const repaired = planBankMigration(malformed, { repositoryMappings: { lab: "https://github.com/maya-reyes/homelab" }, artefactRepairs: { "projects/personal/broken/PROJECT.md": markdown({ summary: "A fact: without quotes" }, "Keep this body.\n"), "projects/personal/other/PROJECT.md": markdown({ summary: "Other work" }, "Keep this too.\n") } }, { name: "maya-memory", land: "pull-request", forge: "forgejo", validator: "// validator-for-tests\n" });
  expect(repaired.report.valid).toBe(true);
  expect(repaired.files["projects/personal/broken/PROJECT.md"]).toContain("Keep this body.");
});

it("proposes all five over-cap folders and moves only explicitly accepted topics with intact links and counts", () => {
  const crowded: Record<string, string> = { ...PERSONAL_BANK };
  for (let folder = 1; folder <= 5; folder++) {
    crowded[`projects/personal/project-${folder}/PROJECT.md`] = markdown({ summary: `Project ${folder}`, code: [] });
    for (let n = 1; n <= 41; n++) {
      const name = `${n <= 21 ? "backup" : "network"}-${folder}-fact-${n}`;
      crowded[`projects/personal/project-${folder}/memories/${name}.md`] = `---\nname: ${name}\ndescription: When you need fact ${n} in project ${folder} - read this specific memory and its links\nmetadata:\n  type: project\n---\nKeep [[backup-schedule]] and [[rollback-steps]].\n`;
    }
  }
  const target = { name: "maya-memory", land: "pull-request" as const, forge: "forgejo" as const, validator: "// validator-for-tests\n" };
  const proposed = planBankMigration(crowded, {}, target);
  expect(proposed.report.valid).toBe(false);
  expect(proposed.report.proposals).toHaveLength(5);
  expect(proposed.report.moves).toEqual([]);
  const first = proposed.report.proposals[0]!;
  const topics = { [first.pointer]: Object.fromEntries(first.clusters.map((cluster) => [cluster.prefix, { line: `${cluster.prefix} facts`, memories: cluster.memories }])) };
  const oneAccepted = planBankMigration(crowded, { topics }, target);
  expect(oneAccepted.report.proposals).toHaveLength(4);
  expect(oneAccepted.report.moves).toHaveLength(41);
  expect(oneAccepted.report.memories).toEqual(proposed.report.memories);
  const allTopics = Object.fromEntries(proposed.report.proposals.map((proposal) => [proposal.pointer, Object.fromEntries(proposal.clusters.map((cluster) => [cluster.prefix, { line: `${cluster.prefix} facts`, memories: cluster.memories }]))]));
  const accepted = planBankMigration(crowded, { topics: allTopics }, target);
  expect(accepted.report.valid).toBe(true);
  expect(accepted.report.proposals).toEqual([]);
  expect(accepted.report.memories).toEqual({ before: 210, after: 210, added: 0 });
  expect(accepted.report.moves).toHaveLength(205);
  for (const move of accepted.report.moves) expect(accepted.files[move.to]).toBe(crowded[move.from]);
  expect(accepted.files["projects/personal/project-1/memories/backup/backup-1-fact-1.md"]).toContain("[[backup-schedule]] and [[rollback-steps]]");
});

it("installs explicitly authored short orientation pointers for review", () => {
  const plan = planBankMigration(source, { repositoryMappings: { lab: "https://github.com/maya-reyes/homelab" }, orientationDrafts: [{ name: "bank-tracker", description: "Before tracking this bank's work - follow the existing project memory for its details", body: "See [[backup-schedule]] for the source fact.\n" }] }, { name: "maya-memory", land: "pull-request", forge: "forgejo", validator: "// validator-for-tests\n" });
  expect(plan.report.valid).toBe(true);
  expect(plan.files["BANK.md"]).toContain("bank-tracker");
  expect(plan.files["projects/personal/memory-bank/memories/bank-tracker.md"]).toContain("[[backup-schedule]]");
  expect(plan.report.memories).toEqual({ before: 5, after: 6, added: 1 });
});

it("requires retaining the bank's secret scan when replacing its Python gate", () => {
  const bank = { ...PERSONAL_BANK, ".forgejo/workflows/old.yml": "steps:\n  - run: python -m bank check\n  - run: gitleaks detect --source .\n" };
  const target = { name: "maya-memory", land: "pull-request" as const, forge: "forgejo" as const, validator: "// validator-for-tests\n" };
  const choices = { retiredWorkflows: [".forgejo/workflows/old.yml"] };
  expect(planBankMigration(bank, choices, target).report.decisions).toContainEqual(expect.objectContaining({ value: "secret-scan" }));
  const planned = planBankMigration(bank, { ...choices, secretScan: "gitleaks detect --source ." }, target);
  expect(planned.report.valid).toBe(true);
  expect(planned.files[".forgejo/workflows/validate.yml"]).toContain("gitleaks detect --source .");
});


it("excludes rejected orientation names from the manifest and preserves their existing memories", () => {
  const plan = planBankMigration(PERSONAL_BANK, { orientationDrafts: [{ name: "backup-schedule", description: "Before using this bank - follow the project memory for its details", body: "New draft.\n" }, { name: "bank-tracker", description: "Before tracking this bank - follow the project memory for its details", body: "See [[backup-schedule]].\n" }] }, { name: "maya-memory", land: "pull-request", forge: "forgejo", validator: "// validator-for-tests\n" });
  expect(plan.report.decisions).toContainEqual(expect.objectContaining({ value: "backup-schedule" }));
  const manifest = readBankMarkdown(plan.files["BANK.md"]!);
  expect(manifest.ok && manifest.data.orientation).toEqual(["bank-tracker"]);
  expect(plan.files["projects/personal/homelab/memories/backup-schedule.md"]).toBe(PERSONAL_BANK["projects/personal/homelab/memories/backup-schedule.md"]);
  expect(plan.files["projects/personal/memory-bank/memories/backup-schedule.md"]).toBeUndefined();
});


it("keeps unrelated Python workflows and independent Python secret scanners", () => {
  const workflow = "steps:\n  - uses: actions/setup-python@v5\n    with:\n      python-version: '3.12'\n  - run: python scripts/check-links.py\n";
  const scanner = "#!/usr/bin/env python3\nprint('Scan synthetic secrets')\n";
  const bank = { ...PERSONAL_BANK, ".forgejo/workflows/docs.yml": workflow, "scripts/scan-secrets.py": scanner };
  const target = { name: "maya-memory", land: "pull-request" as const, forge: "forgejo" as const, validator: "// validator-for-tests\n" };
  const plan = planBankMigration(bank, { secretScan: "python scripts/scan-secrets.py" }, target);
  expect(plan.report.valid).toBe(true);
  expect(plan.report.decisions).toEqual([]);
  expect(plan.files[".forgejo/workflows/docs.yml"]).toBe(workflow);
  expect(plan.files["scripts/scan-secrets.py"]).toBe(scanner);
  const retired = planBankMigration({ ...bank, ".forgejo/workflows/old.yml": "steps:\n  - run: python -m bank check\n" }, {}, target);
  expect(retired.report.decisions).toContainEqual(expect.objectContaining({ path: ".forgejo/workflows/old.yml", value: "workflow" }));
});
