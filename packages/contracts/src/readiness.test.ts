import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  READINESS_OVERLAY,
  ReadinessCheck,
  ReadinessDeclaration,
  ReadinessOverlay,
  SkillReadiness,
  overlayDeclaration,
  type ReadinessCheck as ReadinessCheckType,
  type SkillOrigin,
} from "./index.js";

/**
 * Readiness's contract test (skills spec, "Readiness"; ADR 0009): the
 * sidecar's declaration with its seven kinds, the results, and the
 * overlay the harness ships, held to its schema and to the Pocock set's
 * local checks, matched by a source's origin or a provenance manifest's.
 */

/** The messages a schema refuses `value` with, each at its path. */
const refusals = (schema: z.ZodType, value: unknown): string[] => {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
};

const POCOCK = "https://github.com/mattpocock/skills";

/** The overlay's checks for the Pocock skill at `path`. */
const checksAt = (path: string): readonly ReadinessCheckType[] => {
  const declaration = overlayDeclaration(READINESS_OVERLAY, { kind: "repository", repository: POCOCK, path });
  if (declaration === null) throw new Error(`the overlay has no entry for ${path}`);
  return declaration.checks;
};

const ISSUE_TRACKER = { kind: "file", paths: ["docs/agents/issue-tracker.md"], fix: "/setup-matt-pocock-skills" };
const AGENT_SKILLS = { kind: "file", paths: ["CLAUDE.md", "AGENTS.md"], headings: ["Agent skills"], fix: "/setup-matt-pocock-skills" };

describe("the sidecar's declaration", () => {
  it("reads version 1 with checks of all seven kinds, each with its parameters, a why and a fix", () => {
    const checks = [
      { kind: "file", paths: ["docs\\agents\\issue-tracker.md", "./AGENTS.md"], headings: ["Agent skills"], why: "Where issues live.", fix: "/setup-matt-pocock-skills" },
      { kind: "tool", command: "gh", fix: "forges" },
      { kind: "secret", reference: { provider: "doppler", connectionId: "c0ffee00-0000-4000-8000-000000000001", name: "GITHUB_TOKEN" } },
      { kind: "git", condition: "repository" },
      { kind: "git", condition: "merge-in-progress" },
      { kind: "git", condition: "changes-since", ref: "origin/main" },
      { kind: "git", condition: "changes-since" },
      { kind: "git", condition: "forge-account", fix: "forges" },
      { kind: "skill", name: "grilling" },
      { kind: "skill", name: "to-spec", modelInvocable: false },
      { kind: "mcp", server: "linear" },
      { kind: "provider", providers: ["claude"] },
      { kind: "provider", capability: "subagents" },
    ];
    const parsed = ReadinessDeclaration.parse({ version: 1, checks });
    expect(parsed.checks.map((check) => check.kind)).toEqual(["file", "tool", "secret", "git", "git", "git", "git", "git", "skill", "skill", "mcp", "provider", "provider"]);
    // A path is read by the source folder rule: normalised to / between segments.
    expect(parsed.checks[0]).toMatchObject({ paths: ["docs/agents/issue-tracker.md", "AGENTS.md"] });
  });

  it("refuses another version, an unknown key, a path out of the root, a provider check naming neither, a ref on another condition, and a why over two lines", () => {
    const refused = (check: unknown): string[] => refusals(ReadinessDeclaration, { version: 1, checks: [check] });
    expect(refusals(ReadinessDeclaration, { version: 2, checks: [] })).not.toEqual([]);
    expect(refusals(ReadinessDeclaration, { version: 1, checks: [], extra: true })).not.toEqual([]);
    expect(refused({ kind: "file", path: ["CLAUDE.md"] })).not.toEqual([]);
    expect(refused({ kind: "file", paths: ["../CLAUDE.md"] })).not.toEqual([]);
    expect(refused({ kind: "file", paths: ["/etc/passwd"] })).not.toEqual([]);
    expect(refused({ kind: "file", paths: [] })).not.toEqual([]);
    expect(refused({ kind: "provider" })).toEqual(["checks.0: Name the providers, a capability, or both."]);
    expect(refused({ kind: "git", condition: "repository", ref: "main" })).not.toEqual([]);
    expect(refused({ kind: "git", condition: "changes-since", ref: "--output=/tmp/x" })).not.toEqual([]);
    expect(refused({ kind: "tool", command: "/usr/bin/gh" })).not.toEqual([]);
    expect(refused({ kind: "skill", name: "Grilling" })).not.toEqual([]);
    expect(refused({ kind: "tool", command: "gh", why: "One line.\nAnd another." })).not.toEqual([]);
    expect(refused({ kind: "tool", command: "gh", fix: "setup-matt-pocock-skills" })).not.toEqual([]);
    expect(refused({ kind: "lint" })).not.toEqual([]);
  });
});

