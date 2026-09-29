import { z } from "zod";
import { Actor } from "./envelope.js";
import { Timestamp } from "./primitives.js";
import { RepositoryIdentity } from "./repository-identity.js";
import { SkillInvocation, SkillMemberProblem, SkillMemberWarning, SkillName, SkillSourceFolder, SkillSourceUrl } from "./skill-rules.js";

/**
 * The shapes the skills workstream shares (skills spec, "The skill set" and
 * "Skill sources"; ADR 0009, ADR 0029): a member of the skill set, where it
 * comes from and the layer it lies in, a skill source's record and what it
 * follows. The reader, the probe, the syncer, `skills.get` and the catalogue
 * build on them; the rules they hold their names, URLs and folders to are
 * `skill-rules.ts`.
 */

// Sources ------------------------------------------------------------------------

/** A skill source's id. */
export const SkillSourceId = z.uuidv4().meta({
  description: "A skill source's id: a version 4 UUID the environment mints when it adds the source, kept in lowercase.",
});
export type SkillSourceId = z.infer<typeof SkillSourceId>;

/** A commit's full object name. */
export const GitCommit = z
  .string()
  .regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/)
  .meta({ description: "A git commit's full object name: 40 lowercase hexadecimal digits, or 64 in a SHA-256 repository." });
export type GitCommit = z.infer<typeof GitCommit>;

/**
 * A branch a source follows, as git's ref-name rules take one
 * (`git check-ref-format --branch`): no white space, control character or
 * any of `~ ^ : ? * [ \`, no `..` or `@{`, no empty segment, none beginning
 * with `.` or ending with `.lock`, no trailing `/` or `.`, not `@`; and, so
 * no git command ever reads it as an option, not beginning with `-`. At
 * most 255 characters.
 */
export const SkillSourceBranch = z
  .string()
  .regex(/^(?!-)(?!\/)(?![\s\S]*\/\/)(?![\s\S]*\.\.)(?![\s\S]*@\{)(?!(?:[\s\S]*\/)?\.)(?![\s\S]*\.lock(?:\/|$))(?![\s\S]*[/.]$)(?!@$)[^\s\p{Cc}~^:?*[\\]{1,255}$/u)
  .meta({
    description:
      "A branch a skill source follows, as git takes a branch name: 1 to 255 characters with no white space, control character or any of ~ ^ : ? * [ \\, no .. or @{, no empty segment, none beginning with . or ending with .lock, no trailing / or ., not @, and not beginning with -.",
  });
export type SkillSourceBranch = z.infer<typeof SkillSourceBranch>;

/** What a source follows (ADR 0029): a branch, or a pinned commit, which never syncs. */
export const SkillSourceFollow = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("branch"),
        branch: SkillSourceBranch.nullable().meta({ description: "The branch; null for the remote's default branch, the one its HEAD names." }),
      })
      .meta({ description: "A branch the source syncs from, at start, every six hours and on Pull now." }),
    z
      .object({ kind: z.literal("pinned"), commit: GitCommit })
      .meta({ description: "A commit the source is pinned to: it never syncs until it is unpinned." }),
  ])
  .meta({ description: "What a skill source follows: a branch (null for the remote's default), or a pinned commit, which never syncs." });
export type SkillSourceFollow = z.infer<typeof SkillSourceFollow>;

/**
 * A skill source's record (skills spec, "Skill sources"; ADR 0029): the URL
 * as entered and its repository identity, the folder read, what it follows,
 * its position among the environment's sources, and who added it when. At
 * most twenty on an environment, one per identity and folder: those rules
 * are the add's.
 */
export const SkillSource = z
  .object({
    id: SkillSourceId,
    url: SkillSourceUrl,
    identity: RepositoryIdentity.meta({ description: "The URL's repository identity, which the source is known by with its folder." }),
    folder: SkillSourceFolder,
    follow: SkillSourceFollow,
    position: z.int().positive().meta({
      description: "Where the source stands among the environment's sources, in the order they were added, from 1: of two sources holding one name, the earlier wins.",
    }),
    addedBy: Actor.meta({ description: "Who added the source: the client session a person added it from, or the environment's own importer." }),
    addedAt: Timestamp.meta({ description: "When the source was added." }),
  })
  .meta({
    description:
      "A skill source: a repository and folder the environment tracks for skills, following a branch or pinned to a commit. The URL is as entered and passed the source URL rule; the identity is its repository identity; the folder is . for the repository's root.",
  });
export type SkillSource = z.infer<typeof SkillSource>;

// Members ------------------------------------------------------------------------

