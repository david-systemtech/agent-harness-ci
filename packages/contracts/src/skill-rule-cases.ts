import type {
  SkillInvocation,
  SkillMemberFolder,
  SkillMemberProblemKind,
  SkillMemberWarningKind,
  SkillNameReason,
  SkillWhileActiveKey,
  SourceFolderReason,
  SourceUrlReason,
} from "./skill-rules.js";

/**
 * The published cases of the skill rules (skills spec, "The skill set" and
 * "Skill sources"): each rule's inputs and the answers the contracts give,
 * written to the JSON Schema export under `cases/` for a client in another
 * language to run its own implementation against.
 */

/** One published case of the skill-name rule: a name in, and why it is refused, or null for taken. */
export interface SkillNameCase {
  /** What the case shows. */
  readonly note: string;
  readonly name: string;
  readonly reason: SkillNameReason | null;
}

/**
 * The skill-name rule's cases, published in the JSON Schema export as
 * `cases/skill-name.json` for a client in another language to run its own
 * implementation against.
 */
export const SKILL_NAME_CASES: readonly SkillNameCase[] = [
  // The length bounds.
  { note: "one letter", name: "a", reason: null },
  { note: "one digit", name: "7", reason: null },
  { note: "sixty-four", name: "a".repeat(64), reason: null },
  { note: "sixty-five", name: "a".repeat(65), reason: "length" },
  { note: "empty", name: "", reason: "length" },
  { note: "words, digits and single hyphens", name: "setup-matt-pocock-skills2", reason: null },
  // Each forbidden character.
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
  // Hyphens.
  { note: "a leading hyphen", name: "-tdd", reason: "leading_hyphen" },
  { note: "a trailing hyphen", name: "tdd-", reason: "trailing_hyphen" },
  { note: "a doubled hyphen", name: "to--spec", reason: "doubled_hyphen" },
  { note: "a hyphen alone", name: "-", reason: "leading_hyphen" },
];


/** One published case of the source URL rule: a URL in, and why it is refused, or null for taken. */
export interface SourceUrlCase {
  /** What the case shows. */
  readonly note: string;
  readonly url: string;
  readonly reason: SourceUrlReason | null;
}

