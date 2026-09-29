/**
 * Fixtures for the trust gate's schemas (#500): the key, the decision, the
 * record, the trust stream's payloads, the notice's, the offer, and the
 * four methods' params and results. A valid and an invalid instance of each
 * file the export writes; `fixtures.ts` folds them into the package's table.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const sessionId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const identity = "https://git.systemtech.dev/david/agent-harness";

/** A decision on the harness's own repository, asked in a session from the desktop. */
const trusted = {
  key: identity,
  keyKind: "identity",
  decision: "trusted",
  decidedAt: "2026-09-29T04:40:00.000Z",
  clientSessionId: "cs-1",
  clientLabel: "David's desktop",
  sessionId,
};
/** A remote-less repository declined from the Skills step's list. */
const declined = { ...trusted, key: "/home/david/scratchpad", keyKind: "checkout", decision: "declined", sessionId: null };

const decided = { key: identity, keyKind: "identity", clientSessionId: "cs-1", clientLabel: "David's desktop", sessionId };

const offer = {
  instructionFiles: ["CLAUDE.md", "AGENTS.md", ".claude/rules/testing.md"],
  skillRoots: [
    { root: ".claude/skills", directory: ".", members: 2 },
    { root: ".agents/skills", directory: "packages/app", members: 1 },
  ],
  commands: 3,
  hooks: [
    { event: "PreToolUse", hooks: 2 },
    { event: "SessionStart", hooks: 1 },
  ],
  permissionRules: { allow: 4, ask: 0, deny: 1 },
  subagents: 1,
  mcpServers: [{ name: "github", loaded: false }],
};
const emptyOffer = { instructionFiles: [], skillRoots: [], commands: 0, hooks: [], permissionRules: { allow: 0, ask: 0, deny: 0 }, subagents: 0, mcpServers: [] };

/** Params and result instances for the trust methods. */
export const trustMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "trust.get": {
    params: { valid: [{ sessionId }], invalid: [{}, { sessionId: "s-1" }, { sessionId: null }] },
    result: {
      valid: [
        { key: identity, keyKind: "identity", decision: "undecided", offer },
        { key: "/work/remoteless", keyKind: "checkout", decision: "trusted", offer: emptyOffer },
        { key: null, keyKind: null, decision: "undecided", offer: null },
      ],
      invalid: [
        { key: identity, keyKind: "identity", decision: "unknown", offer },
        { key: "work/relative", keyKind: "directory", decision: "undecided", offer },
        { key: identity, keyKind: "identity", decision: "undecided" },
        { key: identity, keyKind: "identity", decision: "undecided", offer: { ...offer, mcpServers: [{ name: "github", loaded: true }] } },
      ],
    },
  },
  "trust.list": {
    params: { valid: [{}], invalid: [null, []] },
    result: {
      valid: [{ trusted: [trusted], declined: [declined] }, { trusted: [], declined: [] }],
      invalid: [{ trusted: [trusted] }, { trusted: [{ ...trusted, decidedAt: "yesterday" }], declined: [] }],
    },
  },
  "trust.decide": {
    params: {
      valid: [
        { commandId, sessionId, decision: "trusted" },
        { commandId, key: identity, decision: "declined" },
        { commandId, key: "/home/david/scratchpad", decision: "trusted" },
      ],
      invalid: [
        { commandId, decision: "trusted" },
        { commandId, sessionId, key: identity, decision: "trusted" },
        { commandId, sessionId, decision: "undecided" },
        { commandId, key: "git@github.com:david/app.git", decision: "trusted" },
        { sessionId, decision: "trusted" },
      ],
    },
    result: { valid: [{ record: trusted }, { record: declined }], invalid: [{}, { record: { ...trusted, decision: "undecided" } }] },
  },
  "trust.revoke": {
    params: { valid: [{ commandId, key: identity }, { commandId, key: "C:\\work\\app" }], invalid: [{ commandId }, { commandId, key: "" }, { key: identity }] },
    result: { valid: [{ record: trusted }], invalid: [{}, { record: { ...trusted, keyKind: "remote" } }] },
  },
};

export const trustSchemaFixtures: Record<string, Fixtures> = {
  "trust/key-kind.json": { valid: ["identity", "checkout", "directory"], invalid: ["scratch", "worktree", ""] },
  "trust/key.json": {
    valid: [identity, "/home/david/scratchpad", "C:\\work\\app", "\\\\nas\\share\\app"],
    invalid: ["", "work/app", "git@github.com:david/app.git", "https://GitHub.com/david/app", 7],
  },
  "trust/decision.json": { valid: ["trusted", "declined"], invalid: ["undecided", "revoked", ""] },
  "trust/state.json": { valid: ["trusted", "declined", "undecided"], invalid: ["revoked", ""] },
  "trust/record.json": {
    valid: [trusted, declined],
    invalid: [
      { ...trusted, decision: "undecided" },
      { ...trusted, clientSessionId: "" },
      { ...trusted, sessionId: "s-1" },
      { ...trusted, clientLabel: undefined },
      { ...trusted, keyKind: undefined },
    ],
  },
  "trust/events/trust.granted.json": {
    valid: [decided, { ...decided, key: "/work/app", keyKind: "directory", sessionId: null }],
    invalid: [{ ...decided, sessionId: undefined }, { ...decided, keyKind: "scratch" }, { ...decided, key: "" }],
  },
  "trust/events/trust.declined.json": {
    valid: [{ ...decided, key: "/work/app", keyKind: "directory", sessionId: null }],
    invalid: [{ ...decided, clientLabel: undefined }],
  },
  "trust/events/trust.revoked.json": { valid: [{ key: identity, keyKind: "identity" }], invalid: [{ key: identity }, { key: "", keyKind: "identity" }] },
  "trust/event-type.json": { valid: ["trust.granted", "trust.declined", "trust.revoked"], invalid: ["trust.updated", "trust.decided", ""] },
  "trust/trust-updated.json": { valid: [{}], invalid: [null, "updated"] },
  "trust/offer-skill-root.json": {
    valid: [
      { root: ".claude/skills", directory: ".", members: 1 },
      { root: ".agents/skills", directory: "packages/app", members: 3 },
    ],
    invalid: [
      { root: ".codex/skills", directory: ".", members: 1 },
      { root: ".claude/skills", directory: "../x", members: 1 },
      { root: ".claude/skills", directory: ".", members: 0 },
    ],
  },
  "trust/offer-hooks.json": {
    valid: [{ event: "PreToolUse", hooks: 2 }],
    invalid: [{ event: "", hooks: 1 }, { event: "PreToolUse", hooks: 0 }, { event: "PreToolUse" }],
  },
  "trust/offer-mcp-server.json": { valid: [{ name: "github", loaded: false }], invalid: [{ name: "github", loaded: true }, { name: "", loaded: false }, { name: "github" }] },
  "trust/offer.json": {
    valid: [offer, emptyOffer],
    invalid: [{ ...offer, commands: -1 }, { ...offer, permissionRules: { allow: 1 } }, { ...offer, subagents: undefined }, { ...offer, instructionFiles: [""] }],
  },
};
