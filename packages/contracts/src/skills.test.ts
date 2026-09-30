import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  EMPTY_RUN_SKILL_SET,
  ENVIRONMENT_NOTICE_TYPES,
  EnvironmentNotice,
  NativeSkillRoot,
  PRODUCT_NAME,
  REPOSITORY_IDENTITY_CASES,
  RepositoryIdentity,
  RunSkillSet,
  SKILL_PLUGIN_NAME,
  SkillChoice,
  SkillMember,
  SkillsView,
  SkillOrigin,
  SkillSource,
  SkillSourceBranch,
  SkillSourceFollow,
  SkillsCarryOverReport,
  approximateTokens,
  eventTypeEntry,
  methods,
  readSkillMember,
  registry,
  type RunSkillSet as RunSkillSetType,
  type SkillMember as SkillMemberType,
  type SkillSource as SkillSourceType,
  type SkillsCarryOverReport as SkillsCarryOverReportType,
  type SkillsView as SkillsViewType,
} from "./index.js";

/**
 * The shapes the skills workstream shares (skills spec, "The skill set" and
 * "Skill sources"): a member, its origin and layer, a source record and
 * what it follows, each in the contracts and in the published JSON Schema,
 * with a round trip through both.
 */

/** A published document, compiled as a client in another language would: from the committed file alone. */
const published = (path: string) => {
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
  addFormats.default(ajv);
  return ajv.compile(JSON.parse(readFileSync(join(import.meta.dirname, "..", "schema", path), "utf8")) as object);
};

/** `value` through JSON and the zod schema, as a client reads it off the wire. */
const roundTrip = <T>(schema: { parse: (value: unknown) => T }, value: T): T => schema.parse(JSON.parse(JSON.stringify(value)));

const commit = "c".repeat(40);

