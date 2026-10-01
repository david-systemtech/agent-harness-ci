import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RoutineDefinition } from "./routines.js";
import { readRoutineYaml, renderRoutineYaml } from "./routine-yaml.js";

/**
 * The routine YAML codec (routines spec, "YAML export and import"; #528):
 * definitions rendered as routine documents, one per routine, and read back
 * with the issues at their paths. The text a definition renders to is
 * written out here as the spec's format, so a change of format shows.
 */

const ZONE = "Asia/Manila";
const EXPORTED = { environmentName: "SYSTEM-SERVER", exportedAt: "2026-10-01T05:00:00.000Z" };

/** A definition as the environment saves one: every field present. */
const watch: RoutineDefinition = {
  name: "Upstream watch",
  schedule: { kind: "weekly", day: "monday", at: "03:00" },
  timezone: ZONE,
  ifMissed: "run-once",
  instructions: "Read the sources and file a digest.",
  workspace: { kind: "directory", path: "~/code/agent-harness", repositoryIdentity: "https://git.systemtech.dev/david/agent-harness" },
  account: { provider: "claude", email: "david@example.com", organisation: null },
  model: "opus[1m]",
  effort: "high",
  mode: "acceptEdits",
  containment: null,
  injection: "inherit",
  skills: [],
  preCheck: { kind: "script", path: "upstream-watch.sh", timeoutSeconds: 60 },
  silenceMarker: "[SILENT]",
  maxDurationMinutes: 60,
  delivery: [
    { kind: "client-notice", on: "both" },
    { kind: "webhook", target: "hermes-home", on: "success" },
  ],
  enabled: false,
};

