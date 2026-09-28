/**
 * Fixtures for the row registry's schemas (ADR 0027; #389): a valid and an
 * invalid instance of the band, row, scope and address shapes and of
 * `StepId`. `fixtures.ts` folds them into the package's fixture table.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const permissions = {
  id: "access.permissions",
  band: "access",
  label: "Permissions",
  hint: "The default ceiling, the unattended mode, parked prompts, containment and the denylist.",
  scope: "environment",
  homeOf: ["permissions"],
  terms: ["permissions", "denylist"],
};
const setUp = { id: "setup.checklist", band: "setup", label: "Set up", hint: "Every step of the checklist.", scope: "environment", homeOf: "checklist", terms: [] };
const bots = { id: "routines.bots", band: "routines", label: "Bots", hint: "The bots that own routines.", scope: "environment", homeOf: [], terms: ["bots"], dim: "Bots arrive in milestone 2." };

export const settingsRowSchemaFixtures: Record<string, Fixtures> = {
  "settings/band-id.json": { valid: ["setup", "routines", "about"], invalid: ["Set up", "bots", ""] },
  "settings/band.json": { valid: [{ id: "routines", label: "Routines and bots" }], invalid: [{ id: "routines", label: "" }, { id: "sessions", label: "Sessions" }, { label: "Access" }] },
  "settings/row-scope.json": { valid: ["environment", "everywhere", "client"], invalid: ["Environment", "all", ""] },
  "settings/row-id.json": { valid: ["setup.checklist", "access.key-managers", "about.about"], invalid: ["secrets", "access.secrets", "Access.Permissions", ""] },
  "settings/row.json": {
    valid: [permissions, setUp, bots, { ...permissions, homeOf: [] }],
    invalid: [
      { ...permissions, scope: "all" },
      { ...permissions, homeOf: ["routines"] },
      { ...permissions, homeOf: "everything" },
      { ...permissions, hint: "" },
      { ...permissions, id: "access.secrets" },
      { ...bots, dim: "" },
      { ...permissions, terms: [""] },
      { id: "access.permissions", band: "access", label: "Permissions", scope: "environment", homeOf: [], terms: [] },
    ],
  },
  "settings/address.json": { valid: ["profiles", "memory-banks", "cerebro", "secrets", "advanced"], invalid: ["settings", "key-managers", "Profiles", ""] },
  "settings/address-row.json": {
    valid: [{ address: "secrets", row: "access.key-managers" }, { address: "cerebro", row: "knowledge.banks" }],
    invalid: [{ address: "vault", row: "access.key-managers" }, { address: "secrets", row: "access.secrets" }, { address: "secrets" }],
  },
  "setup/step-id.json": { valid: ["account", "carry-over", "forges", "appearance"], invalid: ["routines", "Account", ""] },
};