describe("a member", () => {
  /** A member of a tracked source, from the Pocock set, as the reader will put it together. */
  const fromSource = (frontmatter: Record<string, unknown>, folder: string): SkillMemberType => ({
    ...readSkillMember(frontmatter, { kind: "folder", name: folder }),
    kind: "skill",
    path: folder,
    origin: { kind: "repository", repository: "https://github.com/mattpocock/skills", path: `skills/engineering/${folder}` },
    layer: { kind: "source", sourceId: "0f8fad5b-d9cb-469f-a165-70867728950e" },
    size: 4210,
    tokens: approximateTokens(4210),
  });

  it("takes what reading a member's frontmatter and folder answers, valid or invalid, and survives the wire and the published schema", () => {
    const valid = fromSource({ name: "tdd", description: "Test-driven development.", "disable-model-invocation": true }, "tdd");
    const invalid = fromSource({ name: "Test Driven" }, "Test_Driven");
    expect(invalid.problems.map((problem) => problem.kind)).toEqual(["name", "description"]);
    const validate = published("skills/member.json");
    for (const member of [valid, invalid]) {
      expect(roundTrip(SkillMember, member)).toEqual(member);
      expect(validate(JSON.parse(JSON.stringify(member))), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it("names its origin by a source's or trusted repository's identity and folder, or by what a provenance manifest names", () => {
    const manifest = { kind: "manifest", repository: "https://github.com/mattpocock/skills", path: "skills/engineering/tdd", commit: "74ca5fe", licence: "MIT" } as const;
    const validate = published("skills/origin.json");
    for (const origin of [manifest, { ...manifest, commit: null, licence: null }, { kind: "repository", repository: "https://github.com/theclaymethod/unslop", path: "." } as const]) {
      expect(roundTrip(SkillOrigin, origin)).toEqual(origin);
      expect(validate(origin), JSON.stringify(origin)).toBe(true);
    }
    expect(SkillOrigin.safeParse({ ...manifest, path: "../tdd" }).success).toBe(false);
  });

  it("is a skill folder or a command file, lying at a path from its layer's folder that never leaves it", () => {
    const member = fromSource({ name: "review", description: "Review a branch." }, "review");
    const command: SkillMemberType = { ...member, kind: "command", path: "commands/review.md", layer: { kind: "own" }, origin: null };
    expect(roundTrip(SkillMember, command)).toEqual(command);
    expect(SkillMember.parse({ ...member, path: "skills\\review\\" }).path).toBe("skills/review");
    for (const path of ["../review", "/srv/skills/review", "C:\\skills"]) expect(SkillMember.safeParse({ ...member, path }).success, path).toBe(false);
  });

  it("carries its body's size and a quarter of it, rounded up, as its approximate tokens, and flags the keys that act while it is active", () => {
    expect([0, 1, 4, 5, 4210].map(approximateTokens)).toEqual([0, 1, 1, 2, 1053]);
    const member = { ...fromSource({ name: "tdd", description: "Test-driven development.", hooks: { Stop: [{ hooks: [] }] }, "allowed-tools": "Read" }, "tdd") };
    expect(member).toMatchObject({ size: 4210, tokens: 1053, whileActive: ["hooks", "allowed-tools"] });
    expect(published("skills/member.json")(JSON.parse(JSON.stringify(member)))).toBe(true);
  });

  it("lies in a source, the own directory or a trusted repository's .claude/skills or .agents/skills", () => {
    const member = fromSource({ name: "tdd", description: "Test-driven development." }, "tdd");
    for (const layer of [{ kind: "own" }, { kind: "repository", root: ".agents/skills", directory: "packages/gui" }, { kind: "repository", root: ".claude/skills", directory: "." }] as const) {
      expect(SkillMember.safeParse({ ...member, layer }).success, JSON.stringify(layer)).toBe(true);
    }
    expect(SkillMember.safeParse({ ...member, layer: { kind: "repository", root: ".codex/skills", directory: "." } }).success).toBe(false);
  });
});

describe("a source record", () => {
  const record: SkillSourceType = {
    id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    url: "git@github.com:mattpocock/skills.git",
    identity: "https://github.com/mattpocock/skills",
    folder: "skills/engineering",
    follow: { kind: "branch", branch: null },
    position: 1,
    addedBy: { kind: "client_session", id: "cs-1" },
    addedAt: "2026-09-29T04:40:00.000Z",
  };

  it("keeps the URL as entered, its identity, its folder, what it follows, its position and who added it when, through the wire and the published schema", () => {
    const validate = published("skills/source.json");
    for (const follow of [{ kind: "branch", branch: null }, { kind: "branch", branch: "release/2026-09" }, { kind: "pinned", commit }] as const) {
      const source = { ...record, follow };
      expect(roundTrip(SkillSource, source)).toEqual(source);
      expect(validate(source), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it("holds a URL and a folder only as their rules take them, the folder normalised", () => {
    expect(SkillSource.safeParse({ ...record, url: "https://token-for-tests@github.com/mattpocock/skills" }).error?.issues).toEqual([
      expect.objectContaining({ path: ["url"], params: { rule: "source-url", reason: "credential" } }),
    ]);
    expect(SkillSource.safeParse({ ...record, folder: "/skills" }).error?.issues).toEqual([
      expect.objectContaining({ path: ["folder"], params: { rule: "source-folder", reason: "absolute" } }),
    ]);
    expect(SkillSource.parse({ ...record, folder: "skills\\engineering\\" }).folder).toBe("skills/engineering");
  });

  it("follows a branch git takes as one, never an option, a refspec or a revision", () => {
    for (const branch of ["main", "release/2026-09", "feature/x.y", "v1.0"]) expect(SkillSourceBranch.safeParse(branch).success, branch).toBe(true);
    const refused = ["", "-f", "--upload-pack=x", "main:refs/heads/x", "main~1", "main^", "a..b", "main@{1}", "a b", "a\tb", "a*", "a?", "a[", "a\\b", "/main", "main/", "a//b", ".hidden", "a/.b", "main.lock", "main.", "@", "x".repeat(256)];
    for (const branch of refused) expect(SkillSourceBranch.safeParse(branch).success, JSON.stringify(branch)).toBe(false);
  });

  it("pins only a full commit name", () => {
    expect(SkillSourceFollow.safeParse({ kind: "pinned", commit: "d".repeat(64) }).success).toBe(true);
    for (const pinned of ["74ca5fe", "C".repeat(40), "d".repeat(41), "main"]) expect(SkillSourceFollow.safeParse({ kind: "pinned", commit: pinned }).success, pinned).toBe(false);
  });
});

describe("a run's skill set", () => {
  const set: RunSkillSetType = {
    generation: "/home/david/.local/state/agent-harness/skills/generations/3f9a",
    fingerprint: "3f9a",
    members: [
      { name: "tdd", origin: { kind: "manifest", repository: "https://github.com/mattpocock/skills", path: "skills/engineering/tdd", commit: "c55ee46", licence: "MIT" }, invocation: "model+slash", native: false },
      { name: "release", origin: null, invocation: "slash-only", native: true },
    ],
    hiddenNativeNames: ["triage"],
  };

  it("hands an adapter the generation, the fingerprint, every member with its name, origin, invocation and whether it is native, and the native names to hide, through the wire and the published schema", () => {
    const validate = published("skills/run-skill-set.json");
    for (const value of [set, EMPTY_RUN_SKILL_SET]) {
      expect(roundTrip(RunSkillSet, value)).toEqual(value);
      expect(validate(JSON.parse(JSON.stringify(value))), JSON.stringify(validate.errors)).toBe(true);
    }
    expect(EMPTY_RUN_SKILL_SET).toEqual({ generation: null, fingerprint: null, members: [], hiddenNativeNames: [] });
    expect(RunSkillSet.safeParse({ ...set, generation: "skills/generations/3f9a" }).success).toBe(false);
    expect(RunSkillSet.safeParse({ ...set, fingerprint: "" }).success).toBe(false);
    expect(RunSkillSet.safeParse({ ...set, hiddenNativeNames: ["Triage"] }).success).toBe(false);
    expect(RunSkillSet.safeParse({ ...set, members: [{ ...set.members[0], native: undefined }] }).success).toBe(false);
  });

  it("names the plugin a generation is after the product, and knows the roots an adapter may load itself: a repository's two skill roots and its commands", () => {
    expect(SKILL_PLUGIN_NAME).toBe(PRODUCT_NAME);
    for (const root of [".claude/skills", ".agents/skills", ".claude/commands"]) expect(NativeSkillRoot.safeParse(root).success, root).toBe(true);
    for (const root of [".claude/agents", ".codex/skills", "skills", ""]) expect(NativeSkillRoot.safeParse(root).success, root).toBe(false);
    expect(published("skills/native-root.json")(".claude/commands")).toBe(true);
  });
});

describe("a repository identity", () => {
  it("is every identity the repository identity rule answers, and nothing a remote spells otherwise", () => {
    for (const entry of REPOSITORY_IDENTITY_CASES) if (entry.identity !== null) expect(RepositoryIdentity.safeParse(entry.identity).success, entry.identity).toBe(true);
    for (const text of ["git@github.com:mattpocock/skills.git", "https://github.com/skills", "https://GitHub.com/mattpocock/skills", "http://github.com/mattpocock/skills", "https://github.com/mattpocock/skills/", "https://github.com/mattpocock/skills?x"]) {
      expect(RepositoryIdentity.safeParse(text).success, text).toBe(false);
    }
  });
});

describe("the skills methods and notice", () => {
  const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const own = { kind: "own" } as const;
  const tdd: SkillMemberType = {
    ...readSkillMember({ name: "tdd", description: "Test-driven development." }, { kind: "folder", name: "tdd" }),
    kind: "skill",
    path: "skills/tdd",
    origin: { kind: "manifest", repository: "https://github.com/mattpocock/skills", path: "skills/engineering/tdd", commit: "c55ee46", licence: "MIT" },
    layer: own,
    size: 4210,
    tokens: 1053,
  };
  const view: SkillsViewType = {
    ownDirectory: "/home/david/.local/state/agent-harness/skills/own",
    sources: [],
    choices: [],
    accountId: "claude-max",
    members: [
      { ...tdd, shadowedBy: null },
      { ...tdd, kind: "command", path: "commands/tdd.md", origin: null, whileActive: ["allowed-tools"], shadowedBy: { layer: own, path: "skills/tdd" } },
      { ...readSkillMember({}, { kind: "folder", name: "Notes" }), kind: "skill", path: "skills/Notes", origin: null, layer: own, size: 0, tokens: 0, shadowedBy: null },
    ],
  };

  it("are skills.get at read, and skills.own.create, .remove and skills.carryOver as admin commands", () => {
    const owned = methods.filter((m) => m.name.startsWith("skills."));
    expect(Object.fromEntries(owned.map((m) => [m.name, [m.kind, m.scope]]))).toEqual({
      "skills.get": ["query", "read"],
      "skills.own.create": ["command", "admin"],
      "skills.own.remove": ["command", "admin"],
      "skills.carryOver": ["command", "admin"],
    });
  });

  it("take a session to skills.get, or none, and answer the own directory, the sources, the choices, the account and every member with what shadows it, through the wire and the published schema", () => {
    const get = registry["skills.get"];
    expect(get.params.safeParse({}).success).toBe(true);
    expect(get.params.safeParse({ sessionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7" }).success).toBe(true);
    expect(get.params.safeParse({ sessionId: "s-1" }).success).toBe(false);
    expect(roundTrip(get.result, view)).toEqual(view);
    const validate = published("methods/skills.get/result.json");
    expect(validate(JSON.parse(JSON.stringify(view))), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...view, members: [{ ...view.members[0], shadowedBy: { layer: own } }] })).toBe(false);
    expect(SkillsView.safeParse({ ...view, accountId: null }).success).toBe(true);
  });

  it("list a choice by name: enabled for an account or the whole environment, or always-on for an account", () => {
    const validate = published("skills/choice.json");
    for (const choice of [
      { kind: "enabled", name: "tdd", accountId: null, enabled: false },
      { kind: "enabled", name: "tdd", accountId: "claude-max", enabled: true },
      { kind: "always-on", name: "unslop", accountId: "claude-max", on: true },
    ] as const) {
      expect(roundTrip(SkillChoice, choice)).toEqual(choice);
      expect(validate(choice), JSON.stringify(choice)).toBe(true);
    }
    expect(SkillChoice.safeParse({ kind: "always-on", name: "unslop", accountId: null, on: true }).success).toBe(false);
    expect(SkillChoice.safeParse({ kind: "enabled", name: "Unslop", accountId: null, enabled: true }).success).toBe(false);
  });

  it("refuse a name failing the skill-name rule, and a description that is empty, all white space or over 1,024 characters, as the params' issues", () => {
    const create = registry["skills.own.create"].params;
    expect(create.safeParse({ commandId, name: "tdd", description: "Test-driven development." }).success).toBe(true);
    expect(create.safeParse({ commandId, name: "Test_Driven", description: "Test-driven development." }).error?.issues).toEqual([
      expect.objectContaining({ path: ["name"], params: { rule: "skill-name", reason: "character" } }),
    ]);
    for (const description of ["", "  \n", "x".repeat(1025)]) expect(create.safeParse({ commandId, name: "tdd", description }).success, JSON.stringify(description)).toBe(false);
    expect(create.safeParse({ commandId, name: "tdd", description: "x".repeat(1024) }).success).toBe(true);
    const remove = registry["skills.own.remove"].params;
    expect(remove.safeParse({ commandId, name: "tdd" }).success).toBe(true);
    expect(remove.safeParse({ commandId, name: "-tdd" }).error?.issues).toEqual([expect.objectContaining({ path: ["name"], params: { rule: "skill-name", reason: "leading_hyphen" } })]);
  });

  it("answer each command's member through the wire and the published response", () => {
    for (const name of ["skills.own.create", "skills.own.remove"] as const) {
      const response = { receipt: { status: "accepted", sequence: 7, changed: true }, result: { member: tdd } } as const;
      expect(roundTrip(registry[name].response, response)).toEqual(response);
      const validate = published(`methods/${name}/response.json`);
      expect(validate(JSON.parse(JSON.stringify(response))), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it("take an account and a dry-run flag to skills.carryOver, and answer what it copied, kept, offered and found invalid, and the subagents and plugins not carried, through the wire and the published response", () => {
    const carryOver = registry["skills.carryOver"];
    expect(carryOver.params.safeParse({ commandId, accountId: "claude-max", dryRun: true }).success).toBe(true);
    expect(carryOver.params.safeParse({ commandId, accountId: "claude-max" }).success).toBe(false);
    const report: SkillsCarryOverReportType = {
      accountId: "claude-max",
      dryRun: false,
      copied: [{ kind: "command", name: "review", from: "/home/david/.claude/commands/review.md", path: "commands/review.md" }],
      kept: [{ kind: "skill", name: "tdd", from: "/home/david/.agents/skills/tdd", path: "skills/tdd" }],
      offered: [
        { name: "grill-me", from: "/home/david/.claude/skills/grill-me", url: "https://github.com/mattpocock/skills", folder: "skills/productivity/grill-me", follow: { kind: "branch", branch: "main" } },
        { name: "handoff", from: "/home/david/.claude/skills/handoff", url: "git@github.com:mattpocock/skills.git", folder: ".", follow: { kind: "pinned", commit } },
      ],
      invalid: [{ kind: "skill", name: "notes", from: "/home/david/.claude/skills/notes", problems: [{ kind: "description", message: "The member has no description in its frontmatter." }] }],
      notCarried: [
        { kind: "subagent", name: "reviewer" },
        { kind: "plugin", name: "skills@mattpocock" },
      ],
    };
    const response = { receipt: { status: "accepted", sequence: 9, changed: true }, result: report } as const;
    expect(roundTrip(carryOver.response, response)).toEqual(response);
    const validate = published("methods/skills.carryOver/response.json");
    expect(validate(JSON.parse(JSON.stringify(response))), JSON.stringify(validate.errors)).toBe(true);
    // An offer's URL is one skills.sources.add takes: never with a credential.
    const leaky = { ...report, offered: [{ ...report.offered[0], url: "https://token-for-tests@github.com/mattpocock/skills" }] };
    expect(SkillsCarryOverReport.safeParse(leaky).success).toBe(false);
    expect(SkillsCarryOverReport.safeParse({ ...report, invalid: [{ ...report.invalid[0], problems: [] }] }).success).toBe(false);
  });

  it("raise skills.updated on the environment stream, with nothing more, in the notice union and the published schema", () => {
    expect(ENVIRONMENT_NOTICE_TYPES).toContain("skills.updated");
    expect(EnvironmentNotice.parse({ type: "skills.updated", payload: {} })).toEqual({ type: "skills.updated", payload: {} });
    expect(eventTypeEntry("environment", "skills.updated")).toMatchObject({ list: false });
    expect(published("notices/environment-notice.json")({ type: "skills.updated", payload: {} })).toBe(true);
    expect(published("skills/skills-updated.json")({})).toBe(true);
  });
});
