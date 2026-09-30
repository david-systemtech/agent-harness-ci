/**
 * Fixtures for Carry over (#578, #580): the inventory's counts (sessions,
 * memory, skills, what does not carry), what an import did (the sessions,
 * a memory folder's copy, the memory), a failure, the `carry-over.imported`
 * and `carry-over.memory-assigned` payloads, the report, and the three
 * methods' params and results. A valid and an invalid instance of each file
 * the export writes; `fixtures.ts` folds them into the package's table.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const accountId = "claude-max";

const inventory = { total: 42, archived: 7, missingDirectory: 3, new: 5 };
const nothing = { total: 0, archived: 0, missingDirectory: 0, new: 0 };
const folder = { folder: "-work-agent-harness", path: "/home/david/.claude/projects/-work-agent-harness/memory" };
const lost = { folder: "-tmp-scratch-pad", path: "/home/david/.claude/projects/-tmp-scratch-pad/memory" };
const memoryInventory = { folders: 3, repositories: 2, unmappable: [lost], new: 1 };
const offer = { name: "handoff", from: "/home/david/.claude/skills/handoff", url: "https://git.example.com/david/agent-skills.git", folder: "skills/handoff", follow: { kind: "branch", branch: "main" } };
const skillsInventory = { skills: 4, commands: 2, new: 3, offered: [offer], invalid: 1 };
const doesNotCarry = { hooks: 3, mcpServers: 2, permissionRules: 11 };
const notCarried = [
  { kind: "subagent", name: "reviewer" },
  { kind: "plugin", name: "formatter@marketplace" },
];
const fullInventory = { accountId, sessions: inventory, memory: memoryInventory, skills: skillsInventory, notCarried, doesNotCarry };
// The digests are placeholders of the right shape; an import computes real ones.
const digest = `sha256:${"0".repeat(64)}`;
const copy = { ...folder, key: "https://git.systemtech.dev/david/agent-harness", outcome: "copied", under: null, digest };
const carried = { ...folder, key: "/work/agent-harness", outcome: "carried", under: "carried/-work-agent-harness", digest: `sha256:${"1".repeat(64)}` };
const memory = { folders: [copy, carried], unmappable: [lost] };
const sessions = { listed: 42, imported: 5, archived: 1, missingDirectory: 2, held: 36 };
const failure = { providerSessionId: "5c1b7a3e-8f2d-4b6a-9e0c-2d4f6a8b0c1e", message: "Its working directory relative/path is not an absolute path on this environment." };
const unreadable = { providerSessionId: null, message: "Listing the sessions in /home/david/.claude failed: EACCES." };
const uncopied = { providerSessionId: null, folder: "-work-agent-harness", message: "Copying the memory folder failed: EACCES." };
const skillsReport = { accountId, dryRun: false, copied: [], kept: [], offered: [offer], invalid: [], notCarried };
const imported = { accountId, sessions, memory, failed: [failure] };
const report = { ...imported, dryRun: false };
const assigned = { accountId, repositoryIdentity: "https://git.systemtech.dev/david/agent-harness", copy };

/** Schema instances, by the file the export writes. */
export const carryOverSchemaFixtures: Record<string, Fixtures> = {
  "carry-over/sessions-inventory.json": {
    valid: [inventory, nothing],
    invalid: [{ ...inventory, new: -1 }, { total: 1, archived: 0, missingDirectory: 0 }, { ...inventory, total: 1.5 }],
  },
  "carry-over/memory-folder-name.json": {
    valid: ["-work-agent-harness", "C--Users-david-work", "..."],
    invalid: ["", ".", "..", "a/b", "a\\b"],
  },
  "carry-over/memory-outcome.json": {
    valid: ["copied", "carried", "kept"],
    invalid: ["moved", "held", ""],
  },
  "carry-over/memory-folder.json": {
    valid: [folder, lost],
    invalid: [{ ...folder, folder: "a/b" }, { ...folder, folder: ".." }, { ...folder, path: "relative/memory" }, { path: folder.path }],
  },
  "carry-over/memory-inventory.json": {
    valid: [memoryInventory, { folders: 0, repositories: 0, unmappable: [], new: 0 }],
    invalid: [{ ...memoryInventory, unmappable: 1 }, { ...memoryInventory, new: -1 }, { folders: 1, repositories: 1, unmappable: [] }],
  },
  "carry-over/skills-inventory.json": {
    valid: [skillsInventory, { skills: 0, commands: 0, new: 0, offered: [], invalid: 0 }],
    invalid: [{ ...skillsInventory, offered: 1 }, { ...skillsInventory, commands: -1 }, { skills: 1, commands: 0, new: 0, offered: [] }],
  },
  "carry-over/does-not-carry.json": {
    valid: [doesNotCarry, { hooks: 0, mcpServers: 0, permissionRules: 0 }],
    invalid: [{ ...doesNotCarry, hooks: -1 }, { hooks: 1, mcpServers: 1 }],
  },
  "carry-over/inventory.json": {
    valid: [fullInventory, { ...fullInventory, notCarried: [] }],
    invalid: [{ accountId, sessions: inventory }, { ...fullInventory, accountId: "" }, { ...fullInventory, doesNotCarry: { hooks: 1 } }, { ...fullInventory, notCarried: [{ kind: "hook", name: "x" }] }],
  },
  "carry-over/memory-copy.json": {
    valid: [copy, carried, { ...copy, outcome: "kept" }],
    invalid: [{ ...copy, outcome: "moved" }, { ...copy, digest: "0" }, { ...carried, under: "elsewhere/x" }, { ...copy, key: "" }],
  },
  "carry-over/memory-imported.json": {
    valid: [memory, { folders: [], unmappable: [] }],
    invalid: [{ folders: [copy] }, { folders: [{ ...copy, outcome: "lost" }], unmappable: [] }],
  },
  "carry-over/sessions-imported.json": {
    valid: [sessions, { listed: 0, imported: 0, archived: 0, missingDirectory: 0, held: 0 }],
    invalid: [{ ...sessions, held: -1 }, { listed: 1, imported: 1, archived: 0, missingDirectory: 0 }],
  },
  "carry-over/failure.json": {
    valid: [failure, unreadable, uncopied],
    invalid: [{ providerSessionId: "", message: "x" }, { providerSessionId: null, message: "" }, { message: "No id at all." }, { ...uncopied, folder: "" }],
  },
  "carry-over/notices/carry-over.imported.json": {
    valid: [
      imported,
      { ...imported, skills: skillsReport, failed: [uncopied] },
      // An import recorded before memory was carried (#580).
      { accountId, sessions, failed: [] },
      { accountId, sessions: { listed: 0, imported: 0, archived: 0, missingDirectory: 0, held: 0 }, failed: [unreadable] },
    ],
    invalid: [{ accountId, sessions }, { accountId, sessions: inventory, failed: [] }, { ...imported, failed: [{ message: "" }] }, { ...imported, skills: { accountId } }],
  },
  "carry-over/notices/carry-over.memory-assigned.json": {
    valid: [assigned, { ...assigned, copy: carried }],
    invalid: [{ ...assigned, repositoryIdentity: "/work/agent-harness" }, { accountId, copy }, { ...assigned, copy: folder }],
  },
  "carry-over/report.json": {
    valid: [report, { ...imported, skills: skillsReport, failed: [], dryRun: true }],
    invalid: [imported, { ...report, dryRun: "yes" }, { accountId, sessions, failed: [], dryRun: false }],
  },
};

