import { z } from "zod";
import { normaliseRemote } from "./forge.js";

/**
 * The three rules that decide what a skill is called and what a skill
 * source may point at (skills spec, "The skill set" and "Skill sources";
 * ADR 0029): the skill-name rule, which is the Agent Skills one; the source
 * URL rule; and the source folder rule. Every part of the skills workstream
 * uses them: the reader naming a member, the probe and the add refusing a
 * URL or a folder, the catalogue's contract test, and a client checking a
 * form before it sends. They are pure, and their cases are published beside
 * the schemas (`cases/skill-*.json`) so a client in another language runs
 * the same ones.
 */

// Refusals ----------------------------------------------------------------------

/** Why the skill-name rule refuses a name, in the order it checks. */
export const SKILL_NAME_REASONS = ["character", "length", "leading_hyphen", "trailing_hyphen", "doubled_hyphen"] as const;
export type SkillNameReason = (typeof SKILL_NAME_REASONS)[number];

/** Why the source URL rule refuses a URL, in the order it checks. */
export const SOURCE_URL_REASONS = ["leading_hyphen", "scheme", "local_path", "credential", "query", "fragment", "malformed"] as const;
export type SourceUrlReason = (typeof SOURCE_URL_REASONS)[number];

/** Why the source folder rule refuses a folder, in the order it checks. */
export const SOURCE_FOLDER_REASONS = ["empty", "malformed", "absolute", "parent"] as const;
export type SourceFolderReason = (typeof SOURCE_FOLDER_REASONS)[number];

/**
 * The params of an `invalid_params` issue a skill rule raised (skills spec,
 * "Wire summary"): the rule and its reason. The issue's path names the
 * field and its message says why, for people.
 */
export const SkillRuleIssueParams = z
  .discriminatedUnion("rule", [
    z.object({ rule: z.literal("skill-name"), reason: z.enum(SKILL_NAME_REASONS).meta({ description: "Why the skill-name rule refused the name." }) }),
    z.object({ rule: z.literal("source-url"), reason: z.enum(SOURCE_URL_REASONS).meta({ description: "Why the source URL rule refused the URL." }) }),
    z.object({ rule: z.literal("source-folder"), reason: z.enum(SOURCE_FOLDER_REASONS).meta({ description: "Why the source folder rule refused the folder." }) }),
  ])
  .meta({
    description:
      "The params of an invalid_params issue a skill rule raised: the rule (skill-name, source-url or source-folder) and its reason. The issue's path names the field; its message says why. The published cases (cases/skill-name.json, cases/skill-source-url.json, cases/skill-source-folder.json) give each reason's inputs.",
  });
export type SkillRuleIssueParams = z.infer<typeof SkillRuleIssueParams>;

/** The rules, as a refusal names them. */
export type SkillRule = SkillRuleIssueParams["rule"];

/** A rule's refusal: the rule, its reason, and a sentence for people. */
export type SkillRuleRefusal<R extends SkillRule = SkillRule> = Extract<SkillRuleIssueParams, { rule: R }> & { readonly message: string };

/** What a rule answers: the value it takes (normalised where the rule normalises), or its refusal. */
export type SkillRuleCheck<R extends SkillRule> = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly refusal: SkillRuleRefusal<R> };

// The skill-name rule -------------------------------------------------------------

/** The longest skill name. */
export const MAX_SKILL_NAME = 64;

/** Why `name` fails the skill-name rule, with the reason; null when it passes. */
const skillNameFault = (name: string): { readonly reason: SkillNameReason; readonly why: string } | null => {
  if (/[^a-z0-9-]/.test(name)) return { reason: "character", why: "holds a character other than a-z, 0-9 and -" };
  if (name.length < 1 || name.length > MAX_SKILL_NAME) return { reason: "length", why: `is not 1 to ${MAX_SKILL_NAME} characters long` };
  if (name.startsWith("-")) return { reason: "leading_hyphen", why: "begins with a hyphen" };
  if (name.endsWith("-")) return { reason: "trailing_hyphen", why: "ends with a hyphen" };
  if (name.includes("--")) return { reason: "doubled_hyphen", why: "holds a doubled hyphen" };
  return null;
};