/** The source URL rule's cases, published as `cases/skill-source-url.json`. */
export const SOURCE_URL_CASES: readonly SourceUrlCase[] = [
  // Taken.
  { note: "https", url: "https://github.com/mattpocock/skills", reason: null },
  { note: "https with .git", url: "https://github.com/mattpocock/skills.git", reason: null },
  { note: "https with a port", url: "https://git.systemtech.dev:5526/david/agent-skills.git", reason: null },
  { note: "https in capitals", url: "HTTPS://GitHub.com/MattPocock/Skills", reason: null },
  { note: "https to a subgroup", url: "https://gitlab.com/group/subgroup/skills", reason: null },
  { note: "https with a trailing slash", url: "https://github.com/mattpocock/skills/", reason: null },
  { note: "ssh:// with a user", url: "ssh://git@github.com/mattpocock/skills.git", reason: null },
  { note: "ssh:// with a port", url: "ssh://git@git.systemtech.dev:2222/david/agent-skills.git", reason: null },
  { note: "ssh:// without a user", url: "ssh://github.com/mattpocock/skills", reason: null },
  { note: "ssh:// to an IPv6 literal", url: "ssh://git@[fd7a:115c:a1e0::1]:2222/david/agent-skills.git", reason: null },
  { note: "scp", url: "git@github.com:mattpocock/skills.git", reason: null },
  { note: "scp without a user", url: "github.com:mattpocock/skills.git", reason: null },
  { note: "scp to localhost", url: "git@localhost:david/agent-skills.git", reason: null },
  { note: "scp to an IPv6 literal", url: "git@[fd7a:115c:a1e0::1]:david/agent-skills.git", reason: null },
  // A credential.
  { note: "a user and password in https", url: "https://david:token-for-tests@github.com/david/agent-skills", reason: "credential" },
  { note: "a user alone in https, which a forge takes as a token", url: "https://token-for-tests@github.com/david/agent-skills", reason: "credential" },
  { note: "a password in ssh://", url: "ssh://git:token-for-tests@github.com/david/agent-skills.git", reason: "credential" },
  { note: "a password in scp", url: "git:token-for-tests@github.com:david/agent-skills.git", reason: "credential" },
  { note: "a credential checked before a query", url: "https://token-for-tests@github.com/david/agent-skills?tab=readme", reason: "credential" },
  // A query and a fragment.
  { note: "a query in https", url: "https://github.com/david/agent-skills?tab=readme", reason: "query" },
  { note: "a query in scp", url: "git@github.com:david/agent-skills.git?ref=main", reason: "query" },
  { note: "a fragment in https", url: "https://github.com/david/agent-skills#readme", reason: "fragment" },
  { note: "a fragment in ssh://", url: "ssh://git@github.com/david/agent-skills.git#main", reason: "fragment" },
  // A leading hyphen.
  { note: "an option for git", url: "--upload-pack=touch /tmp/pwned", reason: "leading_hyphen" },
  { note: "an option for ssh", url: "-oProxyCommand=touch", reason: "leading_hyphen" },
  { note: "an ssh:// host that is an option", url: "ssh://-oProxyCommand=touch/david/agent-skills", reason: "leading_hyphen" },
  { note: "an ssh:// user that is an option", url: "ssh://-oProxyCommand=touch@github.com/david/agent-skills", reason: "leading_hyphen" },
  { note: "an scp host that is an option", url: "git@-proxy.example.com:david/agent-skills.git", reason: "leading_hyphen" },
  { note: "an scp path that is an option", url: "github.com:-david/agent-skills.git", reason: "leading_hyphen" },
  // Another scheme.
  { note: "http", url: "http://github.com/david/agent-skills", reason: "scheme" },
  { note: "git://", url: "git://github.com/david/agent-skills.git", reason: "scheme" },
  { note: "git+ssh://", url: "git+ssh://git@github.com/david/agent-skills.git", reason: "scheme" },
  { note: "ftp", url: "ftp://github.com/david/agent-skills", reason: "scheme" },
  { note: "a remote helper's transport", url: "ext::sh -c touch% /tmp/pwned", reason: "scheme" },
  { note: "a remote helper's transport before a URL", url: "https::https://github.com/david/agent-skills", reason: "scheme" },
  // A local path.
  { note: "an absolute path", url: "/srv/git/agent-skills.git", reason: "local_path" },
  { note: "a relative path", url: "../agent-skills", reason: "local_path" },
  { note: "a home path", url: "~/agent-skills", reason: "local_path" },
  { note: "a Windows path", url: "C:\\repos\\agent-skills", reason: "local_path" },
  { note: "file://", url: "file:///srv/git/agent-skills.git", reason: "local_path" },
  { note: "an scp host without a dot, which the harness reads as a path", url: "buildbox:david/agent-skills.git", reason: "local_path" },
  // Malformed.
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
];

/** One published case of the source folder rule: a folder in, and the folder normalised, or why it is refused. */
export interface SourceFolderCase {
  /** What the case shows. */
  readonly note: string;
  readonly folder: string;
  /** The folder as the rule normalises it; null when refused. */
  readonly normalised: string | null;
  readonly reason: SourceFolderReason | null;
}

/** The source folder rule's cases, published as `cases/skill-source-folder.json`. */
export const SOURCE_FOLDER_CASES: readonly SourceFolderCase[] = [
  // Taken, and normalised.
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
  // Absolute.
  { note: "a POSIX root", folder: "/skills", normalised: null, reason: "absolute" },
  { note: "a backslash root", folder: "\\skills", normalised: null, reason: "absolute" },
  { note: "a Windows drive", folder: "C:\\skills", normalised: null, reason: "absolute" },
  { note: "a Windows drive with a slash", folder: "c:/skills", normalised: null, reason: "absolute" },
  { note: "a drive-relative Windows path", folder: "C:skills", normalised: null, reason: "absolute" },
  { note: "a UNC path", folder: "\\\\server\\share", normalised: null, reason: "absolute" },
  // A .. segment.
  { note: "the parent", folder: "..", normalised: null, reason: "parent" },
  { note: "out of the repository", folder: "../skills", normalised: null, reason: "parent" },
  { note: "out and back in", folder: "skills/../skills", normalised: null, reason: "parent" },
  { note: "a trailing ..", folder: "skills/..", normalised: null, reason: "parent" },
  { note: "behind backslashes", folder: "skills\\..\\..", normalised: null, reason: "parent" },
  // Nothing, and control characters.
  { note: "empty", folder: "", normalised: null, reason: "empty" },
  { note: "a line break", folder: "skills\n", normalised: null, reason: "malformed" },
  { note: "a NUL", folder: "skills\u0000", normalised: null, reason: "malformed" },
];

