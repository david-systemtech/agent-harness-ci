/**
 * Fixtures for the skills schemas (skills spec, "The skill set" and "Skill
 * sources"): a valid and an invalid instance of each schema the export
 * writes. Each invalid one is refused by the export too, so a part of a
 * rule the export's pattern does not hold (a credential in a URL, say) is
 * the rules' own tests', not these. `fixtures.ts` folds them into the
 * package's fixture table.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const sourceId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const commit = "c".repeat(40);
const origin = { kind: "repository", repository: "https://github.com/mattpocock/skills", path: "skills/engineering/tdd" };
const manifestOrigin = { kind: "manifest", repository: "https://github.com/mattpocock/skills", path: "skills/engineering/tdd", commit: "74ca5fe", licence: "MIT" };
const member = {
  name: "tdd",
  kind: "skill",
  path: "tdd",
  description: "Test-driven development.",
  invocation: "model+slash",
  userInvocable: true,
  argumentHint: null,
  whileActive: [],
  origin,
  layer: { kind: "source", sourceId },
  size: 4210,
  tokens: 1053,
  problems: [],
  warnings: [],
};
const invalidMember = {
  ...member,
  name: null,
  description: null,
  origin: null,
  layer: { kind: "own" },
  problems: [
    { kind: "name", message: "The member has no name that passes the skill-name rule: its frontmatter has no name; its folder's name \"TDD\" holds a character other than a-z, 0-9 and -." },
    { kind: "description", message: "The member has no description in its frontmatter." },
  ],
};
const source = {
  id: sourceId,
  url: "git@github.com:mattpocock/skills.git",
  identity: "https://github.com/mattpocock/skills",
  folder: "skills/engineering",
  follow: { kind: "branch", branch: null },
  position: 1,
  addedBy: { kind: "client_session", id: "cs-1" },
  addedAt: "2026-09-29T04:40:00.000Z",
};

const viewSource = { ...source, commit, skillCount: 1 };
const addedSource = { id: sourceId, url: source.url, identity: source.identity, folder: source.folder, follow: source.follow, position: 1 };

const own = { kind: "own" } as const;
const ownMember = { ...member, path: "skills/tdd", origin: manifestOrigin, layer: own };
const commandMember = { ...member, kind: "command", path: "commands/tdd.md", origin: null, layer: own, whileActive: ["allowed-tools"] };
const setMember = { ...ownMember, shadowedBy: null };
const shadowed = { ...commandMember, shadowedBy: { layer: own, path: "skills/tdd" } };
const runMember = {
  name: "tdd",
  description: "Test-driven development.",
  origin: manifestOrigin,
  invocation: "model+slash",
  userInvocable: true,
  argumentHint: "<feature>",
  native: false,
  alwaysOn: true,
};
const nativeRunMember = { ...runMember, name: "release", description: "Cut a release.", origin: null, invocation: "slash-only", argumentHint: null, native: true, alwaysOn: false };
const skillEntry = { kind: "skill", name: "tdd", description: "Test-driven development.", invocation: "model+slash", origin: manifestOrigin, alwaysOn: true, argumentHint: "<feature>" };
const runSkillSet = {
  generation: "/home/david/.local/state/agent-harness/skills/generations/3f9a",
  fingerprint: "3f9a",
  members: [runMember, nativeRunMember],
  hiddenNativeNames: ["triage"],
};
const choices = [
  { kind: "enabled", name: "tdd", accountId: null, enabled: false },
  { kind: "enabled", name: "tdd", accountId: "claude-max", enabled: true },
  { kind: "always-on", name: "unslop", accountId: "claude-max", on: true },
];
const tddChoices = { enabled: false, alwaysOn: false, choices: choices.slice(0, 2) };
const viewMember = { ...setMember, ...tddChoices };
const viewMembers = [viewMember, { ...shadowed, ...tddChoices }, { ...invalidMember, shadowedBy: null, enabled: true, alwaysOn: false, choices: [] }];
const viewAccounts = [
  { accountId: "claude-max", channel: "system-prompt-append", reason: null },
  { accountId: "local", channel: "none", reason: "Its adapter, Codex, has no instruction channel, so no always-on skill reaches its runs." },
];
const view = {
  ownDirectory: "/home/david/.local/state/agent-harness/skills/own",
  sources: [viewSource],
  choices,
  accountId: "claude-max",
  accounts: viewAccounts,
  members: viewMembers,
};
const commandId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const copiedSkill = { kind: "skill", name: "tdd", from: "/home/david/.claude/skills/tdd", path: "skills/tdd" };
const copiedCommand = { kind: "command", name: "review", from: "/home/david/.claude/commands/review.md", path: "commands/review.md" };
const offer = { name: "grill-me", from: "/home/david/.agents/skills/grill-me", url: "https://github.com/mattpocock/skills.git", folder: "skills/productivity/grill-me", follow: { kind: "branch", branch: "main" } };
const pinnedOffer = { ...offer, url: "git@github.com:mattpocock/skills.git", folder: ".", follow: { kind: "pinned", commit } };
const invalidOriginal = { kind: "skill", name: null, from: "C:\\Users\\david\\.claude\\skills\\Notes", problems: invalidMember.problems };
const report = {
  accountId: "claude-max",
  dryRun: false,
  copied: [copiedSkill, copiedCommand],
  kept: [{ ...copiedSkill, name: "handoff", from: "/home/david/.agents/skills/handoff", path: "skills/handoff" }],
  offered: [offer, pinnedOffer],
  invalid: [invalidOriginal],
  notCarried: [
    { kind: "subagent", name: "reviewer" },
    { kind: "plugin", name: "skills@mattpocock" },
  ],
};
const nothingCarried = { accountId: "claude-max", dryRun: true, copied: [], kept: [], offered: [], invalid: [], notCarried: [] };

/** Params and result instances for the skills methods. */
const probeId = "9b2e6f1c-3a4d-4e5f-8a7b-1c2d3e4f5a6b";
const probeMember = { name: "tdd", path: "tdd", description: "Test-driven development.", invocation: "model+slash", problems: [] };
const invalidProbeMember = { name: null, path: "TDD", description: null, invocation: "model+slash", problems: invalidMember.problems };
const probeFolder = { folder: "skills/engineering", members: [probeMember, invalidProbeMember], count: 1, licence: "skills/engineering/LICENSE" };
const rootFolder = { folder: ".", members: [{ ...probeMember, name: "unslop", path: "." }], count: 1, licence: null };
const probe = { probeId, identity: "https://github.com/mattpocock/skills", branch: "main", commit, root: null, folders: [probeFolder], truncated: false };
const probeUnreachable = { reason: "unreachable", problem: "authentication", line: "fatal: Authentication failed", origin: "https://github.com" };