/**
 * The skill-name rule, the Agent Skills one: 1 to 64 of `a-z`, `0-9` and
 * `-`, with no leading, trailing or doubled hyphen. Checked in that order,
 * characters first, so every language counts the length alike.
 */
export const checkSkillName = (name: string): SkillRuleCheck<"skill-name"> => {
  const fault = skillNameFault(name);
  return fault === null ? { ok: true, value: name } : { ok: false, refusal: { rule: "skill-name", reason: fault.reason, message: `The skill name ${JSON.stringify(name)} ${fault.why}.` } };
};

// The source URL rule ------------------------------------------------------------------

/** A URL's scheme, before `://`. */
const URL_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
/** git's `<transport>::<address>`, which hands the address to a remote helper. */
const REMOTE_HELPER = /^[a-z][a-z0-9+.-]*::/i;
/** A URL's authority, after its scheme. */
const URL_AUTHORITY = /^[^:]+:\/\/([^/?#]*)/s;
/** git's scp form, `[user@]host:path`, once the forge normaliser has read the text as one. */
const SCP_PARTS = /^(?:([^@/]*)@)?(\[[^\]]*\]|[^:]*):(.*)$/s;
/** A host and port: a bracketed IPv6 literal or a name, then any port. */
const HOST_PORT = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/s;

/** A URL's parts the rule reads: the scheme (null for the scp form), any user part, the host, the port's digits and the scp form's path. */
interface SourceUrlParts {
  readonly scheme: "https" | "ssh" | null;
  readonly userinfo: string | null;
  readonly host: string;
  readonly port: string;
  readonly scpPath: string | null;
}

/** The parts of a URL in a form the rule takes, which the normaliser has read as a remote. */
const sourceUrlParts = (url: string, scheme: "https" | "ssh" | null): SourceUrlParts => {
  if (scheme === null) {
    const [, userinfo = null, host = "", scpPath = ""] = SCP_PARTS.exec(url) ?? [];
    return { scheme, userinfo, host, port: "", scpPath };
  }
  const authority = URL_AUTHORITY.exec(url)?.[1] ?? "";
  const at = authority.lastIndexOf("@");
  const [, host = "", port = ""] = HOST_PORT.exec(authority.slice(at + 1)) ?? [];
  return { scheme, userinfo: at < 0 ? null : authority.slice(0, at), host, port, scpPath: null };
};

/**
 * The source URL rule (skills spec, "Skill sources"; ADR 0029): what a skill
 * source may be fetched from. It takes `https://`, `ssh://` and git's scp
 * form `[user@]host:path` (whose host has a dot, is `localhost` or is a
 * bracketed IPv6 literal, as the repository identity rule reads it), each
 * naming a repository that has an identity. It refuses, checking in this
 * order:
 *
 * 1. `malformed`: empty.
 * 2. `leading_hyphen`: a URL beginning with `-`, which git would read as an option.
 * 3. `scheme`: any scheme but `https` and `ssh` (`http`, `git`, `git+ssh`
 *    among them), or git's `<transport>::` remote-helper syntax; `file://`
 *    is `local_path`.
 * 4. `malformed`: white space or a control character anywhere.
 * 5. `local_path`: text the repository identity rule reads as a local path.
 * 6. `credential`: userinfo in an `https` URL (a forge takes a token as the
 *    user alone), or a password in an `ssh://` or scp user.
 * 7. `query` and then `fragment`: a `?` or a `#` anywhere.
 * 8. `leading_hyphen`: a user, host or scp path beginning with `-`, which
 *    ssh or git would read as an option.
 * 9. `malformed`: a bare `host:port/path`, which git reads as scp and the
 *    repository identity rule as https; a host or port no URL holds; or a
 *    path under two segments once empty ones and one `.git` are dropped.
 *
 * The message never repeats the URL, which may hold a credential.
 */
export const checkSourceUrl = (url: string): SkillRuleCheck<"source-url"> => {
  const refused = (reason: SourceUrlReason, message: string): SkillRuleCheck<"source-url"> => ({ ok: false, refusal: { rule: "source-url", reason, message } });
  if (url === "") return refused("malformed", "Give the repository's URL.");
  if (url.startsWith("-")) return refused("leading_hyphen", "A URL cannot begin with a hyphen, which git would read as an option.");
  const scheme = URL_SCHEME.exec(url)?.[1]?.toLowerCase() ?? null;
  if (scheme === "file") return refused("local_path", "A skill source is a repository on a forge or ssh host, not a local path: give its https, ssh:// or scp URL.");
  if ((scheme !== null && scheme !== "https" && scheme !== "ssh") || (scheme === null && REMOTE_HELPER.test(url))) {
    return refused("scheme", "A skill source's URL is https://, ssh:// or scp's user@host:path; no other scheme or transport is taken.");
  }
  if (/[\s\p{Cc}]/u.test(url)) return refused("malformed", "A URL holds no white space or control characters.");
  const remote = normaliseRemote(url);
  if (scheme === null && remote === null) {
    return refused("local_path", "A skill source is a repository on a forge or ssh host, not a local path: give its https, ssh:// or scp URL (an scp host needs a dot, or is localhost).");
  }
  const parts = sourceUrlParts(url, scheme);
  if (parts.scheme === "https" ? parts.userinfo !== null : (parts.userinfo?.includes(":") ?? false)) {
    return refused("credential", "The URL holds a credential. Leave it out: the forge account for the URL's origin, or your ssh keys, authenticate the fetch.");
  }
  if (url.includes("?")) return refused("query", "A skill source's URL has no query (?).");
  if (url.includes("#")) return refused("fragment", "A skill source's URL has no fragment (#).");
  if ([parts.userinfo, parts.host, parts.scpPath].some((part) => part?.startsWith("-"))) {
    return refused("leading_hyphen", "A user, host or path in the URL cannot begin with a hyphen, which ssh or git would read as an option.");
  }
  if (remote === null || (scheme === null && !remote.sshDerived)) {
    return refused("malformed", "The URL is not one git and the harness read alike: write https://host/owner/repository, ssh://host/owner/repository or user@host:owner/repository.");
  }
  const port = parts.port === "" ? null : Number(parts.port);
  if (port !== null && (port < 1 || port > 65535)) return refused("malformed", "The URL's port is not 1 to 65535.");
  if (remote.path === null || remote.path.split("/").length < 2) return refused("malformed", "The URL names no repository: its path needs an owner and a repository at least.");
  return { ok: true, value: url };
};

// The source folder rule ------------------------------------------------------------------

/** The repository's root, as a source's folder names it. */
export const ROOT_FOLDER = ".";

/** A path from a root: `/` or `\`, or a Windows drive, which `C:skills` names too. */
const ABSOLUTE = /^(?:[/\\]|[a-z]:)/i;

/**
 * The source folder rule (skills spec, "Skill sources"; ADR 0029): the
 * folder of a repository a source reads, relative to its root. It takes `.`
 * for the root and relative paths, and normalises them: `\` is read as
 * `/`, and empty and `.` segments are dropped, so `.\skills\` is `skills`
 * and `./` is `.`. It refuses, checking in this order: `empty`; `malformed`,
 * a control character; `absolute`, a path from `/` or `\` or on a Windows
 * drive; and `parent`, any `..` segment, even one that comes back in.
 */
export const checkSourceFolder = (folder: string): SkillRuleCheck<"source-folder"> => {
  const refused = (reason: SourceFolderReason, message: string): SkillRuleCheck<"source-folder"> => ({ ok: false, refusal: { rule: "source-folder", reason, message } });
  if (folder === "") return refused("empty", "Name the folder, or . for the repository's root.");
  if (/\p{Cc}/u.test(folder)) return refused("malformed", "A folder holds no control characters.");
  if (ABSOLUTE.test(folder)) return refused("absolute", `The folder ${JSON.stringify(folder)} is absolute: name it from the repository's root, or . for the root itself.`);
  const segments = folder.split(/[/\\]/).filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) return refused("parent", `The folder ${JSON.stringify(folder)} has a .. segment: a source reads only inside its repository.`);
  return { ok: true, value: segments.length === 0 ? ROOT_FOLDER : segments.join("/") };
};

