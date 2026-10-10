import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  EMPTY_RUN_SKILL_SET,
  ENVIRONMENT_NOTICE_TYPES,
  EVENT_TYPES,
  EnvironmentNotice,
  NativeSkillRoot,
  PRODUCT_NAME,
  REPOSITORY_IDENTITY_CASES,
  RepositoryIdentity,
  RunSkillSet,
  SKILL_PLUGIN_NAME,
  SKILLS_STREAM_KIND,
  SkillChoice,
  SkillMember,
  SkillsView,
  SkillOrigin,
  SkillSource,
  SkillSourceBranch,
  SkillSourceFollow,
  SkillsCarryOverReport,
  SkillProbeUnreachable,
  SkillsProbeResult,
  SKILL_PROBE_PROBLEMS,
  SKILL_SOURCE_LIMIT,
  SkillSourceAddConflict,
  SkillSourceFollowConflict,
  SkillSourcePullConflict,
  SkillsViewSource,
  approximateTokens,
  eventTypeEntry,
  isListEvent,
  methods,
  readSkillMember,
  registry,
  type RunSkillSet as RunSkillSetType,
  type SkillMember as SkillMemberType,
  type SkillSource as SkillSourceType,
  type SkillsCarryOverReport as SkillsCarryOverReportType,
  type SkillsProbeResult as SkillsProbeResultType,
  type SkillsView as SkillsViewType,
  type SkillSourceAddConflict as SkillSourceAddConflictType,
  type SkillSourceFollowConflict as SkillSourceFollowConflictType,
  type SkillSourceNoSkills as SkillSourceNoSkillsType,
  type SkillsViewSource as SkillsViewSourceType,
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
      {
        name: "tdd",
        description: "Test-driven development.",
        origin: { kind: "manifest", repository: "https://github.com/mattpocock/skills", path: "skills/engineering/tdd", commit: "c55ee46", licence: "MIT" },
        invocation: "model+slash",
        userInvocable: true,
        argumentHint: "<feature>",
        native: false,
        alwaysOn: true,
      },
      { name: "release", description: "Cut a release.", origin: null, invocation: "slash-only", userInvocable: false, argumentHint: null, native: true, alwaysOn: false },
    ],
    hiddenNativeNames: ["triage"],
  };

  it("hands an adapter the generation, the fingerprint, every member with its name, description, origin, invocation, whether a person may invoke it, its argument hint, whether it is native and whether its account made it always-on, and the native names to hide, through the wire and the published schema", () => {
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
    expect(RunSkillSet.safeParse({ ...set, members: [{ ...set.members[0], alwaysOn: undefined }] }).success).toBe(false);
    expect(RunSkillSet.safeParse({ ...set, members: [{ ...set.members[0], description: "" }] }).success).toBe(false);
    expect(RunSkillSet.safeParse({ ...set, members: [{ ...set.members[0], userInvocable: undefined }] }).success).toBe(false);
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
  const offForLocal = { kind: "enabled", name: "tdd", accountId: "local", enabled: false } as const;
  const alwaysOn = { kind: "always-on", name: "tdd", accountId: "claude-max", on: true } as const;
  const inert = { kind: "enabled", name: "unslop", accountId: null, enabled: false } as const;
  const choices = { native: false, enabled: true, alwaysOn: true, choices: [offForLocal, alwaysOn] };
  const unslop: SkillsViewSourceType = {
    id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    url: "https://github.com/theclaymethod/unslop",
    identity: "https://github.com/theclaymethod/unslop",
    folder: ".",
    follow: { kind: "branch", branch: null },
    position: 1,
    addedBy: { kind: "client_session", id: "cs-1" },
    addedAt: "2026-10-01T06:30:00.000Z",
    commit,
    skillCount: 1,
    sync: { outcome: "ok", since: "2026-10-01T06:30:00.000Z" },
    attemptedAt: "2026-10-01T06:30:00.000Z",
  };
  const view: SkillsViewType = {
    ownDirectory: "/home/david/.local/state/agent-harness/skills/own",
    sources: [unslop],
    choices: [offForLocal, alwaysOn, inert],
    accountId: "claude-max",
    accounts: [
      { accountId: "claude-max", channel: "system-prompt-append", reason: null },
      { accountId: "local", channel: "none", reason: "Its adapter, Codex, has no instruction channel, so no always-on skill reaches its runs." },
    ],
    members: [
      { ...tdd, shadowedBy: null, ...choices },
      { ...tdd, kind: "command", path: "commands/tdd.md", origin: null, whileActive: ["allowed-tools"], shadowedBy: { layer: own, path: "skills/tdd" }, ...choices },
      {
        ...readSkillMember({}, { kind: "folder", name: "Notes" }),
        kind: "skill",
        path: "skills/Notes",
        origin: null,
        layer: own,
        size: 0,
        tokens: 0,
        shadowedBy: null,
        native: false,
        enabled: true,
        alwaysOn: false,
        choices: [],
      },
    ],
  };

  it("are skills.get and skills.readiness at read, skills.probe as an admin query, and skills.own.create, .remove, skills.carryOver, skills.setAlwaysOn, skills.setEnabled and skills.sources.add, .remove, .pull and .setFollow as admin commands", () => {
    const owned = methods.filter((m) => m.name.startsWith("skills."));
    expect(Object.fromEntries(owned.map((m) => [m.name, [m.kind, m.scope]]))).toEqual({
      "skills.get": ["query", "read"],
      "skills.readiness": ["query", "read"],
      "skills.probe": ["query", "admin"],
      "skills.own.create": ["command", "admin"],
      "skills.own.remove": ["command", "admin"],
      "skills.carryOver": ["command", "admin"],
      "skills.setAlwaysOn": ["command", "admin"],
      "skills.setEnabled": ["command", "admin"],
      "skills.sources.add": ["command", "admin"],
      "skills.sources.remove": ["command", "admin"],
      "skills.sources.pull": ["command", "admin"],
      "skills.sources.setFollow": ["command", "admin"],
    });
  });

  it("take a session to skills.get, or none, and answer the own directory, the sources, the choices, the account, every account with its instruction channel, and every member with what shadows it and its choices, through the wire and the published schema", () => {
    const get = registry["skills.get"];
    expect(get.params.safeParse({}).success).toBe(true);
    expect(get.params.safeParse({ sessionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7" }).success).toBe(true);
    expect(get.params.safeParse({ sessionId: "s-1" }).success).toBe(false);
    expect(roundTrip(get.result, view)).toEqual(view);
    const validate = published("methods/skills.get/result.json");
    expect(validate(JSON.parse(JSON.stringify(view))), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...view, members: [{ ...view.members[0], shadowedBy: { layer: own } }] })).toBe(false);
    expect(SkillsView.safeParse({ ...view, accountId: null }).success).toBe(true);
    expect(validate({ ...view, members: [{ ...view.members[0], choices: undefined }] })).toBe(false);
    expect(validate({ ...view, accounts: [{ accountId: "local", channel: "none" }] })).toBe(false);
    expect(validate({ ...view, sources: [{ ...unslop, commit: undefined }] })).toBe(false);
    expect(validate({ ...view, sources: [{ ...unslop, skillCount: -1 }] })).toBe(false);
    expect(SkillsViewSource.parse(unslop)).toEqual(unslop);
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

  it("take a name, an account or null for the whole environment, and on or off to skills.setEnabled, and a name, an account and on or off to skills.setAlwaysOn, and answer the choice through the wire and the published response", () => {
    const setEnabled = registry["skills.setEnabled"].params;
    expect(setEnabled.safeParse({ commandId, name: "tdd", accountId: null, enabled: false }).success).toBe(true);
    expect(setEnabled.safeParse({ commandId, name: "tdd", accountId: "claude-max", enabled: true }).success).toBe(true);
    expect(setEnabled.safeParse({ commandId, name: "tdd", enabled: false }).success).toBe(false);
    expect(setEnabled.safeParse({ commandId, name: "Test_Driven", accountId: null, enabled: false }).error?.issues).toEqual([
      expect.objectContaining({ path: ["name"], params: { rule: "skill-name", reason: "character" } }),
    ]);
    const setAlwaysOn = registry["skills.setAlwaysOn"].params;
    expect(setAlwaysOn.safeParse({ commandId, name: "unslop", accountId: "claude-max", on: true }).success).toBe(true);
    expect(setAlwaysOn.safeParse({ commandId, name: "unslop", accountId: null, on: true }).success).toBe(false);
    expect(setAlwaysOn.safeParse({ commandId, name: "-unslop", accountId: "claude-max", on: true }).error?.issues).toEqual([
      expect.objectContaining({ path: ["name"], params: { rule: "skill-name", reason: "leading_hyphen" } }),
    ]);
    for (const [name, choice] of [
      ["skills.setEnabled", inert],
      ["skills.setAlwaysOn", alwaysOn],
    ] as const) {
      const response = { receipt: { status: "accepted", sequence: 7, changed: true }, result: { choice } } as const;
      expect(roundTrip(registry[name].response, response)).toEqual(response);
      const validate = published(`methods/${name}/response.json`);
      expect(validate(JSON.parse(JSON.stringify(response))), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it("record each choice on the skills stream, skills.enabled-set and skills.always-on-set, neither of which changes the session list, in the table and the published schema", () => {
    expect(SKILLS_STREAM_KIND).toBe("skills");
    expect(Object.keys(EVENT_TYPES.skills)).toEqual(["skills.enabled-set", "skills.always-on-set", "skills.source-added", "skills.source-synced", "skills.source-removed", "skills.source-follow-set"]);
    for (const type of Object.keys(EVENT_TYPES.skills)) expect(isListEvent("skills", type), type).toBe(false);
    const enabled = { name: "tdd", accountId: null, enabled: false };
    const on = { name: "unslop", accountId: "claude-max", on: true };
    expect(eventTypeEntry("skills", "skills.enabled-set")?.payload.parse(enabled)).toEqual(enabled);
    expect(eventTypeEntry("skills", "skills.always-on-set")?.payload.parse(on)).toEqual(on);
    expect(eventTypeEntry("skills", "skills.always-on-set")?.payload.safeParse({ ...on, accountId: null }).success).toBe(false);
    expect(published("skills/events/skills.enabled-set.json")(enabled)).toBe(true);
    expect(published("skills/events/skills.always-on-set.json")(on)).toBe(true);
    expect(published("skills/event-type.json")("skills.always-on-set")).toBe(true);
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

describe("skills.probe", () => {
  const probe: SkillsProbeResultType = {
    probeId: "9b2e6f1c-3a4d-4e5f-8a7b-1c2d3e4f5a6b",
    identity: "https://github.com/mattpocock/skills",
    branch: "main",
    commit,
    root: null,
    folders: [
      {
        folder: "skills/engineering",
        members: [
          { name: "tdd", path: "tdd", description: "Test-driven development.", invocation: "model+slash", problems: [] },
          { name: null, path: "Bad_Name", description: null, invocation: "model+slash", problems: [{ kind: "name", message: "No name passes." }, { kind: "description", message: "It has no description." }] },
        ],
        count: 1,
        licence: "skills/engineering/LICENSE",
      },
    ],
    truncated: false,
  };
  const rootSkill: SkillsProbeResultType = {
    ...probe,
    identity: "https://github.com/theclaymethod/unslop",
    root: { folder: ".", members: [{ name: "unslop", path: ".", description: "Remove AI writing patterns.", invocation: "model+slash", problems: [] }], count: 1, licence: null },
    folders: [],
  };

  it("is an admin query taking a URL by the source URL rule and an optional branch", () => {
    const method = registry["skills.probe"];
    expect([method.kind, method.scope]).toEqual(["query", "admin"]);
    expect(method.params.safeParse({ url: "https://github.com/mattpocock/skills" }).success).toBe(true);
    expect(method.params.safeParse({ url: "git@github.com:mattpocock/skills.git", branch: "release/2" }).success).toBe(true);
    expect(method.params.safeParse({ url: "http://github.com/mattpocock/skills" }).error?.issues).toEqual([
      expect.objectContaining({ path: ["url"], params: { rule: "source-url", reason: "scheme" } }),
    ]);
    expect(method.params.safeParse({ url: "https://token@github.com/mattpocock/skills" }).error?.issues).toEqual([
      expect.objectContaining({ path: ["url"], params: { rule: "source-url", reason: "credential" } }),
    ]);
    expect(method.params.safeParse({ url: "https://github.com/mattpocock/skills", branch: "--upload-pack=x" }).success).toBe(false);
  });

  it("answers the probe id, identity, branch and commit, the root when it is a skill, and each folder with its members, count and licence, through the wire and the published schema", () => {
    const validate = published("methods/skills.probe/result.json");
    for (const result of [probe, rootSkill, { ...probe, folders: [], truncated: true }]) {
      expect(roundTrip(registry["skills.probe"].result, result)).toEqual(result);
      expect(validate(JSON.parse(JSON.stringify(result))), JSON.stringify(validate.errors)).toBe(true);
    }
    expect(SkillsProbeResult.safeParse({ ...probe, folders: [{ ...probe.folders[0], folder: "../skills" }] }).success).toBe(false);
    expect(validate({ ...probe, commit: "main" })).toBe(false);
    expect(validate({ ...probe, identity: "git@github.com:mattpocock/skills.git" })).toBe(false);
  });

  it("names what kept it from the repository: authentication, not_found, network, git_missing or git_failed, with what git said and the origin", () => {
    expect(SKILL_PROBE_PROBLEMS).toEqual(["authentication", "not_found", "network", "git_missing", "git_failed"]);
    const data = { reason: "unreachable", problem: "git_failed", line: "fatal: bad object", origin: "https://github.com" } as const;
    expect(roundTrip(SkillProbeUnreachable, data)).toEqual(data);
    expect(published("skills/probe-unreachable.json")(data)).toBe(true);
    expect(SkillProbeUnreachable.safeParse({ ...data, problem: "timeout" }).success).toBe(false);
  });
});

describe("skill sources", () => {
  const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const sourceId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const source: SkillsViewSourceType = {
    id: sourceId,
    url: "git@github.com:mattpocock/skills.git",
    identity: "https://github.com/mattpocock/skills",
    folder: "skills/engineering",
    follow: { kind: "branch", branch: null },
    position: 3,
    addedBy: { kind: "client_session", id: "cs-1" },
    addedAt: "2026-10-01T06:30:00.000Z",
    commit,
    skillCount: 2,
    sync: { outcome: "ok", since: "2026-10-01T06:30:00.000Z" },
    attemptedAt: null,
  };
  const added = { id: sourceId, url: source.url, identity: source.identity, folder: source.folder, follow: source.follow, position: source.position };
  const synced = {
    sourceId,
    outcome: "ok",
    commit,
    members: [
      { name: "tdd", path: "tdd", description: "Test-driven development.", invocation: "model+slash", problems: [] },
      { name: null, path: "Bad_Name", description: "No name passes.", invocation: "model+slash", problems: [{ kind: "name", message: "No name passes." }] },
    ],
  } as const;

  it("are at most twenty on an environment", () => {
    expect(SKILL_SOURCE_LIMIT).toBe(20);
  });

  it("are added by skills.sources.add with a URL and a folder by their rules, what to follow and an optional probe, answering the source with its commit and skill count", () => {
    const add = registry["skills.sources.add"];
    expect([add.kind, add.scope]).toEqual(["command", "admin"]);
    const params = { commandId, url: "https://github.com/theclaymethod/unslop", folder: ".", follow: { kind: "branch", branch: null } };
    expect(add.params.safeParse(params).success).toBe(true);
    expect(add.params.safeParse({ ...params, probeId: "9b2e6f1c-3a4d-4e5f-8a7b-1c2d3e4f5a6b", follow: { kind: "pinned", commit } }).success).toBe(true);
    expect(add.params.safeParse({ ...params, url: "https://token-for-tests@github.com/theclaymethod/unslop" }).error?.issues).toEqual([
      expect.objectContaining({ path: ["url"], params: { rule: "source-url", reason: "credential" } }),
    ]);
    expect(add.params.safeParse({ ...params, folder: "../skills" }).error?.issues).toEqual([expect.objectContaining({ path: ["folder"], params: { rule: "source-folder", reason: "parent" } })]);
    expect(add.params.safeParse({ ...params, follow: undefined }).success).toBe(false);
    expect(add.params.safeParse({ ...params, probeId: "p-1" }).success).toBe(false);
    const response = { receipt: { status: "accepted", sequence: 7, changed: true }, result: { source } } as const;
    expect(roundTrip(add.response, response)).toEqual(response);
    const validate = published("methods/skills.sources.add/response.json");
    expect(validate(JSON.parse(JSON.stringify(response))), JSON.stringify(validate.errors)).toBe(true);
  });

  it("are removed by skills.sources.remove naming the source, answering it as it was", () => {
    const remove = registry["skills.sources.remove"];
    expect([remove.kind, remove.scope]).toEqual(["command", "admin"]);
    expect(remove.params.safeParse({ commandId, sourceId }).success).toBe(true);
    expect(remove.params.safeParse({ commandId, sourceId: "s-1" }).success).toBe(false);
    const response = { receipt: { status: "accepted", sequence: 9, changed: true }, result: { source } } as const;
    expect(roundTrip(remove.response, response)).toEqual(response);
    expect(published("methods/skills.sources.remove/response.json")(JSON.parse(JSON.stringify(response)))).toBe(true);
  });

  it("are refused, beyond the probe's unreachable, as no_skills with the folders found, source_limit, or duplicate naming the source held", () => {
    const validate = published("skills/source-add-conflict.json");
    const conflicts: SkillSourceAddConflictType[] = [
      { reason: "unreachable", problem: "not_found", line: "fatal: repository not found", origin: "https://github.com" },
      { reason: "no_skills", folders: [".", "skills/engineering"] },
      { reason: "no_skills", folders: [] },
      { reason: "source_limit", limit: 20 },
      { reason: "duplicate", sourceId },
    ];
    for (const data of conflicts) {
      expect(roundTrip(SkillSourceAddConflict, data)).toEqual(data);
      expect(validate(data), JSON.stringify(data)).toBe(true);
    }
    expect(validate({ reason: "no_skills", folders: ["../skills"] })).toBe(false);
    expect(validate({ reason: "duplicate" })).toBe(false);
  });

  it("are recorded on the skills stream as skills.source-added (the record), skills.source-synced (the commit, the members and the outcome) and skills.source-removed, none of which changes the session list, in the table and the published schema", () => {
    const removed = { sourceId };
    for (const [type, payload] of [
      ["skills.source-added", added],
      ["skills.source-synced", synced],
      ["skills.source-removed", removed],
    ] as const) {
      expect(isListEvent("skills", type), type).toBe(false);
      expect(eventTypeEntry("skills", type)?.payload.parse(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
      expect(published(`skills/events/${type}.json`)(JSON.parse(JSON.stringify(payload))), type).toBe(true);
      expect(published("skills/event-type.json")(type)).toBe(true);
    }
    expect(published("skills/events/skills.source-added.json")({ ...added, follow: { kind: "pinned", commit } })).toBe(true);
    expect(published("skills/events/skills.source-added.json")({ ...added, position: 0 })).toBe(false);
    expect(published("skills/events/skills.source-synced.json")({ ...synced, outcome: "failed" })).toBe(false);
    expect(published("skills/events/skills.source-synced.json")({ ...synced, commit: "main" })).toBe(false);
  });

  it("record a sync that failed with the probe's problem and what git said, or whose layout moved with the commit and the folders that would, and what a source follows, in the table and the published schema", () => {
    const failed = { sourceId, outcome: "failed", problem: "network", line: "fatal: unable to access 'https://github.com/mattpocock/skills/': Could not resolve host: github.com" };
    const moved = { sourceId, outcome: "layout_moved", commit, folders: [".", "skills/engineering"] };
    for (const payload of [failed, moved, { ...moved, folders: [] }]) {
      expect(eventTypeEntry("skills", "skills.source-synced")?.payload.parse(payload)).toEqual(payload);
      expect(published("skills/events/skills.source-synced.json")(payload), JSON.stringify(payload)).toBe(true);
    }
    for (const payload of [{ ...failed, problem: "timeout" }, { ...failed, line: "" }, { ...moved, folders: ["../skills"] }, { ...moved, commit: undefined }, { ...synced, outcome: "layout_moved" }]) {
      expect(published("skills/events/skills.source-synced.json")(payload), JSON.stringify(payload)).toBe(false);
    }

    const pinned = { sourceId, follow: { kind: "pinned", commit } };
    const unpinned = { sourceId, follow: { kind: "branch", branch: "release/2" } };
    for (const payload of [pinned, unpinned]) {
      expect(isListEvent("skills", "skills.source-follow-set")).toBe(false);
      expect(eventTypeEntry("skills", "skills.source-follow-set")?.payload.parse(payload)).toEqual(payload);
      expect(published("skills/events/skills.source-follow-set.json")(payload)).toBe(true);
    }
    expect(published("skills/events/skills.source-follow-set.json")({ sourceId })).toBe(false);
    expect(published("skills/event-type.json")("skills.source-follow-set")).toBe(true);
  });

  it("are listed with what their last sync came to and since when, and when a fetch of them last ended or null", () => {
    const validate = published("skills/view-source.json");
    const since = "2026-10-01T12:30:00.000Z";
    const syncs: SkillsViewSourceType["sync"][] = [
      { outcome: "ok", since },
      { outcome: "failed", since, problem: "authentication", line: "fatal: Authentication failed for 'https://github.com/mattpocock/skills/'" },
      { outcome: "layout_moved", since, commit, folders: ["skills"] },
    ];
    for (const sync of syncs) {
      const listed: SkillsViewSourceType = { ...source, sync, attemptedAt: "2026-10-01T18:30:00.000Z" };
      expect(roundTrip(SkillsViewSource, listed)).toEqual(listed);
      expect(validate(JSON.parse(JSON.stringify(listed))), JSON.stringify(sync)).toBe(true);
    }
    expect(validate({ ...source, sync: undefined })).toBe(false);
    expect(validate({ ...source, attemptedAt: undefined })).toBe(false);
    expect(validate({ ...source, sync: { outcome: "failed", since } })).toBe(false);
    expect(validate({ ...source, sync: { outcome: "ok" } })).toBe(false);
  });

  it("are synced now by skills.sources.pull naming the source, answering it as the sync left it, and refused conflict, reason pinned, for a pinned one", () => {
    const pull = registry["skills.sources.pull"];
    expect([pull.kind, pull.scope]).toEqual(["command", "admin"]);
    expect(pull.params.safeParse({ commandId, sourceId }).success).toBe(true);
    expect(pull.params.safeParse({ commandId }).success).toBe(false);
    const response = { receipt: { status: "accepted", sequence: 9, changed: false }, result: { source } } as const;
    expect(roundTrip(pull.response, response)).toEqual(response);
    expect(published("methods/skills.sources.pull/response.json")(JSON.parse(JSON.stringify(response)))).toBe(true);
    const conflict = { reason: "pinned", commit };
    expect(roundTrip(SkillSourcePullConflict, conflict)).toEqual(conflict);
    expect(published("skills/source-pull-conflict.json")(conflict)).toBe(true);
    expect(published("skills/source-pull-conflict.json")({ reason: "pinned" })).toBe(false);
  });

  it("are pinned at a commit or follow a branch again by skills.sources.setFollow, refused unreachable or no_skills for a commit that cannot be fetched or yields nothing", () => {
    const setFollow = registry["skills.sources.setFollow"];
    expect([setFollow.kind, setFollow.scope]).toEqual(["command", "admin"]);
    for (const follow of [{ kind: "pinned", commit }, { kind: "branch", branch: null }, { kind: "branch", branch: "release/2" }]) {
      expect(setFollow.params.safeParse({ commandId, sourceId, follow }).success).toBe(true);
    }
    expect(setFollow.params.safeParse({ commandId, sourceId, follow: { kind: "pinned", commit: "main" } }).success).toBe(false);
    expect(setFollow.params.safeParse({ commandId, sourceId, follow: { kind: "branch", branch: "-x" } }).success).toBe(false);
    const response = { receipt: { status: "accepted", sequence: 9, changed: true }, result: { source: { ...source, follow: { kind: "pinned", commit } } } } as const;
    expect(roundTrip(setFollow.response, response)).toEqual(response);
    expect(published("methods/skills.sources.setFollow/response.json")(JSON.parse(JSON.stringify(response)))).toBe(true);
    const validate = published("skills/source-follow-conflict.json");
    const conflicts: SkillSourceFollowConflictType[] = [
      { reason: "unreachable", problem: "not_found", line: "fatal: remote error: upload-pack: not our ref", origin: "https://github.com" },
      { reason: "no_skills", folders: ["skills"] } satisfies SkillSourceNoSkillsType,
    ];
    for (const data of conflicts) {
      expect(roundTrip(SkillSourceFollowConflict, data)).toEqual(data);
      expect(validate(data)).toBe(true);
    }
    expect(validate({ reason: "duplicate", sourceId })).toBe(false);
  });
});
