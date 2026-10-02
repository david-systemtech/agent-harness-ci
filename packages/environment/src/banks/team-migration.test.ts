import { expect, it } from "vitest";
import { readBankMarkdown, validateBank } from "@agent-harness/contracts/bank-validator";
import { TEAM_MIGRATION_CHOICES, TEAM_MIGRATION_FIXTURE } from "../../test/team-migration-fixture.js";
import { planBankMigration } from "./migration-planner.js";

const target = { name: "fixture-team", land: "pull-request" as const, forge: "github" as const, validator: "// validator-for-tests\n" };

it("converts synthetic brand, system, holding and product scopes with the shared validator and intact facts", () => {
  const source = JSON.stringify(TEAM_MIGRATION_FIXTURE);
  const plan = planBankMigration(TEAM_MIGRATION_FIXTURE, TEAM_MIGRATION_CHOICES, target);
  expect(plan.report.valid, JSON.stringify(plan.report)).toBe(true);
  expect(plan.report.memories).toEqual({ before: 4, after: 5, added: 1 });
  expect(validateBank({ files: plan.files }).valid).toBe(true);
  const manifest = readBankMarkdown(plan.files["BANK.md"]!);
  expect(manifest).toMatchObject({ ok: true, data: { kind: "team", owners: ["david-systemtech"], orientation: ["team-pointers"], write: { land: "pull-request", merge: { memories: "auto", reviewed: ["orientation", "decisions", "status", "manifest"] } } } });
  expect(plan.files["projects/brandsolidate/sample-brand/memories/brand-fact.md"]).toBe(TEAM_MIGRATION_FIXTURE["brands/sample-brand/memories/brand-fact.md"]);
  expect(plan.files["projects/brandsolidate/holding/ops/memories/holding-fact.md"]).toBe(TEAM_MIGRATION_FIXTURE["shared/ops/memories/holding-fact.md"]);
  expect(plan.files["projects/brandsolidate/sample-brand/product/memories/sample-line/product-fact.md"]).toBe(TEAM_MIGRATION_FIXTURE["brands/sample-brand/product/sample-line/memories/product-fact.md"]);
  expect(plan.files["projects/brandsolidate/sample-brand/ops/AREA.md"]).toContain("Keep this authored area body.");
  expect(plan.files["projects/brandsolidate/sample-brand/ops/AREA.md"]).toContain("https://github.com/example-fixture/sample-repo");
  expect(plan.files["projects/brandsolidate/sample-brand/ops/memories/system-fact.md"]).toContain("[[brand-fact]]");
  expect(plan.files["projects/brandsolidate/sample-brand/product/AREA.md"]).toContain("sample-line: Synthetic product line");
  expect(plan.files["projects/brandsolidate/bank/memories/team-pointers.md"]).toContain("[[holding-fact]]");
  expect(plan.files["projects/brandsolidate/ORG.md"]).toBeDefined();
  expect(plan.files["projects/brandsolidate/holding/PROJECT.md"]).toBeDefined();
  expect(Object.keys(plan.files).some((path) => /^(brands|shared)\//.test(path) || /SYSTEM\.md$/.test(path))).toBe(false);
  expect(plan.files["INDEX.md"]).toBeUndefined();
  expect(plan.files[".github/workflows/secrets.yml"]).toBe(TEAM_MIGRATION_FIXTURE[".github/workflows/secrets.yml"]);
  expect(plan.files[".github/workflows/validate.yml"]).toContain("node .agent-harness/validate.mjs");
  expect(JSON.stringify(TEAM_MIGRATION_FIXTURE)).toBe(source);
});

it("keeps unmapped shared facts and undeclared product topics visible as approval inputs with honest counts", () => {
  const plan = planBankMigration(TEAM_MIGRATION_FIXTURE, { ...TEAM_MIGRATION_CHOICES, scopeMoves: undefined, topicDeclarations: undefined }, target);
  expect(plan.report.valid).toBe(false);
  expect(plan.report.memories).toEqual({ before: 4, after: 5, added: 1 });
  expect(plan.files["shared/ops/memories/holding-fact.md"]).toBe(TEAM_MIGRATION_FIXTURE["shared/ops/memories/holding-fact.md"]);
  expect(plan.report.decisions).toContainEqual(expect.objectContaining({ path: "shared/ops/memories/holding-fact.md", value: "scope" }));
  expect(plan.report.findings).toContainEqual(expect.objectContaining({ rule: "undeclared_topic" }));
  expect(plan.report.preservation).toMatchObject({ names: false, counts: false });
});

it("refuses collisions and shared moves outside the holding project without changing the source", () => {
  const bank = { ...TEAM_MIGRATION_FIXTURE, "projects/brandsolidate/sample-brand/PROJECT.md": "Keep this existing destination.\n" };
  const source = JSON.stringify(bank);
  expect(() => planBankMigration(bank, TEAM_MIGRATION_CHOICES, target)).toThrow("must not replace");
  expect(JSON.stringify(bank)).toBe(source);
  expect(() => planBankMigration(TEAM_MIGRATION_FIXTURE, { ...TEAM_MIGRATION_CHOICES, scopeMoves: { "shared/ops/": "fixture-team:brandsolidate/sample-brand/ops/" } }, target)).toThrow("holding project");
});

it("preserves holding facts directly in a project when there is no system area", () => {
  const bank = { ...TEAM_MIGRATION_FIXTURE };
  bank["shared/PROJECT.md"] = bank["shared/ops/SYSTEM.md"]!;
  bank["shared/memories/holding-fact.md"] = bank["shared/ops/memories/holding-fact.md"]!;
  delete bank["shared/ops/SYSTEM.md"];
  delete bank["shared/ops/memories/holding-fact.md"];
  const plan = planBankMigration(bank, { ...TEAM_MIGRATION_CHOICES, scopeMoves: { "shared/": "fixture-team:brandsolidate/holding/" } }, target);
  expect(plan.report.valid, JSON.stringify(plan.report)).toBe(true);
  expect(plan.report.preservation).toEqual({ names: true, links: true, counts: true });
  expect(plan.report.memories).toEqual({ before: 4, after: 5, added: 1 });
  expect(plan.files["projects/brandsolidate/holding/memories/holding-fact.md"]).toBe(bank["shared/memories/holding-fact.md"]);
});

it("returns preservation evidence and a heads-up draft with pending human approvals, never a send or landing date", () => {
  const plan = planBankMigration(TEAM_MIGRATION_FIXTURE, TEAM_MIGRATION_CHOICES, target);
  expect(plan.report.preservation).toEqual({ names: true, links: true, counts: true });
  expect(plan.report.headsUp?.title).toBe("Team bank contract migration: heads-up before switch-over");
  expect(plan.report.headsUp?.body).toContain("Albert");
  expect(plan.report.headsUp?.body).toContain("projects/brandsolidate/holding/");
  expect(plan.report.headsUp?.body).toContain("product lines become declared topics");
  expect(plan.report.headsUp?.body).toContain("owners: [david-systemtech]");
  expect(plan.report.headsUp?.body).toContain("4 existing memories");
  expect(plan.report.headsUp?.body).toContain("No landing date is set");
  expect(plan.report.headsUp?.body).toContain("#94");
  expect(plan.report.headsUp?.body).toContain("sole owner merges manually");
  expect(plan.report.headsUp?.body).toContain("David must post this issue before any landing");
});