// The rules' schemas ------------------------------------------------------------------

/** Adds a rule's refusal to `ctx` as a custom issue: its message, and the rule and reason as the issue's params. */
const raise = (ctx: z.RefinementCtx, { message, ...params }: SkillRuleRefusal): void => {
  ctx.addIssue({ code: "custom", message, params });
};

/**
 * A skill's name, through the skill-name rule: a refusal is an
 * `invalid_params` issue at the field, naming the rule and its reason. The
 * export's pattern is the same rule.
 */
export const SkillName = z
  .string()
  .superRefine((name, ctx) => {
    const check = checkSkillName(name);
    if (!check.ok) raise(ctx, check.refusal);
  })
  .meta({
    description:
      "A skill's name, by the Agent Skills rule: 1 to 64 of a-z, 0-9 and -, with no leading, trailing or doubled hyphen. Refused as invalid_params, the issue's params naming the rule skill-name and its reason.",
    pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
    maxLength: MAX_SKILL_NAME,
  });

/**
 * A skill source's URL, as entered, through the source URL rule: a refusal
 * is an `invalid_params` issue at the field, naming the rule and its reason.
 * The export's pattern holds only part of the rule (a leading hyphen, white
 * space, a query and a fragment); its cases hold the rest.
 */
export const SkillSourceUrl = z
  .string()
  .superRefine((url, ctx) => {
    const check = checkSourceUrl(url);
    if (!check.ok) raise(ctx, check.refusal);
  })
  .meta({
    description:
      "A skill source's URL, as entered: https://, ssh:// or scp's [user@]host:path, naming a repository with an identity; no credential, query, fragment or leading hyphen, and no other scheme or local path. Refused as invalid_params, the issue's params naming the rule source-url and its reason; this pattern holds part of the rule, and cases/skill-source-url.json holds all of it.",
    pattern: "^(?!-)[^\\x00-\\x20\\x7f-\\x9f?#]+$",
  });

