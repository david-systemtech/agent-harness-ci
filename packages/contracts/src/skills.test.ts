import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  REPOSITORY_IDENTITY_CASES,
  RepositoryIdentity,
  SkillMember,
  SkillOrigin,
  SkillSource,
  SkillSourceBranch,
  SkillSourceFollow,
  readSkillMember,
  type SkillMember as SkillMemberType,
  type SkillSource as SkillSourceType,
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
    origin: { kind: "repository", repository: "https://github.com/mattpocock/skills", path: `skills/engineering/${folder}` },
    layer: { kind: "source", sourceId: "0f8fad5b-d9cb-469f-a165-70867728950e" },
    size: 4210,
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

describe("a repository identity", () => {
  it("is every identity the repository identity rule answers, and nothing a remote spells otherwise", () => {
    for (const entry of REPOSITORY_IDENTITY_CASES) if (entry.identity !== null) expect(RepositoryIdentity.safeParse(entry.identity).success, entry.identity).toBe(true);
    for (const text of ["git@github.com:mattpocock/skills.git", "https://github.com/skills", "https://GitHub.com/mattpocock/skills", "http://github.com/mattpocock/skills", "https://github.com/mattpocock/skills/", "https://github.com/mattpocock/skills?x"]) {
      expect(RepositoryIdentity.safeParse(text).success, text).toBe(false);
    }
  });
});
