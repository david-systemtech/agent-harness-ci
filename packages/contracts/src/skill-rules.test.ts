import { describe, expect, it } from "vitest";
import {
  SKILL_MEMBER_CASES,
  SKILL_NAME_CASES,
  SOURCE_FOLDER_CASES,
  SOURCE_URL_CASES,
  checkSkillName,
  checkSourceFolder,
  checkSourceUrl,
  readSkillMember,
  repositoryIdentityOf,
  type SkillMemberCase,
  type SkillNameCase,
  type SourceFolderCase,
  type SourceUrlCase,
} from "./index.js";

/**
 * The rules that decide what a skill is called and what a skill source may
 * point at (skills spec, "The skill set" and "Skill sources"; ADR 0029), as
 * tables of cases. The cases each acceptance criterion names are asserted
 * here and must be in the table the contracts publish, which is checked
 * case by case too.
 */

/** Each case of `table` is in `published`, with the same answer. */
const expectPublished = <C extends { readonly note: string }>(table: readonly C[], published: readonly C[], key: (entry: C) => unknown): void => {
  for (const entry of table) expect(published.find((candidate) => key(candidate) === key(entry)), entry.note).toEqual(entry);
};

describe("the skill-name rule", () => {
  const cases: Record<string, SkillNameCase[]> = {
    "takes 1 to 64 of a-z, 0-9 and -, and no more or fewer": [
      { note: "one letter", name: "a", reason: null },
      { note: "one digit", name: "7", reason: null },
      { note: "sixty-four", name: "a".repeat(64), reason: null },
      { note: "sixty-five", name: "a".repeat(65), reason: "length" },
      { note: "empty", name: "", reason: "length" },
      { note: "words, digits and single hyphens", name: "setup-matt-pocock-skills2", reason: null },
    ],
    "refuses every character outside a-z, 0-9 and -": [
      { note: "an upper-case letter", name: "Tdd", reason: "character" },
      { note: "an underscore", name: "to_spec", reason: "character" },
      { note: "a space", name: "to spec", reason: "character" },
      { note: "a dot", name: "to.spec", reason: "character" },
      { note: "a slash", name: "skills/tdd", reason: "character" },
      { note: "a backslash", name: "skills\\tdd", reason: "character" },
      { note: "a colon", name: "agent-harness:tdd", reason: "character" },
      { note: "a plus", name: "c++", reason: "character" },
      { note: "an at sign", name: "tdd@2", reason: "character" },
      { note: "a letter outside ASCII", name: "café", reason: "character" },
      { note: "a tab", name: "tdd\t", reason: "character" },
      { note: "a character checked before the length", name: `${"a".repeat(64)}_`, reason: "character" },
    ],
    "refuses a leading, a trailing and a doubled hyphen": [
      { note: "a leading hyphen", name: "-tdd", reason: "leading_hyphen" },
      { note: "a trailing hyphen", name: "tdd-", reason: "trailing_hyphen" },
      { note: "a doubled hyphen", name: "to--spec", reason: "doubled_hyphen" },
      { note: "a hyphen alone", name: "-", reason: "leading_hyphen" },
    ],
  };

  describe.each(Object.entries(cases))("%s", (_, table) => {
    it.each(table.map((entry) => [entry.note, entry] as const))("%s", (_note, entry) => {
      const check = checkSkillName(entry.name);
      expect(check.ok ? null : check.refusal.reason).toBe(entry.reason);
      if (check.ok) expect(check.value).toBe(entry.name);
      else expect(check.refusal).toMatchObject({ rule: "skill-name", message: expect.stringMatching(/\S/) });
    });

    it("is in the published table", () => expectPublished(table, SKILL_NAME_CASES, (entry) => entry.name));
  });

  it.each(SKILL_NAME_CASES.map((entry) => [entry.note, entry] as const))("holds for the published case: %s", (_note, entry) => {
    const check = checkSkillName(entry.name);
    expect(check.ok ? null : check.refusal.reason).toBe(entry.reason);
  });
});

/** What a case records of a reading: its fields, with each problem and warning by its kind. */
const answerOf = (entry: Pick<SkillMemberCase, "frontmatter" | "folder">): Omit<SkillMemberCase, "note" | "frontmatter" | "folder"> => {
  const reading = readSkillMember(entry.frontmatter, entry.folder);
  return { ...reading, problems: reading.problems.map((problem) => problem.kind), warnings: reading.warnings.map((warning) => warning.kind) };
};