/**
 * A skill source's folder, through the source folder rule, answered
 * normalised: a refusal is an `invalid_params` issue at the field, naming
 * the rule and its reason. The export's pattern is the same rule, over the
 * folder as sent.
 */
export const SkillSourceFolder = z
  .string()
  .transform((folder, ctx) => {
    const check = checkSourceFolder(folder);
    if (check.ok) return check.value;
    raise(ctx, check.refusal);
    return z.NEVER;
  })
  .meta({
    description:
      "A folder of a repository, from its root: . for the root, else a relative path with no .. segment, kept with / between segments and no empty or . segment (a \\ is read as /). Refused as invalid_params, the issue's params naming the rule source-folder and its reason.",
    pattern: "^(?![/\\\\])(?![A-Za-z]:)(?!(?:[\\s\\S]*[/\\\\])?\\.\\.(?:[/\\\\]|$))[^\\p{Cc}]+$",
  });

// Reading a member ------------------------------------------------------------------------

/** How a member is invoked (ADR 0009). */
export const SKILL_INVOCATIONS = ["model+slash", "slash-only"] as const;
export const SkillInvocation = z.enum(SKILL_INVOCATIONS).meta({
  description:
    "How a member is invoked: model+slash (the model may choose it, and a person may type /name), or slash-only (its frontmatter sets disable-model-invocation: true, so only /name invokes it).",
});
export type SkillInvocation = z.infer<typeof SkillInvocation>;