/** One published case of reading a member: its frontmatter and folder in, the fields the reading answers out, each problem and warning by its kind. */
export interface SkillMemberCase {
  /** What the case shows. */
  readonly note: string;
  /** The frontmatter as parsed; an empty object for none, null for frontmatter that does not read as a YAML mapping. */
  readonly frontmatter: Readonly<Record<string, unknown>> | null;
  readonly folder: SkillMemberFolder;
  readonly name: string | null;
  readonly description: string | null;
  readonly invocation: SkillInvocation;
  readonly userInvocable: boolean;
  readonly whileActive: readonly SkillWhileActiveKey[];
  readonly problems: readonly SkillMemberProblemKind[];
  readonly warnings: readonly SkillMemberWarningKind[];
}

/** A case whose answer is an ordinary member's but for what it tests. */
const member = (note: string, frontmatter: Readonly<Record<string, unknown>> | null, folder: SkillMemberFolder, answer: Partial<SkillMemberCase>): SkillMemberCase => ({
  note,
  frontmatter,
  folder,
  name: null,
  description: "Test-driven development.",
  invocation: "model+slash",
  userInvocable: true,
  whileActive: [],
  problems: [],
  warnings: [],
  ...answer,
});
const described = { description: "Test-driven development." };
const tdd: SkillMemberFolder = { kind: "folder", name: "tdd" };
const review: SkillMemberFolder = { kind: "file", name: "review" };

/**
 * The cases of reading a member, published as `cases/skill-member.json`:
 * its name by the member-naming rule, its description, its invocation,
 * whether it is user-invocable and the keys it declares that act while it
 * is active.
 */