describe("reading a member's name, description and invocation", () => {
  /** A member folder's case, with everything but what it tests at the answer an ordinary member gets. */
  const member = (note: string, frontmatter: Record<string, unknown>, folder: SkillMemberCase["folder"], answer: Partial<SkillMemberCase>): SkillMemberCase => ({
    note,
    frontmatter,
    folder,
    name: null,
    description: "Test-driven development.",
    invocation: "model+slash",
    userInvocable: true,
    problems: [],
    warnings: [],
    ...answer,
  });
  const described = { description: "Test-driven development." };
  const tdd = { kind: "folder", name: "tdd" } as const;

  const cases: Record<string, SkillMemberCase[]> = {
    "names a member by its frontmatter name when that passes, else its folder's name, else leaves it invalid": [
      member("the frontmatter name, like its folder", { name: "tdd", ...described }, tdd, { name: "tdd" }),
      member("no frontmatter name: the folder's", described, tdd, { name: "tdd" }),
      member("a frontmatter name of null: the folder's", { name: null, ...described }, tdd, { name: "tdd" }),
      member("a frontmatter name that fails: the folder's, with a warning", { name: "Test Driven", ...described }, tdd, { name: "tdd", warnings: ["frontmatter-name-invalid"] }),
      member("a frontmatter name that is not text: the folder's, with a warning", { name: 42, ...described }, tdd, { name: "tdd", warnings: ["frontmatter-name-invalid"] }),
      member("both failing: invalid", { name: "Test Driven", ...described }, { kind: "folder", name: "Test_Driven" }, { problems: ["name"] }),
      member("no frontmatter name and a folder that fails: invalid", described, { kind: "folder", name: "TDD" }, { problems: ["name"] }),
    ],
    "warns, and does not refuse, when a name is unlike its folder": [
      member("a frontmatter name unlike its folder", { name: "test-driven", ...described }, tdd, { name: "test-driven", warnings: ["name-unlike-folder"] }),
    ],
    "names a root skill by the source folder's last segment, else the repository's last path segment": [
      member("the repository's, for a source at the root", described, { kind: "root", sourceFolderSegment: null, repositorySegment: "unslop" }, { name: "unslop" }),
      member("the source folder's before the repository's", described, { kind: "root", sourceFolderSegment: "unslop", repositorySegment: "writing-skills" }, { name: "unslop" }),
      member(
        "the repository's when the source folder's fails, with a warning",
        described,
        { kind: "root", sourceFolderSegment: "Unslop_v2", repositorySegment: "unslop" },
        { name: "unslop", warnings: ["name-unlike-folder"] },
      ),
      member("the frontmatter name first", { name: "unslop", ...described }, { kind: "root", sourceFolderSegment: null, repositorySegment: "unslop-skill" }, {
        name: "unslop",
        warnings: ["name-unlike-folder"],
      }),
      member("both segments failing: invalid", described, { kind: "root", sourceFolderSegment: "Unslop_v2", repositorySegment: "Unslop.Skill" }, { problems: ["name"] }),
      member("no segment at all, and a frontmatter name", { name: "unslop", ...described }, { kind: "root", sourceFolderSegment: null, repositorySegment: null }, { name: "unslop" }),
      member("no segment at all, and no frontmatter name: invalid", described, { kind: "root", sourceFolderSegment: null, repositorySegment: null }, { problems: ["name"] }),
    ],
    "leaves a member without a description invalid, the problem named": [
      member("no description", { name: "tdd" }, tdd, { name: "tdd", description: null, problems: ["description"] }),
      member("a blank description", { name: "tdd", description: "  \n" }, tdd, { name: "tdd", description: null, problems: ["description"] }),
      member("a description that is not text", { name: "tdd", description: ["one", "two"] }, tdd, { name: "tdd", description: null, problems: ["description"] }),
      member("neither a name nor a description", {}, { kind: "folder", name: "TDD" }, { description: null, problems: ["name", "description"] }),
      member("a description trimmed", { name: "tdd", description: "  Test-driven development.\n" }, tdd, { name: "tdd" }),
    ],
    "is slash-only exactly when disable-model-invocation is true, and carries user-invocable: false as its own flag": [
      member("disable-model-invocation: true", { ...described, "disable-model-invocation": true }, tdd, { name: "tdd", invocation: "slash-only" }),
      member("disable-model-invocation: false", { ...described, "disable-model-invocation": false }, tdd, { name: "tdd" }),
      member("disable-model-invocation as the text true", { ...described, "disable-model-invocation": "true" }, tdd, { name: "tdd" }),
      member("user-invocable: false", { ...described, "user-invocable": false }, tdd, { name: "tdd", userInvocable: false }),
      member("user-invocable as the text false", { ...described, "user-invocable": "false" }, tdd, { name: "tdd" }),
      member("both", { ...described, "disable-model-invocation": true, "user-invocable": false }, tdd, { name: "tdd", invocation: "slash-only", userInvocable: false }),
    ],
  };

  describe.each(Object.entries(cases))("%s", (_, table) => {
    it.each(table.map((entry) => [entry.note, entry] as const))("%s", (_note, entry) => {
      const { note: _n, frontmatter: _f, folder: _d, ...answer } = entry;
      expect(answerOf(entry)).toEqual(answer);
    });

    it("is in the published table", () => expectPublished(table, SKILL_MEMBER_CASES, (entry) => entry.note));
  });

  it("says why in each problem and warning", () => {
    const reading = readSkillMember({ name: "Test Driven" }, { kind: "folder", name: "Test_Driven" });
    expect(reading.problems.map((problem) => problem.message)).toEqual([
      expect.stringContaining("Test_Driven"),
      expect.stringMatching(/description/),
    ]);
    const warned = readSkillMember({ name: "test-driven", ...described }, tdd);
    expect(warned.warnings[0]?.message).toMatch(/test-driven.*tdd/);
  });

  it.each(SKILL_MEMBER_CASES.map((entry) => [entry.note, entry] as const))("holds for the published case: %s", (_note, entry) => {
    const { note: _n, frontmatter: _f, folder: _d, ...answer } = entry;
    expect(answerOf(entry)).toEqual(answer);
  });
});