/** Params and result instances for Carry over's methods. */
export const carryOverMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "carryOver.inventory": {
    params: { valid: [{ accountId }], invalid: [{}, { accountId: "" }, { accountId: 7 }] },
    result: {
      valid: [fullInventory],
      invalid: [{ ...fullInventory, sessions: { ...inventory, archived: -2 } }, { accountId, sessions: inventory }, { accountId }],
    },
  },
  "carryOver.run": {
    params: {
      valid: [
        { commandId, accountId, dryRun: false, skills: true },
        { commandId, accountId, dryRun: true, skills: false },
      ],
      invalid: [{ commandId, accountId, dryRun: false }, { commandId, accountId, skills: true }, { accountId, dryRun: false, skills: false }],
    },
    result: {
      valid: [report, { ...imported, dryRun: true }, { ...report, skills: skillsReport }],
      invalid: [imported, { ...report, sessions: inventory }, { ...report, memory: undefined }],
    },
  },
  "carryOver.assignMemory": {
    params: {
      valid: [{ commandId, accountId, folder: lost.folder, repositoryIdentity: "https://git.systemtech.dev/david/agent-harness" }],
      invalid: [
        { commandId, accountId, folder: "a/b", repositoryIdentity: "https://git.systemtech.dev/david/agent-harness" },
        { commandId, accountId, folder: lost.folder, repositoryIdentity: "/work/agent-harness" },
        { accountId, folder: lost.folder, repositoryIdentity: "https://git.systemtech.dev/david/agent-harness" },
      ],
    },
    result: {
      valid: [assigned],
      invalid: [{ ...assigned, copy: { ...copy, outcome: "lost" } }, { accountId }],
    },
  },
};