describe("a skill's readiness", () => {
  const failing = { check: ReadinessCheck.parse(ISSUE_TRACKER), outcome: "failed", message: "docs/agents/issue-tracker.md is not in the repository." };

  it("is ready, with or without a declaration; setup-needed or unsupported with every failing check and the first one's why and fix", () => {
    expect(SkillReadiness.safeParse({ name: "tdd", state: "ready", declaredBy: null }).success).toBe(true);
    expect(SkillReadiness.safeParse({ name: "to-spec", state: "setup-needed", declaredBy: "overlay", failing: [failing], why: null, fix: "/setup-matt-pocock-skills" }).success).toBe(true);
    expect(SkillReadiness.safeParse({ name: "to-spec", state: "unsupported", declaredBy: "sidecar", failing: [failing], why: "Claude only.", fix: null }).success).toBe(true);
    // Not ready without a failing check, nor from no declaration.
    expect(SkillReadiness.safeParse({ name: "to-spec", state: "setup-needed", declaredBy: "overlay", failing: [], why: null, fix: null }).success).toBe(false);
    expect(SkillReadiness.safeParse({ name: "to-spec", state: "setup-needed", declaredBy: null, failing: [failing], why: null, fix: null }).success).toBe(false);
  });
});

describe("the shipped overlay", () => {
  it("holds to its schema, no two entries with one repository and folder", () => {
    expect(refusals(ReadinessOverlay, READINESS_OVERLAY)).toEqual([]);
    const [first] = READINESS_OVERLAY;
    expect(refusals(ReadinessOverlay, [first, first])).toEqual(["1.path: Another entry has this repository and folder."]);
  });

  it("holds the Pocock set's issue-tracker, Agent skills and triage-labels file checks, fixed by /setup-matt-pocock-skills", () => {
    for (const skill of ["to-spec", "to-tickets", "triage", "wayfinder", "code-review"]) {
      const checks = checksAt(`skills/engineering/${skill}`);
      expect(checks[0], skill).toMatchObject(ISSUE_TRACKER);
      expect(checks[1], skill).toMatchObject(AGENT_SKILLS);
    }
    expect(checksAt("skills/engineering/triage")).toContainEqual(expect.objectContaining({ kind: "file", paths: ["docs/agents/triage-labels.md"], fix: "/setup-matt-pocock-skills" }));
    expect(checksAt("skills/misc/setup-pre-commit")).toEqual([expect.objectContaining({ kind: "file", paths: ["package.json"] })]);
  });

  it("holds merge-in-progress for resolving-merge-conflicts, kept though gone upstream, and changes-since from the default branch for code-review", () => {
    expect(checksAt("skills/engineering/resolving-merge-conflicts")).toEqual([expect.objectContaining({ kind: "git", condition: "merge-in-progress" })]);
    expect(READINESS_OVERLAY.find((entry) => entry.path === "skills/engineering/resolving-merge-conflicts")?.removedUpstream).toBe(true);
    expect(READINESS_OVERLAY.filter((entry) => entry.removedUpstream).map((entry) => entry.path)).toEqual(["skills/engineering/resolving-merge-conflicts"]);
    const changes = checksAt("skills/engineering/code-review").find((check) => check.kind === "git");
    expect(changes).toMatchObject({ kind: "git", condition: "changes-since" });
    expect(changes).not.toHaveProperty("ref");
  });

  it("holds a skill check for each callee a skill has the model call, fixed on the Skills step", () => {
    const callees = (path: string): string[] => checksAt(path).flatMap((check) => (check.kind === "skill" ? [check.name] : []));
    expect(callees("skills/engineering/triage")).toEqual(["grilling", "domain-modeling"]);
    expect(callees("skills/engineering/wayfinder")).toEqual(["grilling", "domain-modeling", "research", "prototype"]);
    expect(callees("skills/engineering/grill-with-docs")).toEqual(["grilling", "domain-modeling"]);
    expect(callees("skills/engineering/improve-codebase-architecture")).toEqual(["codebase-design", "grilling", "domain-modeling"]);
    expect(callees("skills/engineering/tdd")).toEqual(["codebase-design"]);
    expect(callees("skills/engineering/implement")).toEqual(["tdd", "code-review"]);
    expect(callees("skills/engineering/implement-spec")).toEqual(["code-review"]);
    const skillChecks = READINESS_OVERLAY.flatMap((entry) => entry.declaration.checks.filter((check) => check.kind === "skill"));
    expect(skillChecks.every((check) => check.fix === "skills" && check.modelInvocable === undefined)).toBe(true);
  });

  it("holds only the local checks: no secret, mcp or forge-account check, which nothing evaluates yet", () => {
    const kinds = new Set(READINESS_OVERLAY.flatMap((entry) => entry.declaration.checks.map((check) => (check.kind === "git" ? `git:${check.condition}` : check.kind))));
    expect([...kinds].sort()).toEqual(["file", "git:changes-since", "git:merge-in-progress", "skill"]);
  });

  it("matches a member by its source's origin or by what its provenance manifest names, and nothing else", () => {
    const manifest: SkillOrigin = { kind: "manifest", repository: POCOCK, path: "skills/engineering/to-spec", commit: "74ca5fe", licence: "MIT" };
    expect(overlayDeclaration(READINESS_OVERLAY, manifest)?.checks[0]).toMatchObject(ISSUE_TRACKER);
    expect(overlayDeclaration(READINESS_OVERLAY, { kind: "repository", repository: POCOCK, path: "skills/engineering/to-spec" })).toEqual(
      overlayDeclaration(READINESS_OVERLAY, manifest),
    );
    expect(overlayDeclaration(READINESS_OVERLAY, { kind: "repository", repository: "https://github.com/someone/skills", path: "skills/engineering/to-spec" })).toBeNull();
    expect(overlayDeclaration(READINESS_OVERLAY, { kind: "repository", repository: POCOCK, path: "skills/productivity/grilling" })).toBeNull();
    expect(overlayDeclaration(READINESS_OVERLAY, null)).toBeNull();
  });
});