describe("the source URL rule", () => {
  const cases: Record<string, SourceUrlCase[]> = {
    "takes the https, ssh:// and scp forms": [
      { note: "https", url: "https://github.com/mattpocock/skills", reason: null },
      { note: "https with .git", url: "https://github.com/mattpocock/skills.git", reason: null },
      { note: "https with a port", url: "https://git.systemtech.dev:5526/david/agent-skills.git", reason: null },
      { note: "https in capitals", url: "HTTPS://GitHub.com/MattPocock/Skills", reason: null },
      { note: "https to a subgroup", url: "https://gitlab.com/group/subgroup/skills", reason: null },
      { note: "ssh:// with a user", url: "ssh://git@github.com/mattpocock/skills.git", reason: null },
      { note: "ssh:// with a port", url: "ssh://git@git.systemtech.dev:2222/david/agent-skills.git", reason: null },
      { note: "ssh:// without a user", url: "ssh://github.com/mattpocock/skills", reason: null },
      { note: "ssh:// to an IPv6 literal", url: "ssh://git@[fd7a:115c:a1e0::1]:2222/david/agent-skills.git", reason: null },
      { note: "scp", url: "git@github.com:mattpocock/skills.git", reason: null },
      { note: "scp without a user", url: "github.com:mattpocock/skills.git", reason: null },
      { note: "scp to localhost", url: "git@localhost:david/agent-skills.git", reason: null },
      { note: "scp to an IPv6 literal", url: "git@[fd7a:115c:a1e0::1]:david/agent-skills.git", reason: null },
    ],
    "refuses a credential in the URL": [
      { note: "a user and password in https", url: "https://david:token-for-tests@github.com/david/agent-skills", reason: "credential" },
      { note: "a user alone in https, which a forge takes as a token", url: "https://token-for-tests@github.com/david/agent-skills", reason: "credential" },
      { note: "a password in ssh://", url: "ssh://git:token-for-tests@github.com/david/agent-skills.git", reason: "credential" },
      { note: "a password in scp", url: "git:token-for-tests@github.com:david/agent-skills.git", reason: "credential" },
    ],
    "refuses a query and a fragment": [
      { note: "a query in https", url: "https://github.com/david/agent-skills?tab=readme", reason: "query" },
      { note: "a query in scp", url: "git@github.com:david/agent-skills.git?ref=main", reason: "query" },
      { note: "a fragment in https", url: "https://github.com/david/agent-skills#readme", reason: "fragment" },
      { note: "a fragment in ssh://", url: "ssh://git@github.com/david/agent-skills.git#main", reason: "fragment" },
    ],
    "refuses a leading hyphen, which git or ssh would read as an option": [
      { note: "an option for git", url: "--upload-pack=touch /tmp/pwned", reason: "leading_hyphen" },
      { note: "an option for ssh", url: "-oProxyCommand=touch", reason: "leading_hyphen" },
      { note: "an ssh:// host that is an option", url: "ssh://-oProxyCommand=touch/david/agent-skills", reason: "leading_hyphen" },
      { note: "an ssh:// user that is an option", url: "ssh://-oProxyCommand=touch@github.com/david/agent-skills", reason: "leading_hyphen" },
      { note: "an scp host that is an option", url: "git@-proxy.example.com:david/agent-skills.git", reason: "leading_hyphen" },
      { note: "an scp path that is an option", url: "github.com:-david/agent-skills.git", reason: "leading_hyphen" },
    ],
    "refuses any other scheme": [
      { note: "http", url: "http://github.com/david/agent-skills", reason: "scheme" },
      { note: "git://", url: "git://github.com/david/agent-skills.git", reason: "scheme" },
      { note: "git+ssh://", url: "git+ssh://git@github.com/david/agent-skills.git", reason: "scheme" },
      { note: "ftp", url: "ftp://github.com/david/agent-skills", reason: "scheme" },
      { note: "a remote helper's transport", url: "ext::sh -c touch% /tmp/pwned", reason: "scheme" },
      { note: "a remote helper's transport before a URL", url: "https::https://github.com/david/agent-skills", reason: "scheme" },
    ],
    "refuses a local path": [
      { note: "an absolute path", url: "/srv/git/agent-skills.git", reason: "local_path" },
      { note: "a relative path", url: "../agent-skills", reason: "local_path" },
      { note: "a home path", url: "~/agent-skills", reason: "local_path" },
      { note: "a Windows path", url: "C:\\repos\\agent-skills", reason: "local_path" },
      { note: "file://", url: "file:///srv/git/agent-skills.git", reason: "local_path" },
      { note: "an scp host without a dot, which the harness reads as a path", url: "buildbox:david/agent-skills.git", reason: "local_path" },
    ],
    "refuses what names no repository, and what git and the harness would read apart": [
      { note: "empty", url: "", reason: "malformed" },
      { note: "white space before it", url: " https://github.com/david/agent-skills", reason: "malformed" },
      { note: "white space in it", url: "https://github.com/david/agent skills", reason: "malformed" },
      { note: "a line break after it", url: "https://github.com/david/agent-skills\n", reason: "malformed" },
      { note: "one path segment", url: "https://github.com/agent-skills.git", reason: "malformed" },
      { note: "only the host", url: "https://github.com/", reason: "malformed" },
      { note: "one path segment, scp", url: "git@github.com:agent-skills.git", reason: "malformed" },
      { note: "a port out of range, https", url: "https://github.com:0/david/agent-skills", reason: "malformed" },
      { note: "a port out of range, ssh://", url: "ssh://git@github.com:65536/david/agent-skills", reason: "malformed" },
      { note: "a host no URL holds", url: "https://[zz::1]/david/agent-skills", reason: "malformed" },
      { note: "a bare host:port, which git reads as scp and the harness as https", url: "git.systemtech.dev:5526/david/agent-skills", reason: "malformed" },
    ],
  };

  describe.each(Object.entries(cases))("%s", (_, table) => {
    it.each(table.map((entry) => [entry.note, entry] as const))("%s", (_note, entry) => {
      const check = checkSourceUrl(entry.url);
      expect(check.ok ? null : check.refusal.reason).toBe(entry.reason);
      if (check.ok) expect(check.value).toBe(entry.url);
      else expect(check.refusal).toMatchObject({ rule: "source-url", message: expect.stringMatching(/\S/) });
    });

    it("is in the published table", () => expectPublished(table, SOURCE_URL_CASES, (entry) => entry.url));
  });

  it("never names a credential it refuses in its message", () => {
    const check = checkSourceUrl("https://david:token-for-tests@github.com/david/agent-skills");
    expect(check.ok ? "" : check.refusal.message).not.toContain("token-for-tests");
  });

  it("takes only a URL that has a repository identity, whatever the forge accounts", () => {
    for (const entry of SOURCE_URL_CASES.filter((candidate) => candidate.reason === null)) expect(repositoryIdentityOf(entry.url, []), entry.url).not.toBeNull();
  });

  it.each(SOURCE_URL_CASES.map((entry) => [entry.note, entry] as const))("holds for the published case: %s", (_note, entry) => {
    const check = checkSourceUrl(entry.url);
    expect(check.ok ? null : check.refusal.reason).toBe(entry.reason);
  });
});

