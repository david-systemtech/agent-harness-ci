/**
 * Fixtures for the Managed tools schemas, `tools.list` and `tools.verify`
 * (key-managers spec, "Managed tools"; ADR 0026): a valid and an invalid
 * instance of every managed-tools schema the export writes, the table's
 * entry, the row, a verify command's outcome and the notice's payload among
 * them. `fixtures.ts` folds them into the package's fixture table.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const at = "2026-09-24T01:02:03.456Z";

const gh = {
  tool: "gh",
  label: "GitHub CLI",
  path: "/usr/local/bin/gh",
  realpath: "/opt/homebrew/Cellar/gh/2.63.2/bin/gh",
  version: "2.63.2",
  minimum: "2.40.0",
  method: "homebrew",
  status: "current",
  action: "update",
};
const missing = { tool: "op", label: "1Password CLI", path: null, realpath: null, version: null, minimum: "2.18.0", method: null, status: "not-installed", action: "install" };
const claude = {
  tool: "claude",
  label: "claude in your terminal",
  path: "/home/david/.local/bin/claude",
  realpath: "/home/david/.local/share/claude/versions/2.1.283",
  version: "2.1.283",
  minimum: null,
  method: "native",
  status: "current",
  action: "update",
};
const hung = { ...gh, version: null, status: "below-minimum" };
const passed = { tool: "bao", outcome: "passed", reason: "bao looked up its run token at https://bao.systemtech.dev:8200: policies default, agent-read." };
const sealed = { tool: "vault", outcome: "failed", reason: "OpenBao at https://bao.systemtech.dev:8200 is sealed: unseal it, then verify again." };
const notInstalled = { tool: "gh", outcome: "not-installed", reason: "gh is not installed on this environment." };

export const managedToolSchemaFixtures: Record<string, Fixtures> = {
  "managed-tools/name.json": { valid: ["claude", "bao", "vault", "doppler", "op", "bws", "gh"], invalid: ["codex", "openbao", ""] },
  "managed-tools/version.json": { valid: ["2.63.2", "2.40", "2.1.0-beta.1", "1.14.0+ent"], invalid: ["v2.63.2", "2", "2.63.2 (2024-12-05)", ""] },
  "managed-tools/tool.json": {
    valid: [
      { name: "bao", label: "OpenBao CLI", minimum: "2.1.1", verify: ["token", "lookup"], requiredFor: { kind: "key-manager", provider: "openbao" } },
      { name: "gh", label: "GitHub CLI", minimum: "2.40.0", verify: ["auth", "status"], requiredFor: { kind: "forge-gh" } },
      { name: "claude", label: "claude in your terminal", minimum: null, verify: null, requiredFor: { kind: "never" } },
    ],
    invalid: [
      { name: "bao", label: "OpenBao CLI", minimum: null, verify: ["token", "lookup"], requiredFor: { kind: "key-manager", provider: "openbao" } },
      { name: "gh", label: "GitHub CLI", minimum: "2.40.0", verify: null, requiredFor: { kind: "forge-gh" } },
      { name: "gh", label: "GitHub CLI", minimum: "2.40.0", verify: ["auth status"], requiredFor: { kind: "forge-gh" } },
      { name: "gh", label: "GitHub CLI", minimum: "2.40.0", verify: [], requiredFor: { kind: "forge-gh" } },
      { name: "bao", label: "OpenBao CLI", minimum: "2.1.1", verify: ["token", "lookup"], requiredFor: { kind: "key-manager", provider: "keychain" } },
    ],
  },
  "managed-tools/install-method.json": { valid: ["homebrew", "winget", "npm", "native", "apt", "dnf", "manual", "unknown"], invalid: ["brew", "cargo", ""] },
  "managed-tools/status.json": { valid: ["current", "update-available", "below-minimum", "not-installed", "method-unknown"], invalid: ["outdated", "installed", ""] },
  "managed-tools/action.json": { valid: ["install", "update", "copy"], invalid: ["upgrade", "ignore", ""] },
  "managed-tools/row.json": {
    valid: [gh, missing, claude, hung],
    invalid: [{ ...gh, status: "outdated" }, { ...gh, version: "v2.63.2" }, { ...gh, path: "" }, { tool: "gh", status: "current", action: "update" }],
  },
  "managed-tools/verifiable-name.json": { valid: ["bao", "vault", "doppler", "op", "bws", "gh"], invalid: ["claude", "codex", ""] },
  "managed-tools/verify-outcome.json": { valid: ["passed", "failed", "not-installed"], invalid: ["sealed", "skipped", ""] },
  "managed-tools/verification.json": { valid: [passed, sealed, notInstalled], invalid: [{ ...passed, tool: "claude" }, { ...passed, outcome: "sealed" }, { ...passed, reason: "" }, { ...sealed, reason: "sealed\nunseal it" }, { tool: "bao", outcome: "passed" }] },
  "managed-tools/events/tools.updated.json": { valid: [{ tools: [gh] }, { tools: [missing, claude] }], invalid: [{ tools: [] }, {}, { tools: [{ ...gh, action: "ignore" }] }] },
};

export const managedToolMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "tools.list": {
    params: { valid: [{}, { refresh: true }, { refresh: false }], invalid: [{ refresh: "yes" }, []] },
    result: {
      valid: [{ tools: [claude, gh, missing], probedAt: at }, { tools: [], probedAt: at }],
      invalid: [{ tools: [gh] }, { tools: [{ ...gh, method: "brew" }], probedAt: at }, { probedAt: at }],
    },
  },
  "tools.verify": {
    params: { valid: [{ tool: "bao" }, { tool: "gh" }], invalid: [{}, { tool: "claude" }, { tool: "openbao" }] },
    result: { valid: [passed, sealed, notInstalled], invalid: [{}, { ...passed, outcome: "unknown" }, { ...passed, reason: "two\nlines" }] },
  },
};

/** The notice as the environment stream carries it, for the notice fixtures. */
export const toolsUpdatedNotice = { valid: { type: "tools.updated", payload: { tools: [gh] } }, invalid: { type: "tools.updated", payload: { tools: [] } } } as const;
