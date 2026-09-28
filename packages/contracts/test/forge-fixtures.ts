/**
 * Fixtures for the forge schemas (forge spec; ADR 0020): a valid and an
 * invalid instance of every forge schema the export writes. `fixtures.ts`
 * folds them into the package's fixture table.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

export const forgeSchemaFixtures: Record<string, Fixtures> = {
  "forge/kind.json": { valid: ["github", "forgejo", "gitea", "gitlab"], invalid: ["GitHub", "bitbucket", ""] },
};