describe("the routine YAML codec", () => {
  it("renders a definition as one routine document with kebab-case keys and the instructions as a block scalar, under a comment naming the environment and the time, and reads it back unchanged", () => {
    const yaml = renderRoutineYaml([watch], EXPORTED);
    expect(yaml).toBe(
      [
        "# Routines exported from SYSTEM-SERVER at 2026-10-01T05:00:00.000Z.",
        "kind: routine",
        "version: 1",
        "name: Upstream watch",
        "enabled: false",
        "schedule: { kind: weekly, day: monday, at: 03:00 }",
        "timezone: Asia/Manila",
        "if-missed: run-once",
        "workspace:",
        "  kind: directory",
        "  path: ~/code/agent-harness",
        "  repository-identity: https://git.systemtech.dev/david/agent-harness",
        "account: { provider: claude, email: david@example.com, organisation: null }",
        "model: opus[1m]",
        "effort: high",
        "mode: acceptEdits",
        "containment: null",
        "injection: inherit",
        "skills: []",
        "pre-check:",
        "  kind: script",
        "  path: upstream-watch.sh",
        "  timeout-seconds: 60",
        'silent-marker: "[SILENT]"',
        "max-duration-minutes: 60",
        "delivery:",
        "  - { kind: client-notice, on: both }",
        "  - { kind: webhook, target: hermes-home, on: success }",
        "instructions: |-",
        "  Read the sources and file a digest.",
        "",
      ].join("\n"),
    );
    expect(readRoutineYaml(yaml, "UTC")).toEqual([{ index: 0, definition: watch, issues: [] }]);
  });

  it("renders several definitions as one document each, and every kind of schedule, workspace, pre-check and target, and any instructions, survives the round trip unchanged", () => {
    const variants: RoutineDefinition[] = [
      watch,
      {
        ...watch,
        name: "Nightly digest",
        schedule: { kind: "cron", expression: "*/30 9-17 * * mon-fri" },
        timezone: "Europe/London",
        ifMissed: "skip",
        workspace: { kind: "worktree", repository: "/srv/code/harness", newBranch: { name: "digest/nightly", base: "main" }, repositoryIdentity: null },
        account: { provider: "codex", email: "seth@example.com", organisation: "Example Ltd" },
        mode: "bypassPermissions",
        containment: "workspace-no-network",
        injection: "deny",
        skills: ["changelog", "digest-writer"],
        preCheck: { kind: "url", url: "https://example.com/feed.xml" },
        silenceMarker: "nothing new",
        maxDurationMinutes: 1440,
        delivery: [],
        enabled: true,
        instructions: "  Indented first line.\n# not a comment\n---\nkey: value\n\n\n",
      },
      { ...watch, name: "On a branch", schedule: { kind: "days", days: ["monday", "thursday"], at: "23:59" }, workspace: { kind: "worktree", repository: "/srv/code/harness", branch: "main", repositoryIdentity: null } },
      { ...watch, name: "Scratch", schedule: { kind: "manual" }, workspace: { kind: "scratch", repositoryIdentity: null }, preCheck: null, account: null, instructions: "Windows line ends\r\nand a bell \u0007, a tab\tand a trailing space " },
      { ...watch, name: "Hourly", schedule: { kind: "hourly", minute: 7 }, instructions: " " },
      { ...watch, name: "Monthly", schedule: { kind: "monthly", day: 31, at: "00:00" }, instructions: "on: yes\nno: 03:00" },
      { ...watch, name: "Weekdays", schedule: { kind: "weekdays", at: "08:30" } },
      { ...watch, name: "Daily", schedule: { kind: "daily", at: "12:00" }, model: "claude-sonnet-4-5", effort: "max" },
    ];
    const yaml = renderRoutineYaml(variants, EXPORTED);
    expect(yaml.match(/^---$/gm)).toHaveLength(variants.length - 1);
    expect(readRoutineYaml(yaml, ZONE)).toEqual(variants.map((definition, index) => ({ index, definition, issues: [] })));
  });

  it("gives what a document leaves out its preset, a zone left out the importing environment's, and a repository identity left out none", () => {
    const yaml = [
      "kind: routine",
      "version: 1",
      'name: "  Minimal  "',
      "enabled: true",
      "schedule: { kind: manual }",
      "workspace: { kind: scratch }",
      "account: null",
      "model: null",
      "effort: null",
      "mode: null",
      "containment: null",
      "skills: []",
      "pre-check: { kind: script, path: probe.sh }",
      "instructions: Do it.",
    ].join("\n");
    expect(readRoutineYaml(yaml, ZONE)).toEqual([
      {
        index: 0,
        definition: {
          name: "Minimal",
          schedule: { kind: "manual" },
          timezone: ZONE,
          ifMissed: "run-once",
          instructions: "Do it.",
          workspace: { kind: "scratch", repositoryIdentity: null },
          account: null,
          model: null,
          effort: null,
          mode: null,
          containment: null,
          injection: "inherit",
          skills: [],
          preCheck: { kind: "script", path: "probe.sh", timeoutSeconds: 60 },
          silenceMarker: "[SILENT]",
          maxDurationMinutes: 60,
          delivery: [{ kind: "client-notice", on: "both" }],
          enabled: true,
        },
        issues: [],
      },
    ]);
  });

  it("is strict: each unknown key, a camel-case one among them, and each bad or missing value is an issue at its own path, and the document reads as no definition", () => {
    const yaml = [
      "kind: routine",
      "version: 1",
      "id: 3f2b8c1d-5e6a-4b7c-9d8e-0f1a2b3c4d5e",
      "name: Upstream watch",
      "enabled: yes",
      "schedule: { kind: hourly, minute: 60, every: 2 }",
      "timezone: Mars/Olympus_Mons",
      "workspace: { kind: directory, path: /work/harness, repositoryIdentity: https://example.com/a/b }",
      "account: { provider: claude, identity: david@example.com }",
      "model: null",
      "effort: null",
      "mode: askAlways",
      "containment: null",
      "skills: []",
      "pre-check: { kind: script, path: probe.sh, timeoutSeconds: 30 }",
      "max-duration-minutes: 0",
      "delivery: [{ kind: webhook, target: hermes-home, on: success, secret: token-for-tests }]",
    ].join("\n");
    const [document] = readRoutineYaml(yaml, ZONE);
    expect(document?.definition).toBeNull();
    expect(document?.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        ["id"],
        ["enabled"],
        ["schedule", "every"],
        ["timezone"],
        ["workspace", "repositoryIdentity"],
        ["account", "identity"],
        ["account", "email"],
        ["account", "organisation"],
        ["mode"],
        ["pre-check", "timeoutSeconds"],
        ["max-duration-minutes"],
        ["delivery", 0, "secret"],
        ["instructions"],
      ]),
    );
    expect(document?.issues.find((issue) => issue.path.join(".") === "id")).toMatchObject({ code: "unrecognized_keys", keys: ["id"] });
    expect(document?.issues.find((issue) => issue.path.join(".") === "timezone")).toMatchObject({ params: { rule: "schedule", reason: "zone" } });
  });

  it("refuses a schedule the schedule maths refuses at its path, naming the rule and its reason, once its keys are sound", () => {
    const base = renderRoutineYaml([watch], EXPORTED);
    const cron = base.replace("schedule: { kind: weekly, day: monday, at: 03:00 }", 'schedule: { kind: cron, expression: "* * * * *" }');
    expect(readRoutineYaml(cron, ZONE)[0]?.issues).toEqual([expect.objectContaining({ path: ["schedule", "expression"], params: { rule: "schedule", reason: "floor" } })]);
    const wrongKind = base.replace("version: 1", "version: 2").replace("kind: routine", "kind: bot");
    expect(readRoutineYaml(wrongKind, ZONE)[0]?.issues.map((issue) => issue.path)).toEqual([["kind"], ["version"]]);
  });

  it("reads a YAML problem as an issue at the document's root with the rule yaml, its reason and where it is, aliases expanded past the library's bound among them; a document not a mapping is refused whole; an empty document is no document", () => {
    const yaml = [renderRoutineYaml([watch], EXPORTED), "---", "# only a comment", "---", "kind: routine", "kind: bot", "---", "- a list", ""].join("\n");
    const documents = readRoutineYaml(yaml, ZONE);
    expect(documents.map((document) => document.index)).toEqual([0, 1, 2]);
    expect(documents[0]).toEqual({ index: 0, definition: watch, issues: [] });
    expect(documents[1]).toEqual({
      index: 1,
      definition: null,
      issues: [{ code: "custom", path: [], message: "Map keys must be unique at line 36, column 1", params: { rule: "yaml", reason: "duplicate_key", line: 36, column: 1 } }],
    });
    expect(documents[2]).toMatchObject({ index: 2, definition: null, issues: [{ code: "invalid_type", path: [] }] });
    expect(readRoutineYaml("# nothing but a comment\n", ZONE)).toEqual([]);

    const levels = ["a: &a [x, x, x, x, x, x, x, x, x, x]", ...["b", "c", "d", "e", "f"].map((key, at) => `${key}: &${key} [${Array.from({ length: 10 }, () => `*${"abcde"[at]}`).join(", ")}]`)];
    expect(readRoutineYaml(levels.join("\n"), ZONE)).toEqual([{ index: 0, definition: null, issues: [expect.objectContaining({ path: [], params: { rule: "yaml", reason: "aliases" } })] }]);
  });

  it("never renders an id, the environment, the saved ceiling, history, the baseline, lineage or a secret, and names a webhook target by its endpoint", () => {
    const routineId = "3f2b8c1d-5e6a-4b7c-9d8e-0f1a2b3c4d5e";
    const environmentId = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
    const stray = {
      ...watch,
      id: routineId,
      environmentId,
      savedUnderCeiling: "bypassPermissions",
      savedBy: "cs-1",
      movedFrom: { environmentId, routineId, at: "2026-09-29T03:00:00.000Z" },
      baseline: { hash: "a".repeat(64), at: "2026-09-29T03:00:00.000Z" },
      lastOutcome: { kind: "skip", entryId: routineId, reason: "no-change", at: "2026-09-29T03:00:00.000Z" },
      secret: "token-for-tests",
    } as RoutineDefinition;
    const yaml = renderRoutineYaml([stray], { environmentName: "Laptop", exportedAt: EXPORTED.exportedAt });
    expect(yaml).toBe(renderRoutineYaml([watch], { environmentName: "Laptop", exportedAt: EXPORTED.exportedAt }));
    for (const absent of [routineId, environmentId, "bypassPermissions", "cs-1", "2026-09-29", "a".repeat(64), "token-for-tests", "moved", "baseline", "saved"]) expect(yaml).not.toContain(absent);
    expect(yaml).toContain("{ kind: webhook, target: hermes-home, on: success }");
  });

  it("reads the upstream watch's routine document, the fixture #537 puts in the routine document, as a disabled weekly routine in the importing environment's zone", () => {
    const yaml = readFileSync(new URL("../test/upstream-watch.routine.yaml", import.meta.url), "utf8");
    const documents = readRoutineYaml(yaml, ZONE);
    expect(documents).toHaveLength(1);
    expect(documents[0]?.issues).toEqual([]);
    expect(documents[0]?.definition).toMatchObject({
      name: "Upstream watch",
      schedule: { kind: "weekly", day: "monday", at: "03:00" },
      timezone: ZONE,
      workspace: { kind: "directory", path: "/work/SYSTEM-SERVER/agent-harness", repositoryIdentity: "https://git.systemtech.dev/david/agent-harness" },
      account: { provider: "claude", organisation: null },
      model: "opus[1m]",
      effort: "high",
      mode: "acceptEdits",
      preCheck: { kind: "script", path: "upstream-watch-probe.sh", timeoutSeconds: 60 },
      delivery: [{ kind: "client-notice", on: "both" }],
      enabled: false,
    });
    expect(documents[0]?.definition?.instructions).toMatch(/^You are the weekly upstream watch[\s\S]*8\. Reply with a two-line summary\./);
  });
});