/** What leaves a member invalid. */
export const SKILL_MEMBER_PROBLEM_KINDS = ["name", "description"] as const;
export type SkillMemberProblemKind = (typeof SKILL_MEMBER_PROBLEM_KINDS)[number];

/** A problem that leaves a member invalid: listed with it, and the member left out of the set. */
export const SkillMemberProblem = z
  .object({
    kind: z.enum(SKILL_MEMBER_PROBLEM_KINDS).meta({
      description:
        "What is wrong: name (neither its frontmatter name nor its folder's name passes the skill-name rule) or description (its frontmatter has no description, which the Agent Skills spec requires).",
    }),
    message: z.string().min(1).meta({ description: "What is wrong, for people: the names tried and why each fails." }),
  })
  .meta({ description: "A problem that leaves a member invalid: it is listed with the problem and left out of the skill set." });
export type SkillMemberProblem = z.infer<typeof SkillMemberProblem>;

/** What a member is warned of, while it stays in the set. */
export const SKILL_MEMBER_WARNING_KINDS = ["name-unlike-folder", "frontmatter-name-invalid", "sidecar-invalid"] as const;
export type SkillMemberWarningKind = (typeof SKILL_MEMBER_WARNING_KINDS)[number];

/** A warning on a member that stays in the set. */
export const SkillMemberWarning = z
  .object({
    kind: z.enum(SKILL_MEMBER_WARNING_KINDS).meta({
      description:
        "What the warning is: name-unlike-folder (its name is not its folder's name), frontmatter-name-invalid (its frontmatter name fails the skill-name rule, so it is named after its folder) or sidecar-invalid (its readiness sidecar does not read, and counts as none).",
    }),
    message: z.string().min(1).meta({ description: "The warning, for people." }),
  })
  .meta({ description: "A warning on a member, which stays in the skill set." });
export type SkillMemberWarning = z.infer<typeof SkillMemberWarning>;

/**
 * The folder a member is named after when its frontmatter name fails:
 * `folder`, the member's own folder's name (a child of the folder read); or
 * `root`, for a folder that is itself one skill (the root-skill rule, ADR
 * 0029), the source folder's last segment (null for `.`, the repository's
 * root) and the repository's last path segment (null when there is none).
 */
export type SkillMemberFolder =
  | { readonly kind: "folder"; readonly name: string }
  | { readonly kind: "root"; readonly sourceFolderSegment: string | null; readonly repositorySegment: string | null };

/** What a member's own files say of it: the fields of the member shape the reader takes from its frontmatter and folder. */
export interface SkillMemberReading {
  /** Its name; null when it has none, `problems` then saying why. */
  readonly name: string | null;
  /** Its description, trimmed; null when it has none, `problems` then saying so. */
  readonly description: string | null;
  readonly invocation: SkillInvocation;
  /** Whether a person may invoke it: false exactly when its frontmatter sets `user-invocable: false`. */
  readonly userInvocable: boolean;
  /** Empty for a valid member; anything here leaves it invalid. */
  readonly problems: SkillMemberProblem[];
  readonly warnings: SkillMemberWarning[];
}

/** A name a member may be named after, with what it is to a person. */
interface NameCandidate {
  readonly what: string;
  readonly name: string;
}

/** The folder names a member may be named after, in the order they are tried. */
const folderCandidates = (folder: SkillMemberFolder): NameCandidate[] => {
  if (folder.kind === "folder") return [{ what: "its folder's name", name: folder.name }];
  const candidates: NameCandidate[] = [];
  if (folder.sourceFolderSegment !== null) candidates.push({ what: "its source folder's last segment", name: folder.sourceFolderSegment });
  if (folder.repositorySegment !== null) candidates.push({ what: "its repository's last path segment", name: folder.repositorySegment });
  return candidates;
};

