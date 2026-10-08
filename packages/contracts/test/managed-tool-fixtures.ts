/**
 * Fixtures for the Managed tools schemas, `tools.list`, `tools.detail` and
 * `tools.verify` (key-managers spec, "Managed tools"; ADR 0026): a valid
 * and an invalid instance of every managed-tools schema the export writes,
 * the table's entry, the row, a verify command's outcome, a doctor's report,
 * a tool's detail and the notice's payload among them. `fixtures.ts` folds
 * them into the package's fixture table.
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
  latest: "2.63.2",
  minimum: "2.40.0",
  method: "homebrew",
  status: "current",
  action: "update",
  command: null,
};
const missing = { tool: "op", label: "1Password CLI", path: null, realpath: null, version: null, latest: null, minimum: "2.18.0", method: null, status: "not-installed", action: "install", command: null };
const claude = {
  tool: "claude",
  label: "claude in your terminal",
  path: "/home/david/.local/bin/claude",
  realpath: "/home/david/.local/share/claude/versions/2.1.283",
  version: "2.1.283",
  latest: "2.1.285",
  minimum: null,
  method: "native",
  status: "update-available",
  action: "update",
  command: null,
};
const hung = { ...gh, version: null, latest: null, status: "below-minimum" };
const copied = { ...gh, realpath: "/home/david/.local/share/mise/installs/gh/2.63.2/bin/gh", method: "mise", action: "copy", command: "brew install gh" };
const typedOut = { ...gh, method: "unknown", status: "method-unknown", action: "terminal", command: "brew install gh" };
const field = { name: "Running", value: "npm-global (2.1.283)" };
const warning = { issue: "Running native installation but config install method is 'unknown'", fix: "Run claude install to update configuration" };
const doctorRead = { outcome: "read", method: "npm", fields: [field, { name: "Config install method", value: "unknown" }], warnings: [warning] };
const doctorFailed = { outcome: "failed", reason: "claude doctor gave no answer within 30 s." };
const detail = { tool: "claude", row: claude, doctor: doctorRead };
const passed = { tool: "bao", outcome: "passed", reason: "bao looked up its run token at https://bao.example.com:8200: policies default, agent-read." };
const sealed = { tool: "vault", outcome: "failed", reason: "OpenBao at https://bao.example.com:8200 is sealed: unseal it, then verify again." };
const notInstalled = { tool: "gh", outcome: "not-installed", reason: "gh is not installed on this environment." };

const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const terminalId = "4d3c2b1a-9e8f-4a7b-8c6d-5e4f3a2b1c0d";
const brewInstall = [[["brew", "install", "gh"]]];
const aptInstall = [
  [["sudo", "install", "-d", "-m", "0755", "/etc/apt/keyrings"]],
  [["printf", "%s\\n", "deb [signed-by=/etc/apt/keyrings/example.asc] https://example.test/deb stable main"], ["sudo", "tee", "/etc/apt/sources.list.d/example.list"]],
  [["sudo", "apt-get", "install", "gh"]],
];
const entry = { tool: "gh", method: "homebrew", platforms: ["darwin", "linux"], needs: ["brew"], install: brewInstall, update: [[["brew", "upgrade", "gh"]]] };
const toolTerminal = { id: terminalId, owner: "managed-tools", sessionId: null, openedAt: at, cols: 80, rows: 24, exitCode: null, signal: null };
const runStarted = { tool: "gh", action: "install", method: "homebrew", terminalId, command: "brew install gh" };
const typedOutStarted = { tool: "op", action: "terminal", method: "homebrew", terminalId, command: "brew install --cask 1password-cli" };
const runFinished = { tool: "gh", action: "install", method: "homebrew", terminalId, exitCode: 0, signal: null, cause: "exited", verification: { tool: "gh", outcome: "passed", reason: "gh auth status passed." } };
const notRunnable = { code: "tool_not_runnable", message: "gh installed by mise is not updated by the harness.", data: { tool: "gh", action: "update", command: "brew install gh" } };

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
  "managed-tools/action.json": { valid: ["install", "update", "terminal", "copy"], invalid: ["upgrade", "ignore", ""] },
  "managed-tools/row.json": {
    valid: [gh, missing, claude, hung, copied, typedOut],
    invalid: [{ ...gh, status: "outdated" }, { ...gh, version: "v2.63.2" }, { ...gh, path: "" }, { tool: "gh", status: "current", action: "update" }, { ...copied, command: "brew install gh\nrm -rf ~" }],
  },
  "managed-tools/verifiable-name.json": { valid: ["bao", "vault", "doppler", "op", "bws", "gh"], invalid: ["claude", "codex", ""] },
  "managed-tools/verify-outcome.json": { valid: ["passed", "failed", "not-installed"], invalid: ["sealed", "skipped", ""] },
  "managed-tools/verification.json": { valid: [passed, sealed, notInstalled], invalid: [{ ...passed, tool: "claude" }, { ...passed, outcome: "sealed" }, { ...passed, reason: "" }, { ...sealed, reason: "sealed\nunseal it" }, { tool: "bao", outcome: "passed" }] },
  "managed-tools/doctor-name.json": { valid: ["claude"], invalid: ["gh", "codex", ""] },
  "managed-tools/doctor-field.json": { valid: [field, { name: "Last update attempt", value: "" }], invalid: [{ name: "", value: "x" }, { name: "Path", value: "a\nb" }, { name: "Path" }] },
  "managed-tools/doctor-warning.json": { valid: [warning, { issue: "Multiple installations found", fix: null }], invalid: [{ issue: "", fix: null }, { issue: "x" }, { issue: "x", fix: "" }] },
  "managed-tools/doctor-report.json": {
    valid: [doctorRead, { ...doctorRead, method: null, warnings: [] }, doctorFailed, { outcome: "not-installed" }],
    invalid: [{ ...doctorRead, method: "npm-global" }, { outcome: "failed" }, { outcome: "failed", reason: "a\nb" }, { outcome: "skipped" }],
  },
  "managed-tools/detail.json": {
    valid: [detail, { ...detail, doctor: doctorFailed }, { tool: "claude", row: { ...missing, tool: "claude", label: "claude in your terminal", minimum: null }, doctor: { outcome: "not-installed" } }],
    invalid: [{ ...detail, tool: "gh" }, { tool: "claude", doctor: doctorRead }, { ...detail, row: { ...claude, latest: "latest" } }],
  },
  "managed-tools/events/tools.updated.json": { valid: [{ tools: [gh] }, { tools: [missing, claude] }], invalid: [{ tools: [] }, {}, { tools: [{ ...gh, action: "ignore" }] }] },
  "managed-tools/command-platform.json": { valid: ["darwin", "linux", "win32"], invalid: ["macos", "windows", ""] },
  "managed-tools/command-method.json": { valid: ["homebrew", "winget", "apt", "dnf", "script", "npm", "scoop", "mise", "asdf", "manual"], invalid: ["native", "unknown", "brew", ""] },
  "managed-tools/installable-name.json": { valid: ["claude", "bao", "gh"], invalid: ["vault", "codex", ""] },
  "managed-tools/command.json": { valid: [brewInstall, aptInstall], invalid: [[], [[]], [[[]]], "brew install gh", [[["brew", "install", "gh\nrm -rf ~"]]]] },
  "managed-tools/command-entry.json": {
    valid: [
      entry,
      { ...entry, method: "npm", install: null },
      { ...entry, method: "apt", platforms: ["linux"], needs: ["apt-get", "sudo", "curl"], install: aptInstall },
      { ...entry, method: "mise", needs: ["mise"], install: null, update: [[["mise", "upgrade", "{package}"]]], package: "github-cli" },
    ],
    invalid: [{ ...entry, tool: "vault" }, { ...entry, platforms: [] }, { ...entry, method: "native" }, { ...entry, update: null }, { ...entry, needs: ["brew install"] }, { ...entry, package: "--all" }, { ...entry, package: "../gh" }],
  },
  "managed-tools/command-line.json": { valid: ["brew install gh", "curl -Ls --proto '=https' https://cli.doppler.com/install.sh | sh"], invalid: ["", "brew install gh\nbrew install doppler", "a\rb"] },
  "managed-tools/runnable-action.json": { valid: ["install", "update", "terminal"], invalid: ["copy", ""] },
  "managed-tools/run-conflict-reason.json": { valid: ["tool_run_in_progress", "exists", "pty_unavailable"], invalid: ["in_progress", ""] },
  "managed-tools/errors/tool_not_runnable.json": {
    valid: [notRunnable, { ...notRunnable, data: { tool: "vault", action: "update", command: null } }],
    invalid: [{ ...notRunnable, code: "conflict" }, { ...notRunnable, data: { tool: "gh", action: "copy", command: null } }, { ...notRunnable, data: { tool: "gh", action: "update", command: "a\nb" } }],
  },
  "managed-tools/events/tool.run-started.json": { valid: [runStarted, typedOutStarted], invalid: [{ ...runStarted, tool: "vault" }, { ...runStarted, command: "" }, { ...runStarted, terminalId: "t-1" }] },
  "managed-tools/events/tool.run-finished.json": {
    valid: [runFinished, { ...runFinished, exitCode: null, cause: "closed", verification: null }, { ...runFinished, exitCode: -1, cause: "failed" }],
    invalid: [{ ...runFinished, cause: "deleted" }, { ...runFinished, exitCode: 1.5 }, { ...runFinished, verification: undefined }],
  },
};

export const managedToolMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "tools.list": {
    params: { valid: [{}, { refresh: true }, { refresh: false }], invalid: [{ refresh: "yes" }, []] },
    result: {
      valid: [{ tools: [claude, gh, missing], probedAt: at }, { tools: [], probedAt: at }],
      invalid: [{ tools: [gh] }, { tools: [{ ...gh, method: "brew" }], probedAt: at }, { probedAt: at }],
    },
  },
  "tools.detail": {
    params: { valid: [{ tool: "claude" }], invalid: [{}, { tool: "gh" }, { tool: "codex" }] },
    result: { valid: [detail, { ...detail, doctor: doctorFailed }], invalid: [{}, { ...detail, doctor: { outcome: "unknown" } }, { ...detail, row: { ...claude, status: "outdated" } }] },
  },
  "tools.verify": {
    params: { valid: [{ tool: "bao" }, { tool: "gh" }], invalid: [{}, { tool: "claude" }, { tool: "openbao" }] },
    result: { valid: [passed, sealed, notInstalled], invalid: [{}, { ...passed, outcome: "unknown" }, { ...passed, reason: "two\nlines" }] },
  },
  "tools.run": {
    params: {
      valid: [
        { commandId, tool: "gh", action: "install", id: terminalId },
        { commandId, tool: "vault", action: "install", id: terminalId, cols: 120, rows: 40 },
      ],
      invalid: [{ commandId, tool: "gh", action: "copy", id: terminalId }, { commandId, tool: "gh", action: "install" }, { tool: "gh", action: "install", id: terminalId }],
    },
    result: {
      valid: [
        { terminal: toolTerminal, tool: "gh", action: "install", method: "homebrew", command: "brew install gh", doctor: null },
        { terminal: toolTerminal, tool: "claude", action: "update", method: "script", command: "claude update", doctor: doctorRead },
      ],
      invalid: [
        { terminal: { ...toolTerminal, owner: "session", sessionId: commandId }, tool: "gh", action: "install", method: "homebrew", command: "brew install gh", doctor: null },
        { terminal: toolTerminal, tool: "vault", action: "install", method: "homebrew", command: "brew install gh", doctor: null },
        { terminal: toolTerminal, tool: "gh", action: "install", method: "homebrew", command: "brew install gh" },
        { terminal: toolTerminal, tool: "gh", action: "install", method: "homebrew", command: "brew install gh\nbrew install doppler", doctor: null },
      ],
    },
  },
};

/** The notice as the environment stream carries it, for the notice fixtures. */
export const toolsUpdatedNotice = { valid: { type: "tools.updated", payload: { tools: [gh] } }, invalid: { type: "tools.updated", payload: { tools: [] } } } as const;

/** The tool run events as the environment stream carries them, for the notice fixtures. */
export const toolRunNotices = {
  valid: [
    { type: "tool.run-started", payload: runStarted },
    { type: "tool.run-finished", payload: runFinished },
  ],
  invalid: [
    { type: "tool.run-started", payload: { ...runStarted, action: "copy" } },
    { type: "tool.run-finished", payload: { ...runFinished, exitCode: undefined } },
  ],
} as const;