describe("the source folder rule", () => {
  const cases: Record<string, SourceFolderCase[]> = {
    "takes . and relative paths, normalising the separators": [
      { note: "the repository's root", folder: ".", normalised: ".", reason: null },
      { note: "one segment", folder: "skills", normalised: "skills", reason: null },
      { note: "two segments", folder: "skills/engineering", normalised: "skills/engineering", reason: null },
      { note: "backslashes", folder: "skills\\engineering", normalised: "skills/engineering", reason: null },
      { note: "a leading ./", folder: "./skills", normalised: "skills", reason: null },
      { note: "a trailing slash", folder: "skills/", normalised: "skills", reason: null },
      { note: "a doubled slash", folder: "skills//engineering", normalised: "skills/engineering", reason: null },
      { note: "a . segment inside", folder: "skills/./engineering", normalised: "skills/engineering", reason: null },
      { note: "./ alone", folder: "./", normalised: ".", reason: null },
      { note: "a folder whose name begins with a dot", folder: ".agents/skills", normalised: ".agents/skills", reason: null },
      { note: "three dots, which is a name", folder: "...", normalised: "...", reason: null },
      { note: "a space in a name", folder: "my skills", normalised: "my skills", reason: null },
    ],
    "refuses absolute paths": [
      { note: "a POSIX root", folder: "/skills", normalised: null, reason: "absolute" },
      { note: "a backslash root", folder: "\\skills", normalised: null, reason: "absolute" },
      { note: "a Windows drive", folder: "C:\\skills", normalised: null, reason: "absolute" },
      { note: "a Windows drive with a slash", folder: "c:/skills", normalised: null, reason: "absolute" },
      { note: "a drive-relative Windows path", folder: "C:skills", normalised: null, reason: "absolute" },
      { note: "a UNC path", folder: "\\\\server\\share", normalised: null, reason: "absolute" },
    ],
    "refuses .. segments": [
      { note: "the parent", folder: "..", normalised: null, reason: "parent" },
      { note: "out of the repository", folder: "../skills", normalised: null, reason: "parent" },
      { note: "out and back in", folder: "skills/../skills", normalised: null, reason: "parent" },
      { note: "a trailing ..", folder: "skills/..", normalised: null, reason: "parent" },
      { note: "behind backslashes", folder: "skills\\..\\..", normalised: null, reason: "parent" },
    ],
    "refuses nothing at all, and control characters": [
      { note: "empty", folder: "", normalised: null, reason: "empty" },
      { note: "a line break", folder: "skills\n", normalised: null, reason: "malformed" },
      { note: "a NUL", folder: "skills\u0000", normalised: null, reason: "malformed" },
    ],
  };

  describe.each(Object.entries(cases))("%s", (_, table) => {
    it.each(table.map((entry) => [entry.note, entry] as const))("%s", (_note, entry) => {
      const check = checkSourceFolder(entry.folder);
      expect(check.ok ? { normalised: check.value, reason: null } : { normalised: null, reason: check.refusal.reason }).toEqual({ normalised: entry.normalised, reason: entry.reason });
      if (!check.ok) expect(check.refusal).toMatchObject({ rule: "source-folder", message: expect.stringMatching(/\S/) });
    });

    it("is in the published table", () => expectPublished(table, SOURCE_FOLDER_CASES, (entry) => entry.folder));
  });

  it("answers a normalised folder unchanged", () => {
    for (const entry of SOURCE_FOLDER_CASES) {
      if (entry.normalised !== null) expect(checkSourceFolder(entry.normalised), entry.note).toEqual({ ok: true, value: entry.normalised });
    }
  });

  it.each(SOURCE_FOLDER_CASES.map((entry) => [entry.note, entry] as const))("holds for the published case: %s", (_note, entry) => {
    const check = checkSourceFolder(entry.folder);
    expect(check.ok ? check.value : check.refusal.reason).toBe(entry.normalised ?? entry.reason);
  });
});