/** Why a frontmatter `name` gives no name; null when it passes or is absent. */
const frontmatterNameFault = (name: unknown): string | null => {
  if (name === undefined || name === null) return null;
  if (typeof name !== "string") return "its frontmatter name is not text";
  const fault = skillNameFault(name);
  return fault === null ? null : `its frontmatter name ${JSON.stringify(name)} ${fault.why}`;
};

/**
 * The member-naming rule (skills spec, "Name"): the frontmatter `name` when
 * it passes the skill-name rule; else the folder's name when that passes,
 * which for a root skill is the source folder's last segment, else the
 * repository's last path segment (the first of them that passes); else the
 * member is invalid, with the problem naming every name tried. A name
 * unlike the folder the member is in is a warning, not a refusal, and so is
 * a frontmatter name passed over for failing.
 */
const nameMember = (
  frontmatterName: unknown,
  folder: SkillMemberFolder,
): { readonly name: string; readonly warnings: SkillMemberWarning[] } | { readonly name: null; readonly problem: SkillMemberProblem } => {
  const folders = folderCandidates(folder);
  const ownFolder = folders[0]?.name ?? null;
  const frontmatterFault = frontmatterNameFault(frontmatterName);
  const fromFrontmatter = typeof frontmatterName === "string" && frontmatterFault === null ? frontmatterName : null;
  const name = fromFrontmatter ?? folders.find((candidate) => skillNameFault(candidate.name) === null)?.name ?? null;
  if (name === null) {
    const faults = [
      frontmatterFault ?? "its frontmatter has no name",
      ...folders.map((candidate) => `${candidate.what} ${JSON.stringify(candidate.name)} ${skillNameFault(candidate.name)?.why ?? ""}`),
    ];
    if (folders.length === 0) faults.push("it has no folder name to fall back on");
    return { name: null, problem: { kind: "name", message: `The member has no name that passes the skill-name rule: ${faults.join("; ")}.` } };
  }
  const warnings: SkillMemberWarning[] = [];
  if (frontmatterFault !== null) warnings.push({ kind: "frontmatter-name-invalid", message: `The member is named ${JSON.stringify(name)} after its folder, since ${frontmatterFault}.` });
  if (ownFolder !== null && name !== ownFolder) warnings.push({ kind: "name-unlike-folder", message: `The name ${JSON.stringify(name)} is unlike its folder's, ${JSON.stringify(ownFolder)}.` });
  return { name, warnings };
};

/**
 * Reads a member from its frontmatter, as parsed (an empty object for
 * none), and its folder (skills spec, "The skill set" and "Name"; the
 * Agent Skills spec): its name by the member-naming rule; its description,
 * a string with more than white space in it, trimmed, without which it is
 * invalid (Codex refuses such a skill too); its invocation, `slash-only`
 * exactly when `disable-model-invocation` is `true`; and whether a person
 * may invoke it, false exactly when `user-invocable` is `false`.
 */
export const readSkillMember = (frontmatter: Readonly<Record<string, unknown>>, folder: SkillMemberFolder): SkillMemberReading => {
  const naming = nameMember(frontmatter.name, folder);
  const description = typeof frontmatter.description === "string" && frontmatter.description.trim() !== "" ? frontmatter.description.trim() : null;
  const problems: SkillMemberProblem[] = naming.name === null ? [naming.problem] : [];
  if (description === null) problems.push({ kind: "description", message: "The member has no description in its frontmatter, and a member needs one: it is what the model reads to choose it." });
  return {
    name: naming.name,
    description,
    invocation: frontmatter["disable-model-invocation"] === true ? "slash-only" : "model+slash",
    userInvocable: frontmatter["user-invocable"] !== false,
    problems,
    warnings: naming.name === null ? [] : naming.warnings,
  };
};
