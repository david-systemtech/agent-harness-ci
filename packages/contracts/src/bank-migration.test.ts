import { expect, it } from "vitest";
import { BankMigrationChoices, exportedSchemas, methods } from "./index.js";

it("publishes migration exactly once as an admin command requiring commandId and dryRun", () => {
  const matches = methods.filter((method) => method.name === "banks.migrate");
  expect(matches).toHaveLength(1);
  expect(matches[0]).toMatchObject({ scope: "admin", kind: "command" });
  expect(matches[0]?.params.safeParse({ bankId: "b2f6a1c9-7e04-4b5a-8c32-3d7f5e1a9b00", dryRun: true }).success).toBe(false);
  expect(exportedSchemas().map((schema) => schema.path)).toEqual(expect.arrayContaining(["banks/migration-choices.json", "banks/migration-report.json", "banks/events/bank.awaiting-review.json", "errors/validation_failed.json", "errors/bank_read_only.json"]));
});
it("requires an org and owner for team authoring and rejects escaped or foreign scope shapes", () => {
  expect(BankMigrationChoices.safeParse({ team: { org: "meadowstudios", owners: ["david-systemtech"] }, scopeMoves: { "shared/ops/": "fixture-team:meadowstudios/holding/ops/" }, topicDeclarations: { "fixture-team:meadowstudios/sample-brand/product/": { "sample-line": "Synthetic product facts" } } }).success).toBe(true);
  for (const choices of [{ team: { org: "../outside", owners: ["owner"] } }, { team: { org: "team", owners: [] } }, { scopeMoves: { "shared/../": "fixture-team:team/holding/" } }, { scopeMoves: { "shared/ops/": "fixture-team:team/holding/../../" } }, { topicDeclarations: { "fixture-team:team/brand/product/": { "../outside": "Facts" } } }]) {
    expect(BankMigrationChoices.safeParse(choices).success).toBe(false);
  }
});
it("accepts explicit repository identities and topic authoring while refusing directory mappings and repair path escapes", () => {
  expect(BankMigrationChoices.safeParse({ repositoryMappings: { lab: "https://github.com/maya-reyes/homelab" } }).success).toBe(true);
  expect(BankMigrationChoices.safeParse({ repositoryMappings: { lab: "homelab" } }).success).toBe(false);
  expect(BankMigrationChoices.safeParse({ artefactRepairs: { "projects/personal/homelab/PROJECT.md": "---\nline: Lab\n---\n" } }).success).toBe(true);
  expect(BankMigrationChoices.safeParse({ artefactRepairs: { "projects/personal/../PROJECT.md": "text" } }).success).toBe(false);
  expect(BankMigrationChoices.safeParse({ artefactRepairs: { "brands/sample-brand/ops/SYSTEM.md": "---\nsummary: Synthetic operations\n---\nKeep the body.\n" } }).success).toBe(true);
  expect(BankMigrationChoices.safeParse({ artefactRepairs: { "shared/../SYSTEM.md": "text" } }).success).toBe(false);
});
