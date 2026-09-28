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
  "forge/origin.json": {
    valid: ["https://github.com", "https://git.systemtech.dev:5526", "http://100.101.102.103:3000", "http://nas.lan:443", "http://[fd7a:115c:a1e0::1]:3000"],
    invalid: [
      "https://github.com/",
      "https://github.com:443",
      "http://nas.lan:80",
      "https://GitHub.com",
      "ssh://github.com",
      "https://x-access-token@github.com",
      "https://github.com/david/agent-harness",
      "https://github.com:0",
      "https://github.com:65536",
      "github.com",
      "",
    ],
  },
};