/** A commit as a provenance manifest names it: full, or abbreviated. */
const ManifestCommit = z
  .string()
  .regex(/^[0-9a-f]{4,64}$/)
  .meta({ description: "The commit the member was copied at, as the manifest names it: its object name, full or abbreviated." });

/**
 * Where a member comes from (skills spec, "Readiness"): the readiness
 * overlay is keyed by its repository identity and folder path. A member of
 * a source or a trusted repository has that repository's identity and its
 * folder there; a copy has what a provenance manifest beside it names
 * (the vendoring format: per folder, repository, path, commit and licence).
 */
export const SkillOrigin = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("repository"),
        repository: RepositoryIdentity.meta({ description: "The identity of the repository the member was read from: its source's, or the trusted repository's." }),
        path: SkillSourceFolder.meta({ description: "The member's folder in that repository, from its root; . when the root is itself the skill." }),
      })
      .meta({ description: "The repository the member was read from, by its identity, and the member's folder there." }),
    z
      .object({
        kind: z.literal("manifest"),
        repository: RepositoryIdentity.meta({ description: "The identity of the repository the manifest says the member was copied from." }),
        path: SkillSourceFolder.meta({ description: "The member's folder in that repository, as the manifest names it." }),
        commit: ManifestCommit.nullable(),
        licence: z.string().min(1).nullable().meta({ description: "The licence the manifest names, an SPDX identifier where it gives one; null when it names none." }),
      })
      .meta({ description: "What a provenance manifest beside the member names: the repository and folder it was copied from, the commit and the licence." }),
  ])
  .meta({
    description:
      "Where a member comes from, which the readiness overlay is keyed by (repository identity and folder path): the repository it was read from, or what a provenance manifest beside a copy names.",
  });
export type SkillOrigin = z.infer<typeof SkillOrigin>;

/** The roots of a trusted repository whose skills join the set, in the order they win a name. */
export const SKILL_REPOSITORY_ROOTS = [".claude/skills", ".agents/skills"] as const;

/**
 * The layer a member lies in (skills spec, "The skill set"): a source's
 * current snapshot, the environment's own directory, or, once the session's
 * repository is trusted, a `.claude/skills` or `.agents/skills` in the
 * workspace directory or one of its parents up to the repository's root.
 */
export const SkillLayer = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("source"), sourceId: SkillSourceId }).meta({ description: "A tracked source's current snapshot." }),
    z.object({ kind: z.literal("own") }).meta({ description: "The environment's own skills directory, or its commands directory." }),
    z
      .object({
        kind: z.literal("repository"),
        root: z.enum(SKILL_REPOSITORY_ROOTS).meta({ description: "The root the member lies under: .claude/skills, which wins a name over .agents/skills." }),
        directory: SkillSourceFolder.meta({
          description: "The directory holding that root, from the repository's root: the workspace directory or one of its parents, . for the repository's root; a nearer one wins a name.",
        }),
      })
      .meta({ description: "A trusted repository's own skills." }),
  ])
  .meta({ description: "The layer a member lies in: a source, the own directory, or a trusted repository's .claude/skills or .agents/skills." });
export type SkillLayer = z.infer<typeof SkillLayer>;

/**
 * A member of a skill set (skills spec, "The skill set"): a folder holding
 * `SKILL.md`, or a command file in the own directory's `commands/`. Its
 * name, description, invocation and whether it is user-invocable are what
 * `readSkillMember` reads of it; a member with problems is invalid, listed
 * and left out of the set, its name null when that is the problem.
 */
export const SkillMember = z
  .object({
    name: SkillName.nullable().meta({ description: "The member's name by the member-naming rule; null when none passes, a name problem saying why." }),
    description: z.string().min(1).nullable().meta({ description: "The member's description, trimmed; null when it has none, a description problem saying so." }),
    invocation: SkillInvocation,
    userInvocable: z.boolean().meta({ description: "Whether a person may invoke it: false exactly when its frontmatter sets user-invocable: false, which leaves it out of the / menu." }),
    origin: SkillOrigin.nullable().meta({ description: "Where it comes from; null for a member of the own directory with no provenance manifest, or of a repository with no identity." }),
    layer: SkillLayer,
    size: z.int().nonnegative().meta({ description: "Its body's length in characters, which always-on appends to every run; a quarter of it approximates the tokens." }),
    problems: z.array(SkillMemberProblem).meta({ description: "Empty for a valid member; any problem leaves it invalid and out of the set." }),
    warnings: z.array(SkillMemberWarning).meta({ description: "Warnings that leave it in the set." }),
  })
  .meta({
    description:
      "A member of a skill set: its name, description, invocation, whether a person may invoke it, its origin, its layer, its body's size, and its problems (any leaves it invalid) and warnings.",
  });
export type SkillMember = z.infer<typeof SkillMember>;