export const SKILL_MEMBER_CASES: readonly SkillMemberCase[] = [
  // The frontmatter name, else the folder's, else invalid.
  member("the frontmatter name, like its folder", { name: "tdd", ...described }, tdd, { name: "tdd" }),
  member("no frontmatter name: the folder's", described, tdd, { name: "tdd" }),
  member("a frontmatter name of null: the folder's", { name: null, ...described }, tdd, { name: "tdd" }),
  member("a frontmatter name that fails: the folder's, with a warning", { name: "Test Driven", ...described }, tdd, { name: "tdd", warnings: ["frontmatter-name-invalid"] }),
  member("a frontmatter name that is not text: the folder's, with a warning", { name: 42, ...described }, tdd, { name: "tdd", warnings: ["frontmatter-name-invalid"] }),
  member("both failing: invalid", { name: "Test Driven", ...described }, { kind: "folder", name: "Test_Driven" }, { problems: ["name"] }),
  member("no frontmatter name and a folder that fails: invalid", described, { kind: "folder", name: "TDD" }, { problems: ["name"] }),
  member("a frontmatter name unlike its folder", { name: "test-driven", ...described }, tdd, { name: "test-driven", warnings: ["name-unlike-folder"] }),
  // A root skill.
  member("the repository's, for a source at the root", described, { kind: "root", sourceFolderSegment: null, repositorySegment: "unslop" }, { name: "unslop" }),
  member("the source folder's before the repository's", described, { kind: "root", sourceFolderSegment: "unslop", repositorySegment: "writing-skills" }, { name: "unslop" }),
  member("the repository's when the source folder's fails, with a warning", described, { kind: "root", sourceFolderSegment: "Unslop_v2", repositorySegment: "unslop" }, {
    name: "unslop",
    warnings: ["name-unlike-folder"],
  }),
  member("the frontmatter name first", { name: "unslop", ...described }, { kind: "root", sourceFolderSegment: null, repositorySegment: "unslop-skill" }, {
    name: "unslop",
    warnings: ["name-unlike-folder"],
  }),
  member("both segments failing: invalid", described, { kind: "root", sourceFolderSegment: "Unslop_v2", repositorySegment: "Unslop.Skill" }, { problems: ["name"] }),
  member("no segment at all, and a frontmatter name", { name: "unslop", ...described }, { kind: "root", sourceFolderSegment: null, repositorySegment: null }, { name: "unslop" }),
  member("no segment at all, and no frontmatter name: invalid", described, { kind: "root", sourceFolderSegment: null, repositorySegment: null }, { problems: ["name"] }),
  // The description.
  member("no description", { name: "tdd" }, tdd, { name: "tdd", description: null, problems: ["description"] }),
  member("a blank description", { name: "tdd", description: "  \n" }, tdd, { name: "tdd", description: null, problems: ["description"] }),
  member("a description that is not text", { name: "tdd", description: ["one", "two"] }, tdd, { name: "tdd", description: null, problems: ["description"] }),
  member("neither a name nor a description", {}, { kind: "folder", name: "TDD" }, { description: null, problems: ["name", "description"] }),
  member("a description trimmed", { name: "tdd", description: "  Test-driven development.\n" }, tdd, { name: "tdd" }),
  // The invocation and user-invocable.
  member("disable-model-invocation: true", { ...described, "disable-model-invocation": true }, tdd, { name: "tdd", invocation: "slash-only" }),
  member("disable-model-invocation: false", { ...described, "disable-model-invocation": false }, tdd, { name: "tdd" }),
  member("disable-model-invocation as the text true", { ...described, "disable-model-invocation": "true" }, tdd, { name: "tdd" }),
  member("user-invocable: false", { ...described, "user-invocable": false }, tdd, { name: "tdd", userInvocable: false }),
  member("user-invocable as the text false", { ...described, "user-invocable": "false" }, tdd, { name: "tdd" }),
  member("both", { ...described, "disable-model-invocation": true, "user-invocable": false }, tdd, { name: "tdd", invocation: "slash-only", userInvocable: false }),
  // A command file.
  member("a command, named by its file", described, review, { name: "review" }),
  member("a command's frontmatter name passed over", { name: "code-review", ...described }, review, { name: "review" }),
  member("a command file whose name fails: invalid", { name: "review", ...described }, { kind: "file", name: "Review_Notes" }, { problems: ["name"] }),
  member("a command without a description: invalid", { "argument-hint": "[branch]" }, review, { name: "review", description: null, problems: ["description"] }),
  member("a slash-only command", { ...described, "disable-model-invocation": true }, review, { name: "review", invocation: "slash-only" }),
  // The keys that act while the skill is active.
  member("hooks", { ...described, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./check.sh" }] }] } }, tdd, { name: "tdd", whileActive: ["hooks"] }),
  member("allowed-tools as a list", { ...described, "allowed-tools": ["Bash(git status:*)", "Read"] }, tdd, { name: "tdd", whileActive: ["allowed-tools"] }),
  member("allowed-tools as text", { ...described, "allowed-tools": "Bash(git diff:*)" }, review, { name: "review", whileActive: ["allowed-tools"] }),
  member("both, in one order", { ...described, "allowed-tools": "Read", hooks: { Stop: [] } }, tdd, { name: "tdd", whileActive: ["hooks", "allowed-tools"] }),
  member("empty keys flag nothing", { ...described, hooks: {}, "allowed-tools": [] }, tdd, { name: "tdd" }),
  member("keys set to nothing flag nothing", { ...described, hooks: null, "allowed-tools": "" }, tdd, { name: "tdd" }),
  // Frontmatter that does not read.
  member("frontmatter that does not read", null, tdd, { name: "tdd", description: null, problems: ["frontmatter"] }),
  member("frontmatter that does not read, in a folder that fails", null, { kind: "folder", name: "TDD" }, { description: null, problems: ["frontmatter", "name"] }),
];