export const skillMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "skills.probe": {
    params: {
      valid: [{ url: "https://github.com/mattpocock/skills" }, { url: "git@github.com:mattpocock/skills.git", branch: "main" }, { url: "ssh://git@git.example.com:2222/david/skills" }],
      invalid: [{}, { url: "-https://github.com/a/b" }, { url: "https://github.com/a/b?x=1" }, { url: "https://github.com/a/b", branch: "-f" }, { url: "https://github.com/a/b", branch: null }],
    },
    result: {
      valid: [probe, { ...probe, root: rootFolder, folders: [], truncated: true }],
      invalid: [
        { ...probe, probeId: "p-1" },
        { ...probe, identity: "git@github.com:mattpocock/skills.git" },
        { ...probe, commit: "main" },
        { ...probe, branch: null },
        { ...probe, truncated: undefined },
        { ...probe, folders: [{ ...probeFolder, folder: "../skills" }] },
        { ...probe, folders: [{ ...probeFolder, count: -1 }] },
      ],
    },
  },
  "skills.get": {
    params: { valid: [{}, { sessionId: sourceId }], invalid: [{ sessionId: "s-1" }, { sessionId: null }, []] },
    result: {
      valid: [view, { ...view, sources: [], choices: [], accountId: null, accounts: [], members: [] }],
      invalid: [
        { ...view, ownDirectory: "" },
        { ...view, accountId: undefined },
        { ...view, accounts: undefined },
        { ...view, members: [{ ...viewMember, shadowedBy: undefined }] },
        { ...view, members: [{ ...viewMember, shadowedBy: { layer: own } }] },
        { ...view, members: [setMember] },
        { ...view, choices: [{ kind: "always-on", name: "tdd", accountId: null, on: true }] },
        { ...view, sources: undefined },
        { ...view, sources: [source] },
      ],
    },
  },
  "skills.sources.add": {
    params: {
      valid: [
        { commandId, url: "https://github.com/theclaymethod/unslop", folder: ".", follow: { kind: "branch", branch: null } },
        { commandId, url: source.url, folder: "skills/engineering", follow: { kind: "pinned", commit }, probeId },
      ],
      invalid: [
        { commandId, url: "https://github.com/a/b?x=1", folder: ".", follow: { kind: "branch", branch: null } },
        { commandId, url: source.url, folder: "../skills", follow: { kind: "branch", branch: null } },
        { commandId, url: source.url, folder: "." },
        { commandId, url: source.url, folder: ".", follow: { kind: "branch", branch: null }, probeId: "p-1" },
        { url: source.url, folder: ".", follow: { kind: "branch", branch: null } },
      ],
    },
    result: { valid: [{ source: viewSource }, { source: { ...viewSource, skillCount: 0 } }], invalid: [{}, { source }, { source: { ...viewSource, commit: "main" } }] },
  },
  "skills.sources.remove": {
    params: { valid: [{ commandId, sourceId }], invalid: [{ commandId, sourceId: "s-1" }, { commandId }, { sourceId }] },
    result: { valid: [{ source: viewSource }], invalid: [{}, { source: { ...viewSource, skillCount: -1 } }] },
  },
  "skills.own.create": {
    params: {
      valid: [{ commandId, name: "tdd", description: "Test-driven development." }, { commandId, name: "a", description: "x".repeat(1024) }],
      invalid: [
        { commandId, name: "Test_Driven", description: "Test-driven development." },
        { commandId, name: "tdd", description: "" },
        { commandId, name: "tdd", description: "  " },
        { commandId, name: "tdd", description: "x".repeat(1025) },
        { commandId, name: "tdd" },
        { name: "tdd", description: "Test-driven development." },
      ],
    },
    result: { valid: [{ member: ownMember }, { member: commandMember }], invalid: [{}, { member: { ...ownMember, layer: undefined } }] },
  },
  "skills.carryOver": {
    params: {
      valid: [
        { commandId, accountId: "claude-max", dryRun: false },
        { commandId, accountId: "claude-max", dryRun: true },
      ],
      invalid: [{ commandId, accountId: "claude-max" }, { commandId, dryRun: true }, { accountId: "claude-max", dryRun: true }, { commandId, accountId: "", dryRun: false }],
    },
    result: { valid: [report, nothingCarried], invalid: [{ ...report, dryRun: undefined }, { ...report, offered: [{ ...offer, url: "https://github.com/mattpocock/skills?tab=readme" }] }] },
  },
  "skills.own.remove": {
    params: { valid: [{ commandId, name: "tdd" }], invalid: [{ commandId, name: "-tdd" }, { commandId }, { name: "tdd" }] },
    result: { valid: [{ member: ownMember }, { member: invalidMember }], invalid: [{}, { member: { ...ownMember, tokens: -1 } }] },
  },
  "skills.setAlwaysOn": {
    params: {
      valid: [
        { commandId, name: "unslop", accountId: "claude-max", on: true },
        { commandId, name: "unslop", accountId: "claude-max", on: false },
      ],
      invalid: [{ commandId, name: "unslop", accountId: null, on: true }, { commandId, name: "Unslop", accountId: "claude-max", on: true }, { commandId, name: "unslop", accountId: "claude-max" }, { name: "unslop", accountId: "claude-max", on: true }],
    },
    result: { valid: [{ choice: choices[2] }], invalid: [{}, { choice: { ...choices[2], accountId: null } }] },
  },
  "skills.setEnabled": {
    params: {
      valid: [
        { commandId, name: "tdd", accountId: null, enabled: false },
        { commandId, name: "tdd", accountId: "claude-max", enabled: true },
      ],
      invalid: [{ commandId, name: "tdd", enabled: false }, { commandId, name: "-tdd", accountId: null, enabled: false }, { commandId, name: "tdd", accountId: null }, { name: "tdd", accountId: null, enabled: false }],
    },
    result: { valid: [{ choice: choices[0] }, { choice: choices[1] }], invalid: [{}, { choice: { kind: "enabled", name: "tdd", enabled: false } }] },
  },
};

