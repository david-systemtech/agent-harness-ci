import type { ReadinessCheck, ReadinessOverlay } from "./readiness.js";

/**
 * The readiness overlay the harness ships (skills spec, "Readiness", the
 * shipped overlay; ADR 0009): the Pocock set's local checks, keyed by
 * `mattpocock/skills` and each skill's folder there, so a source tracking
 * it and a copy whose provenance manifest names it both match. A sidecar
 * beside a skill's `SKILL.md` wins over its entry whole.
 *
 * The folders are those of mattpocock/skills at d81f3a1 (2026-09-29), but
 * `resolving-merge-conflicts`, gone from the repository there and kept for
 * the copies vendored before, which still name it. Each skill's callees are
 * the skills its `SKILL.md` has the model call (the Skill tool, or a `/name`
 * it runs); a skill it only mentions is not one. The secret, mcp and
 * forge-account checks wait for the tickets that evaluate them.
 */

const POCOCK = "https://github.com/mattpocock/skills";

const SETUP = "/setup-matt-pocock-skills";

const ISSUE_TRACKER: ReadinessCheck = {
  kind: "file",
  paths: ["docs/agents/issue-tracker.md"],
  why: "The skill reads where and how this repository tracks issues from docs/agents/issue-tracker.md.",
  fix: SETUP,
};

const AGENT_SKILLS: ReadinessCheck = {
  kind: "file",
  paths: ["CLAUDE.md", "AGENTS.md"],
  headings: ["Agent skills"],
  why: "The skill expects the Agent skills section of CLAUDE.md or AGENTS.md to point it at the repository's setup.",
  fix: SETUP,
};

const TRIAGE_LABELS: ReadinessCheck = {
  kind: "file",
  paths: ["docs/agents/triage-labels.md"],
  why: "Triage moves issues through the labels docs/agents/triage-labels.md names.",
  fix: SETUP,
};

/** The tracker-driven skills' first checks. */
const TRACKER = [ISSUE_TRACKER, AGENT_SKILLS];

/** A skill `skill` has the model call: on the Skills step, its folder is tracked. */
const callee = (skill: string, name: string): ReadinessCheck => ({ kind: "skill", name, why: `${skill} calls the ${name} skill.`, fix: "skills" });

/** An entry for the Pocock skill at `path`. */
const pocock = (path: string, checks: readonly ReadinessCheck[], removedUpstream = false): ReadinessOverlay[number] => ({
  repository: POCOCK,
  path,
  removedUpstream,
  declaration: { version: 1, checks: [...checks] },
});

export const READINESS_OVERLAY: ReadinessOverlay = [
  pocock("skills/engineering/code-review", [
    ...TRACKER,
    { kind: "git", condition: "changes-since", why: "Code review reads the changes since the merge base with the default branch, and there are none." },
  ]),
  pocock("skills/engineering/grill-with-docs", [callee("grill-with-docs", "grilling"), callee("grill-with-docs", "domain-modeling")]),
  pocock("skills/engineering/implement", [callee("implement", "tdd"), callee("implement", "code-review")]),
  pocock("skills/engineering/implement-spec", [callee("implement-spec", "code-review")]),
  pocock("skills/engineering/improve-codebase-architecture", [
    callee("improve-codebase-architecture", "codebase-design"),
    callee("improve-codebase-architecture", "grilling"),
    callee("improve-codebase-architecture", "domain-modeling"),
  ]),
  pocock(
    "skills/engineering/resolving-merge-conflicts",
    [{ kind: "git", condition: "merge-in-progress", why: "There is no merge or rebase in progress to resolve in this workspace." }],
    true,
  ),
  pocock("skills/engineering/tdd", [callee("tdd", "codebase-design")]),
  pocock("skills/engineering/to-spec", TRACKER),
  pocock("skills/engineering/to-tickets", TRACKER),
  pocock("skills/engineering/triage", [...TRACKER, TRIAGE_LABELS, callee("triage", "grilling"), callee("triage", "domain-modeling")]),
  pocock("skills/engineering/wayfinder", [
    ...TRACKER,
    callee("wayfinder", "grilling"),
    callee("wayfinder", "domain-modeling"),
    callee("wayfinder", "research"),
    callee("wayfinder", "prototype"),
  ]),
  pocock("skills/misc/setup-pre-commit", [
    { kind: "file", paths: ["package.json"], why: "It sets up Husky and lint-staged in a project with a package.json." },
  ]),
];
