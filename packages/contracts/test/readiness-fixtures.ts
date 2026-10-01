/**
 * Fixtures for readiness's schemas (skills spec, "Readiness"): a valid and
 * an invalid instance of each schema the export writes, and of
 * `skills.readiness`'s params and result. Each invalid one is refused by
 * the export too, so a rule the export cannot state (two overlay entries
 * with one key) is the contract test's, not these. `fixtures.ts` folds
 * them into the package's fixture table.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const sessionId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const workspace = { kind: "directory", path: "/home/david/src/agent-harness" };
const setup = "/setup-matt-pocock-skills";

const issueTracker = { kind: "file", paths: ["docs/agents/issue-tracker.md"], why: "Where this repository tracks issues.", fix: setup };
const agentSkills = { kind: "file", paths: ["CLAUDE.md", "AGENTS.md"], headings: ["Agent skills"], fix: setup };
const checks = [
  issueTracker,
  agentSkills,
  { kind: "tool", command: "gh", fix: "forges" },
  { kind: "secret", reference: { provider: "doppler", connectionId: "c0ffee00-0000-4000-8000-000000000001", name: "GITHUB_TOKEN" } },
  { kind: "git", condition: "repository" },
  { kind: "git", condition: "merge-in-progress", why: "Nothing to resolve." },
  { kind: "git", condition: "changes-since", ref: "origin/main" },
  { kind: "git", condition: "forge-account", fix: "forges" },
  { kind: "skill", name: "grilling", fix: "skills" },
  { kind: "skill", name: "to-spec", modelInvocable: false },
  { kind: "mcp", server: "linear" },
  { kind: "provider", providers: ["claude"] },
  { kind: "provider", capability: "subagents", why: "It delegates to subagents." },
];
const invalidChecks = [
  { kind: "file", paths: [] },
  { kind: "file", paths: ["../CLAUDE.md"] },
  { kind: "file", path: ["CLAUDE.md"] },
  { kind: "file", paths: ["CLAUDE.md"], headings: [""] },
  { kind: "tool", command: "bin/gh" },
  { kind: "git", condition: "repository", ref: "main" },
  { kind: "git", condition: "changes-since", ref: "-p" },
  { kind: "git", condition: "clean" },
  { kind: "skill", name: "Grilling" },
  { kind: "mcp", server: "my server" },
  { kind: "provider" },
  { kind: "provider", providers: [] },
  { kind: "tool", command: "gh", why: "Two\nlines." },
  { kind: "tool", command: "gh", fix: "setup-matt-pocock-skills" },
  { kind: "lint" },
];

const declaration = { version: 1, checks };
const failure = { check: issueTracker, outcome: "failed", message: "docs/agents/issue-tracker.md is not in the repository." };
const timedOut = { check: { kind: "git", condition: "changes-since" }, outcome: "timed-out", message: "It could not be checked in time." };
const notEvaluated = { check: { kind: "mcp", server: "linear" }, outcome: "not-evaluated", message: "mcp checks are not evaluated yet." };
const ready = { name: "tdd", state: "ready", declaredBy: null };
const setupNeeded = { name: "to-spec", state: "setup-needed", declaredBy: "overlay", failing: [failure, timedOut], why: issueTracker.why, fix: setup };
const unsupported = { name: "codex-review", state: "unsupported", declaredBy: "sidecar", failing: [{ ...failure, check: { kind: "provider", providers: ["codex"] } }], why: null, fix: null };
const overlayEntry = { repository: "https://github.com/mattpocock/skills", path: "skills/engineering/to-spec", removedUpstream: false, declaration: { version: 1, checks: [issueTracker, agentSkills] } };

/** Params and result instances for `skills.readiness`. */
export const readinessMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "skills.readiness": {
    params: {
      valid: [{ sessionId }, { sessionId, names: ["to-spec", "tdd"], refresh: true }, { accountId: "claude-max", workspace }, { accountId: "claude-max", workspace, names: [] }],
      invalid: [{}, { sessionId, accountId: "claude-max" }, { accountId: "claude-max" }, { workspace }, { sessionId, names: ["To-Spec"] }, { sessionId, refresh: "yes" }],
    },
    result: {
      valid: [{ skills: [ready, setupNeeded, unsupported] }, { skills: [] }],
      invalid: [{}, { skills: [{ ...setupNeeded, failing: [] }] }, { skills: [{ ...ready, state: "unknown" }] }],
    },
  },
};

export const readinessSchemaFixtures: Record<string, Fixtures> = {
  "skills/readiness/fix.json": { valid: [setup, "/to-spec github", "skills", "forges"], invalid: ["setup-matt-pocock-skills", "/", "/ spaced", "/two\nlines", 7] },
  "skills/readiness/check.json": { valid: checks, invalid: invalidChecks },
  "skills/readiness/declaration.json": {
    valid: [declaration, { version: 1, checks: [] }],
    invalid: [{ version: 2, checks }, { version: 1 }, { checks }, { version: 1, checks, extra: true }, { version: 1, checks: invalidChecks.slice(0, 1) }],
  },
  "skills/readiness/declarer.json": { valid: ["sidecar", "overlay"], invalid: ["frontmatter", null] },
  "skills/readiness/failure-outcome.json": { valid: ["failed", "timed-out", "not-evaluated"], invalid: ["passed", ""] },
  "skills/readiness/failure.json": {
    valid: [failure, timedOut, notEvaluated],
    invalid: [{ ...failure, outcome: "passed" }, { ...failure, message: "" }, { outcome: "failed", message: "Gone." }, { ...failure, check: { kind: "lint" } }],
  },
  "skills/readiness/skill-readiness.json": {
    valid: [ready, { ...ready, declaredBy: "overlay" }, setupNeeded, unsupported],
    invalid: [
      { ...ready, declaredBy: undefined },
      { ...setupNeeded, failing: [] },
      { ...setupNeeded, declaredBy: null },
      { ...setupNeeded, why: undefined },
      { ...unsupported, state: "blocked" },
      { ...ready, name: "To-Spec" },
    ],
  },
  "skills/readiness/overlay-entry.json": {
    valid: [overlayEntry, { ...overlayEntry, path: "skills/engineering/resolving-merge-conflicts", removedUpstream: true }],
    invalid: [
      { ...overlayEntry, repository: "git@github.com:mattpocock/skills.git" },
      { ...overlayEntry, path: "/skills/engineering/to-spec" },
      { ...overlayEntry, removedUpstream: undefined },
      { ...overlayEntry, declaration: { version: 2, checks: [] } },
    ],
  },
  "skills/readiness/overlay.json": { valid: [[overlayEntry], []], invalid: [[{ ...overlayEntry, declaration: undefined }], overlayEntry] },
};
