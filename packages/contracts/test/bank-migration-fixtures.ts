const report = { valid: true, memories: { before: 5, after: 6, added: 1 }, renames: [{ path: "BANK.md", from: "description", to: "purpose" }], moves: [], findings: [], decisions: [], proposals: [] };
const commandId = "5b1c6f3e-2a4d-4e8f-9b0a-1c2d3e4f5a6b";
const bankId = "b2f6a1c9-7e04-4b5a-8c32-3d7f5e1a9b00";
const choices = { repositoryMappings: { lab: "https://github.com/maya-reyes/homelab" }, topics: { "maya-memory:personal/homelab/": { backup: { line: "Backup facts", memories: ["backup-schedule"] } } } };
const teamChoices = { team: { org: "brandsolidate", owners: ["david-systemtech"] }, scopeMoves: { "shared/ops/": "fixture-team:brandsolidate/holding/ops/" }, topicDeclarations: { "fixture-team:brandsolidate/sample-brand/product/": { "sample-line": "Synthetic product facts" } } };
export const bankMigrationSchemaFixtures = {
  "banks/migration-choices.json": { valid: [{}, choices, teamChoices], invalid: [{ repositoryMappings: { lab: "homelab" } }, { artefactRepairs: { "../BANK.md": "text" } }, { retiredWorkflows: ["../BANK.md"] }, { team: { org: "team", owners: [] } }, { scopeMoves: { "shared/../": "fixture-team:team/holding/" } }] },
  "banks/migration-report.json": { valid: [report, { ...report, preservation: { names: true, links: true, counts: true }, headsUp: { title: "Fixture heads-up", body: "Draft only; no date is set." } }], invalid: [{ ...report, memories: { before: -1, after: 5, added: 0 } }, { ...report, findings: [{}] }, { ...report, preservation: { names: "yes", links: true, counts: true } }, { ...report, headsUp: { title: "Missing body" } }] },
};
export const bankMigrationMethodFixtures = {
  "banks.migrate": { params: { valid: [{ commandId, bankId, dryRun: true }, { commandId, bankId, dryRun: false, choices }], invalid: [{ bankId, dryRun: true }, { commandId, bankId }, { commandId, bankId, dryRun: "yes" }] }, result: { valid: [{ report, landing: null }], invalid: [{ report }, { report: {}, landing: null }] } },
};