export const skillSchemaFixtures: Record<string, Fixtures> = {
  "repository-identity.json": {
    valid: ["https://github.com/mattpocock/skills", "https://git.systemtech.dev/david/agent-harness", "https://[fd7a:115c:a1e0::1]/david/agent-harness", "https://gitlab.com/group/subgroup/skills"],
    invalid: ["https://github.com/skills", "https://GitHub.com/mattpocock/skills", "http://github.com/mattpocock/skills", "git@github.com:mattpocock/skills.git", "https://github.com/mattpocock/skills/", ""],
  },
  "skills/name.json": {
    valid: ["tdd", "a", "7", "setup-matt-pocock-skills", "a".repeat(64)],
    invalid: ["", "Tdd", "to_spec", "-tdd", "tdd-", "to--spec", "a".repeat(65), 7],
  },
  "skills/source-url.json": {
    valid: ["https://github.com/mattpocock/skills", "ssh://git@git.systemtech.dev:2222/david/agent-skills.git", "git@github.com:mattpocock/skills.git"],
    invalid: ["", "-oProxyCommand=touch", "https://github.com/mattpocock/skills?tab=readme", "https://github.com/mattpocock/skills#readme", "https://github.com/mattpocock/my skills", null],
  },
  "skills/source-folder.json": {
    valid: [".", "skills", "skills/engineering", "skills\\engineering", "./skills/", "..."],
    invalid: ["", "/skills", "\\skills", "C:\\skills", "c:skills", "..", "../skills", "skills/../skills", "skills\\..", "skills\n", 3],
  },
  "skills/rule-issue-params.json": {
    valid: [
      { rule: "skill-name", reason: "doubled_hyphen" },
      { rule: "source-url", reason: "credential" },
      { rule: "source-folder", reason: "parent" },
    ],
    invalid: [{ rule: "skill-name", reason: "credential" }, { rule: "source-url" }, { rule: "readiness", reason: "malformed" }, {}],
  },
  "skills/invocation.json": {
    valid: ["model+slash", "slash-only"],
    invalid: ["model", "slash", ""],
  },
  "skills/member-problem.json": {
    valid: [...invalidMember.problems, { kind: "frontmatter", message: "The member's frontmatter does not read as a YAML mapping." }],
    invalid: [{ kind: "size", message: "m" }, { kind: "name", message: "" }, { kind: "name" }],
  },
  "skills/member-warning.json": {
    valid: [
      { kind: "name-unlike-folder", message: "The name \"test-driven\" is unlike its folder's, \"tdd\"." },
      { kind: "frontmatter-name-invalid", message: "m" },
      { kind: "sidecar-invalid", message: "m" },
    ],
    invalid: [{ kind: "name", message: "m" }, { kind: "sidecar-invalid", message: "" }, { message: "m" }],
  },
  "skills/origin.json": {
    valid: [origin, manifestOrigin, { ...manifestOrigin, commit: null, licence: null }, { ...origin, path: "." }],
    invalid: [
      { ...origin, path: "../tdd" },
      { ...origin, repository: "git@github.com:mattpocock/skills.git" },
      { ...manifestOrigin, commit: "main" },
      { ...manifestOrigin, licence: "" },
      { kind: "copy", repository: origin.repository, path: origin.path },
      { ...manifestOrigin, commit: undefined },
    ],
  },
  "skills/layer.json": {
    valid: [{ kind: "source", sourceId }, { kind: "own" }, { kind: "repository", root: ".claude/skills", directory: "." }, { kind: "repository", root: ".agents/skills", directory: "packages/gui" }],
    invalid: [{ kind: "source", sourceId: "s-1" }, { kind: "repository", root: ".codex/skills", directory: "." }, { kind: "repository", root: ".claude/skills", directory: "/repo" }, { kind: "plugin" }],
  },
  "skills/member-kind.json": { valid: ["skill", "command"], invalid: ["plugin", ""] },
  "skills/while-active-key.json": { valid: ["hooks", "allowed-tools"], invalid: ["allowedTools", "model", ""] },
  "skills/member-ref.json": {
    valid: [{ layer: own, path: "skills/tdd" }, { layer: { kind: "source", sourceId }, path: "." }],
    invalid: [{ layer: own }, { layer: own, path: "../tdd" }, { layer: { kind: "plugin" }, path: "tdd" }],
  },
  "skills/set-member.json": {
    valid: [setMember, shadowed, { ...invalidMember, shadowedBy: null }],
    invalid: [ownMember, { ...setMember, shadowedBy: { layer: own, path: "/tdd" } }],
  },
  "skills/choice.json": {
    valid: choices,
    invalid: [
      { kind: "enabled", name: "tdd", enabled: false },
      { kind: "enabled", name: "Tdd", accountId: null, enabled: false },
      { kind: "always-on", name: "tdd", accountId: null, on: true },
      { kind: "hidden", name: "tdd", accountId: null },
    ],
  },
  "skills/event-type.json": {
    valid: ["skills.enabled-set", "skills.always-on-set", "skills.source-added", "skills.source-synced", "skills.source-removed"],
    invalid: ["skills.updated", "skills.source-follow-set", ""],
  },
  "skills/events/skills.source-added.json": {
    valid: [addedSource, { ...addedSource, folder: ".", follow: { kind: "pinned", commit }, position: 20 }],
    invalid: [{ ...addedSource, position: 0 }, { ...addedSource, url: "-oProxyCommand=touch" }, { ...addedSource, follow: undefined }],
  },
  "skills/events/skills.source-synced.json": {
    valid: [
      { sourceId, outcome: "ok", commit, members: [probeMember, invalidProbeMember] },
      { sourceId, outcome: "ok", commit, members: [] },
    ],
    invalid: [{ sourceId, outcome: "failed", commit, members: [] }, { sourceId, outcome: "ok", commit: "main", members: [] }, { sourceId, outcome: "ok", commit }],
  },
  "skills/events/skills.source-removed.json": { valid: [{ sourceId }], invalid: [{ sourceId: "s-1" }, {}] },
  "skills/events/skills.enabled-set.json": {
    valid: [
      { name: "tdd", accountId: null, enabled: false },
      { name: "tdd", accountId: "claude-max", enabled: true },
    ],
    invalid: [{ name: "tdd", enabled: false }, { name: "Tdd", accountId: null, enabled: false }, { name: "tdd", accountId: null }],
  },
  "skills/events/skills.always-on-set.json": {
    valid: [{ name: "unslop", accountId: "claude-max", on: true }],
    invalid: [{ name: "unslop", accountId: null, on: true }, { name: "unslop", accountId: "", on: true }, { name: "unslop", accountId: "claude-max" }],
  },
  "skills/view-member.json": { valid: viewMembers, invalid: [setMember, { ...viewMember, choices: [{ kind: "hidden", name: "tdd", accountId: null }] }, { ...viewMember, enabled: undefined }] },
  "skills/view-source.json": { valid: [viewSource, { ...viewSource, skillCount: 0 }], invalid: [source, { ...viewSource, commit: "74ca5fe" }, { ...viewSource, skillCount: 1.5 }] },
  "skills/view-account.json": { valid: viewAccounts, invalid: [{ accountId: "local", channel: "none" }, { accountId: "local", channel: "codex", reason: null }, { ...viewAccounts[1], reason: "" }] },
  "skills/view.json": { valid: [view], invalid: [{ ...view, members: undefined }, { ...view, ownDirectory: 7 }, { ...view, accounts: undefined }] },
  "skills/skills-updated.json": { valid: [{}], invalid: [null, "updated"] },
  "skills/native-root.json": { valid: [".claude/skills", ".agents/skills", ".claude/commands"], invalid: [".claude/agents", ".codex/skills", ""] },
  "skills/set-fingerprint.json": { valid: ["3f9a", "c".repeat(64)], invalid: ["", 7, null] },
  "skills/run-skill-set-member.json": {
    valid: [runMember, nativeRunMember, { ...runMember, userInvocable: false }],
    invalid: [
      { ...runMember, name: "Tdd" },
      { ...runMember, native: undefined },
      { ...runMember, alwaysOn: undefined },
      { ...runMember, invocation: "model" },
      { ...runMember, description: "" },
      { ...runMember, userInvocable: undefined },
      { ...runMember, argumentHint: "" },
    ],
  },
  "skills/argument-hint.json": { valid: ["<feature>", "[branch]", null], invalid: ["", 42, ["branch"]] },
  "skills/entry.json": {
    valid: [skillEntry, { ...skillEntry, invocation: "slash-only", origin: null, alwaysOn: false, argumentHint: null }],
    invalid: [{ ...skillEntry, kind: "command" }, { ...skillEntry, description: "" }, { ...skillEntry, argumentHint: undefined }, { ...skillEntry, name: "agent-harness:tdd" }],
  },
  "skills/commands-list-entry.json": {
    valid: [skillEntry, { kind: "command", name: "compact", description: "Compact the conversation.", builtin: true }],
    invalid: [{ ...skillEntry, kind: "member" }, { kind: "command", name: "compact", description: "Compact the conversation." }, { ...skillEntry, kind: "command" }],
  },
  "skills/run-skill-set.json": {
    valid: [runSkillSet, { generation: null, fingerprint: null, members: [], hiddenNativeNames: [] }],
    invalid: [
      { ...runSkillSet, generation: "skills/generations/3f9a" },
      { ...runSkillSet, fingerprint: "" },
      { ...runSkillSet, hiddenNativeNames: ["Triage"] },
      { ...runSkillSet, members: undefined },
    ],
  },
  "skills/member.json": {
    valid: [
      member,
      invalidMember,
      { ...member, invocation: "slash-only", userInvocable: false, origin: manifestOrigin, layer: { kind: "own" }, path: "skills/tdd", size: 0, tokens: 0 },
      { ...member, kind: "command", path: "commands/review.md", whileActive: ["hooks", "allowed-tools"], argumentHint: "[branch]", origin: null, layer: { kind: "own" } },
      { ...member, path: "." },
    ],
    invalid: [
      { ...member, name: "Test Driven" },
      { ...member, argumentHint: "" },
      { ...member, argumentHint: undefined },
      { ...member, kind: "plugin" },
      { ...member, path: "../tdd" },
      { ...member, path: "/skills/tdd" },
      { ...member, whileActive: ["model"] },
      { ...member, tokens: -1 },
      { ...member, tokens: undefined },
      { ...member, description: "" },
      { ...member, invocation: "model" },
      { ...member, size: -1 },
      { ...member, size: 1.5 },
      { ...member, problems: [{ kind: "size", message: "m" }] },
      { ...member, layer: undefined },
    ],
  },
  "skills/carried-item.json": {
    valid: [copiedSkill, copiedCommand],
    invalid: [{ ...copiedSkill, name: "Tdd" }, { ...copiedSkill, from: "skills/tdd" }, { ...copiedSkill, path: "../tdd" }, { ...copiedSkill, kind: "plugin" }],
  },
  "skills/carry-over-offer.json": {
    valid: [offer, pinnedOffer],
    invalid: [
      { ...offer, url: "https://github.com/mattpocock/skills?tab=readme" },
      { ...offer, folder: "../skills" },
      { ...offer, follow: { kind: "pinned", commit: "74ca5fe" } },
      { ...offer, from: "~/.agents/skills/grill-me" },
      { ...offer, name: null },
    ],
  },
  "skills/carry-over-invalid.json": {
    valid: [invalidOriginal, { kind: "command", name: "notes", from: "/home/david/.claude/commands/notes.md", problems: [{ kind: "description", message: "m" }] }],
    invalid: [{ ...invalidOriginal, problems: [] }, { ...invalidOriginal, name: undefined }, { ...invalidOriginal, from: "Notes" }],
  },
  "skills/not-carried.json": {
    valid: [{ kind: "subagent", name: "reviewer" }, { kind: "plugin", name: "skills@mattpocock" }],
    invalid: [{ kind: "hook", name: "x" }, { kind: "plugin", name: "" }, { kind: "subagent" }],
  },
  "skills/carry-over-report.json": {
    valid: [report, nothingCarried],
    invalid: [{ ...report, notCarried: undefined }, { ...report, accountId: "" }, { ...report, kept: [{ ...copiedSkill, path: "/skills/tdd" }] }],
  },
  "skills/probe-id.json": { valid: [probeId], invalid: ["p-1", ""] },
  "skills/probe-member.json": {
    valid: [probeMember, invalidProbeMember],
    invalid: [{ ...probeMember, path: "/tdd" }, { ...probeMember, invocation: "slash" }, { ...probeMember, problems: undefined }],
  },
  "skills/probe-folder.json": {
    valid: [probeFolder, rootFolder, { ...probeFolder, members: [], count: 0, licence: null }],
    invalid: [{ ...probeFolder, licence: "/LICENSE" }, { ...probeFolder, count: 1.5 }, { ...probeFolder, members: undefined }],
  },
  "skills/probe-result.json": { valid: [probe], invalid: [{ ...probe, root: undefined }, { ...probe, folders: null }] },
  "skills/probe-problem.json": { valid: ["authentication", "not_found", "network", "git_failed"], invalid: ["timeout", ""] },
  "skills/probe-unreachable.json": {
    valid: [probeUnreachable, { ...probeUnreachable, problem: "git_failed", line: "fatal: bad object" }],
    invalid: [{ ...probeUnreachable, reason: "pinned" }, { ...probeUnreachable, line: "" }, { ...probeUnreachable, origin: "github.com" }],
  },
  "skills/source-add-conflict.json": {
    valid: [probeUnreachable, { reason: "no_skills", folders: [".", "skills/engineering"] }, { reason: "no_skills", folders: [] }, { reason: "source_limit", limit: 20 }, { reason: "duplicate", sourceId }],
    invalid: [{ reason: "no_skills" }, { reason: "no_skills", folders: ["/skills"] }, { reason: "source_limit", limit: 0 }, { reason: "duplicate", sourceId: "s-1" }, { reason: "pinned" }],
  },
  "skills/source-member.json": {
    valid: [probeMember, invalidProbeMember],
    invalid: [{ ...probeMember, path: "../tdd" }, { ...probeMember, name: "Tdd" }, { ...probeMember, description: undefined }],
  },
  "skills/source-id.json": {
    valid: [sourceId],
    invalid: ["s-1", "0f8fad5b-d9cb-169f-a165-70867728950e", ""],
  },
  "skills/git-commit.json": {
    valid: [commit, "d".repeat(64)],
    invalid: ["74ca5fe", "C".repeat(40), "c".repeat(41), "main", ""],
  },
  "skills/source-branch.json": {
    valid: ["main", "release/2026-09", "feature/x.y", "v1.0"],
    invalid: ["", "-f", "main:refs/heads/x", "main~1", "a..b", "main@{1}", "a b", "/main", "main/", ".hidden", "main.lock", "@", "x".repeat(256)],
  },
  "skills/follow.json": {
    valid: [{ kind: "branch", branch: null }, { kind: "branch", branch: "main" }, { kind: "pinned", commit }],
    invalid: [{ kind: "branch" }, { kind: "branch", branch: "-f" }, { kind: "pinned", commit: "74ca5fe" }, { kind: "pinned", commit: null }, { kind: "tag", tag: "v1" }],
  },
  "skills/source.json": {
    valid: [source, { ...source, folder: ".", follow: { kind: "pinned", commit }, position: 20, addedBy: { kind: "system", id: "state-import" } }],
    invalid: [
      { ...source, url: "-oProxyCommand=touch" },
      { ...source, identity: "git@github.com:mattpocock/skills.git" },
      { ...source, folder: "../skills" },
      { ...source, follow: { kind: "branch", branch: "a b" } },
      { ...source, position: 0 },
      { ...source, addedAt: "yesterday" },
      { ...source, id: undefined },
    ],
  },
};
