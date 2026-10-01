import { z } from "zod";
import { AccountId } from "./accounts.js";
import { InstructionChannelKind } from "./adapter.js";
import { Actor } from "./envelope.js";
import type { EventTypeEntry } from "./event-types.js";
import { ForgeOrigin } from "./forge.js";
import { Timestamp } from "./primitives.js";
import { RepositoryIdentity } from "./repository-identity.js";
import { PRODUCT_NAME } from "./product.js";
import {
  SKILL_REPOSITORY_ROOTS,
  SkillInvocation,
  SkillMemberProblem,
  SkillMemberWarning,
  SkillName,
  SkillSourceFolder,
  SkillSourceUrl,
  SkillWhileActiveKey,
} from "./skill-rules.js";
import { AbsolutePath } from "./sessions.js";

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

/** What a member is: a folder holding `SKILL.md`, or a command file in the own directory's `commands/`. */
export const SKILL_MEMBER_KINDS = ["skill", "command"] as const;
export const SkillMemberKind = z.enum(SKILL_MEMBER_KINDS).meta({
  description: "What a member is: skill, a folder holding SKILL.md; or command, a Markdown file in the own directory's commands/, named by its file.",
});
export type SkillMemberKind = z.infer<typeof SkillMemberKind>;

/** The approximate tokens a body of `size` characters costs: a quarter of its characters, rounded up (skills spec, "Choices"). */
export const approximateTokens = (size: number): number => Math.ceil(size / 4);

/**
 * A member of a skill set (skills spec, "The skill set"): a folder holding
 * `SKILL.md`, or a command file in the own directory's `commands/`. Its
 * name, description, invocation, whether it is user-invocable and the keys
 * it declares that act while it is active are what `readSkillMember` reads
 * of it; where it lies, its body's size and the tokens that approximates
 * are the reader's. A member with problems is invalid, listed and left out
 * of the set, its name null when that is the problem.
 */
export const SkillMember = z
  .object({
    name: SkillName.nullable().meta({ description: "The member's name by the member-naming rule; null when none passes, a name problem saying why." }),
    kind: SkillMemberKind,
    path: SkillSourceFolder.meta({
      description:
        "Where the member lies, from its layer's folder: in the own directory, skills/<folder> or commands/<file>; in a source's snapshot, its folder from the source's folder (. when that folder is itself the skill); in a trusted repository, its folder under the root.",
    }),
    description: z.string().min(1).nullable().meta({ description: "The member's description, trimmed; null when it has none, a description problem saying so." }),
    invocation: SkillInvocation,
    userInvocable: z.boolean().meta({ description: "Whether a person may invoke it: false exactly when its frontmatter sets user-invocable: false, which leaves it out of the / menu." }),
    whileActive: z.array(SkillWhileActiveKey).meta({ description: "The keys its frontmatter declares that act while it is active, hooks before allowed-tools; empty for none." }),
    origin: SkillOrigin.nullable().meta({ description: "Where it comes from; null for a member of the own directory with no provenance manifest, or of a repository with no identity." }),
    layer: SkillLayer,
    size: z.int().nonnegative().meta({ description: "Its body's length in characters, after its frontmatter, which always-on appends to every run." }),
    tokens: z.int().nonnegative().meta({ description: "The tokens its body approximately costs: a quarter of its size, rounded up." }),
    problems: z.array(SkillMemberProblem).meta({ description: "Empty for a valid member; any problem leaves it invalid and out of the set." }),
    warnings: z.array(SkillMemberWarning).meta({ description: "Warnings that leave it in the set." }),
  })
  .meta({
    description:
      "A member of a skill set: its name, whether it is a skill folder or a command file and where it lies, its description, invocation, whether a person may invoke it, the keys it declares that act while it is active, its origin, its layer, its body's size and approximate tokens, and its problems (any leaves it invalid) and warnings.",
  });
export type SkillMember = z.infer<typeof SkillMember>;

// The set --------------------------------------------------------------------------

/** A member named by where it lies: its layer and its path there, which no two members share. */
export const SkillMemberRef = z
  .object({ layer: SkillLayer, path: SkillMember.shape.path })
  .meta({ description: "A member named by where it lies: its layer and its path from that layer's folder." });
export type SkillMemberRef = z.infer<typeof SkillMemberRef>;

/**
 * A member as a resolved skill set lists it (skills spec, "The skill set",
 * "Precedence"): the member, and the member that shadows it when another
 * holding its name wins. A member in the set has no problem and is shadowed
 * by none; an invalid member is listed with its problems, left out of the
 * set, and shadows nothing.
 */
export const SkillSetMember = SkillMember.extend({
  shadowedBy: SkillMemberRef.nullable().meta({
    description: "The member holding its name that wins over it by precedence, which leaves this one out of the set; null for a member in the set, and for an invalid one.",
  }),
}).meta({
  description:
    "A member as a resolved skill set lists it: the member, and the member that shadows it when one holding its name wins by precedence. In the set when it has no problem and nothing shadows it.",
});
export type SkillSetMember = z.infer<typeof SkillSetMember>;

// Choices --------------------------------------------------------------------------

/**
 * The stream kind of the skill set's choices; its one stream's id is the
 * environment's (skills spec, "Wire summary"), as the trust stream's is.
 */
export const SKILLS_STREAM_KIND = "skills";

/** A name switched off, or on again, for one account or the whole environment: the choice's fields and the event's. */
const enabledChoiceShape = {
  name: SkillName,
  accountId: AccountId.nullable().meta({ description: "The account the choice is for; null for the whole environment, whose choice outranks an account's." }),
  enabled: z.boolean().meta({ description: "Whether the name is on: off leaves it out of the set whichever layers hold it." }),
};

/** A name made always-on, or not, for one account: the choice's fields and the event's. */
const alwaysOnChoiceShape = {
  name: SkillName,
  accountId: AccountId.meta({ description: "The account whose runs append the member." }),
  on: z.boolean().meta({ description: "Whether every run of the account appends the member's body." }),
};

/**
 * A choice made about a name (skills spec, "Choices: disabled and
 * always-on"; ADR 0009, ADR 0029): switched off or on for one account or,
 * with a null account, the whole environment, whose choice, either way,
 * outranks an account's; or always-on for one account. Keyed by name, so it
 * applies to every layer holding the name, and a choice for a name not in
 * the set is inert until the name appears. Choices naming an account the
 * environment removes are dropped.
 */
export const SkillChoice = z
  .discriminatedUnion("kind", [
    z
      .object({ kind: z.literal("enabled"), ...enabledChoiceShape })
      .meta({ description: "A name switched off, or on again, for one account or the whole environment." }),
    z.object({ kind: z.literal("always-on"), ...alwaysOnChoiceShape }).meta({ description: "A name made always-on, or not, for one account." }),
  ])
  .meta({
    description:
      "A choice made about a skill's name: enabled (on or off for an account, or for the whole environment with a null account, whose choice outranks an account's), or always-on for an account. Keyed by name; a choice for a name not in the set is inert.",
  });
export type SkillChoice = z.infer<typeof SkillChoice>;

/** `skills.enabled-set`: a name switched off or on, for one account or the whole environment. */
export const SkillsEnabledSetPayload = z.object(enabledChoiceShape).meta({
  description:
    "skills.enabled-set: a name switched off, or on again, for one account or, with a null account, the whole environment, whose choice outranks an account's. It replaces the choice held for that name and account.",
});
export type SkillsEnabledSetPayload = z.infer<typeof SkillsEnabledSetPayload>;

/** `skills.always-on-set`: a name made always-on, or not, for one account. */
export const SkillsAlwaysOnSetPayload = z.object(alwaysOnChoiceShape).meta({
  description: "skills.always-on-set: a name made always-on, or not, for one account. It replaces the choice held for that name and account.",
});
export type SkillsAlwaysOnSetPayload = z.infer<typeof SkillsAlwaysOnSetPayload>;

/** The event types of the skills stream. */
export const SKILLS_EVENT_TYPES = {
  "skills.enabled-set": { list: false, payload: SkillsEnabledSetPayload },
  "skills.always-on-set": { list: false, payload: SkillsAlwaysOnSetPayload },
} as const satisfies Record<string, EventTypeEntry>;

export type SkillsEventType = keyof typeof SKILLS_EVENT_TYPES;
export const SkillsEventType = z
  .enum(Object.keys(SKILLS_EVENT_TYPES) as [SkillsEventType, ...SkillsEventType[]])
  .meta({ description: "The event types of the skills stream: skills.enabled-set and skills.always-on-set." });

// The view ---------------------------------------------------------------------------

/**
 * A member as `skills.get` lists it (skills spec, "Choices" and "Wire
 * summary"): as the resolved set lists it, with the choices naming it and
 * what they come to for the view's account. In the set when it has no
 * problem, nothing shadows it and it is on.
 */
export const SkillsViewMember = SkillSetMember.extend({
  enabled: z.boolean().meta({
    description: "Whether its name is on for the view's account: the whole environment's choice, else the account's, else on. Off leaves it out of the set.",
  }),
  alwaysOn: z.boolean().meta({ description: "Whether the view's account made its name always-on. A member switched off is never appended, whatever this says." }),
  choices: z.array(SkillChoice).meta({ description: "Every choice naming its name, for the whole environment or any account." }),
}).meta({
  description:
    "A member as skills.get lists it: the member, what shadows it, whether it is on and always-on for the view's account, and every choice naming it. In the set when it has no problem, nothing shadows it and it is on.",
});
export type SkillsViewMember = z.infer<typeof SkillsViewMember>;

/**
 * An account as `skills.get` lists it (ADR 0030): its adapter's
 * instruction channel, which an always-on skill rides, and, with none, why
 * no always-on skill reaches its runs, so a client dims its always-on
 * switch with the reason.
 */
export const SkillsViewAccount = z
  .object({
    accountId: AccountId,
    channel: InstructionChannelKind.meta({ description: "Its adapter's instruction channel, which an always-on skill rides: none hands its runs no always-on skill." }),
    reason: z.string().min(1).nullable().meta({ description: "Why no always-on skill reaches its runs, for a client to show beside the dimmed switch; null while its adapter has an instruction channel." }),
  })
  .meta({ description: "An account of the environment, with its adapter's instruction channel and, without one, why no always-on skill reaches its runs." });
export type SkillsViewAccount = z.infer<typeof SkillsViewAccount>;

/**
 * What `skills.get` answers (skills spec, "Wire summary"): the own
 * directory's path, the sources, the choices, the accounts with their
 * instruction channels, and the set resolved for one account, every member
 * listed with its layer, whatever shadows it and its choices.
 */
export const SkillsView = z
  .object({
    ownDirectory: z.string().min(1).meta({
      description: "The own directory's absolute path on the environment's machine, holding skills/ and commands/, for a terminal pane or an editor to open.",
    }),
    sources: z.array(SkillSource).meta({ description: "The skill sources the environment tracks, earliest added first." }),
    choices: z.array(SkillChoice).meta({
      description: "Every choice made on the environment, an inert one among them: by name, then enabled before always-on, then the whole environment's before the accounts', by id.",
    }),
    accountId: AccountId.nullable().meta({
      description: "The account the set is resolved for: the session's, else the environment's default account; null when the environment holds none.",
    }),
    accounts: z.array(SkillsViewAccount).meta({ description: "The environment's accounts, in the account list's order, each with whether an always-on skill reaches its runs." }),
    members: z.array(SkillsViewMember).meta({
      description:
        "Every member of every layer, whether in the set, shadowed, switched off or invalid: by name, and within a name by precedence, highest first, so the first valid one is the one that wins; members without a name last, by precedence.",
    }),
  })
  .meta({
    description:
      "The environment's skills as skills.get answers them: the own directory's path, the sources, the choices, the accounts with their instruction channels, and the members of the set resolved for one account, each with its layer, any member that shadows it and its choices.",
  });
export type SkillsView = z.infer<typeof SkillsView>;

/** The `skills.updated` notice's payload: nothing beyond the notice. */
export const SkillsUpdatedPayload = z.object({}).meta({
  description:
    "skills.updated: the skill set changed, by a command that committed or a read that found the own directory changed; a client reads skills.get again.",
});
export type SkillsUpdatedPayload = z.infer<typeof SkillsUpdatedPayload>;

// The probe ------------------------------------------------------------------------

/** A probe's id, which `skills.sources.add` names to reuse its checkout. */
export const SkillProbeId = z.uuidv4().meta({
  description: "A probe's id: a version 4 UUID the environment mints for each skills.probe, naming its checkout while it is kept.",
});
export type SkillProbeId = z.infer<typeof SkillProbeId>;

/** How deep the probe looks for a folder whose children hold `SKILL.md`: the root is level 0 (skills spec, "Skill sources", a chosen default). */
export const SKILL_PROBE_DEPTH = 4;
/** The most directories a probe reads (the Agent Skills client guidance). */
export const SKILL_PROBE_MAX_DIRECTORIES = 2000;
/** The directories a probe never reads (the Agent Skills client guidance). */
export const SKILL_PROBE_SKIPPED = [".git", "node_modules"] as const;
/** How long a probe's checkout is kept for an add to reuse, then removed (a chosen default). */
export const SKILL_PROBE_KEPT_MS = 30 * 60_000;

/** A member as the probe lists it: what the reader reads of it, and where it lies. */
export const SkillProbeMember = SkillMember.pick({ name: true, path: true, description: true, invocation: true, problems: true }).meta({
  description:
    "A member the probe found: its name, its folder from the probed folder (. when the folder is itself the skill), its description, its invocation kind, and its problems, any of which leaves it out of a source.",
});
export type SkillProbeMember = z.infer<typeof SkillProbeMember>;

/**
 * A folder the probe found (skills spec, "Skill sources", the probe; ADR
 * 0029): the root when it holds `SKILL.md` itself, else a folder whose
 * children hold `SKILL.md`, read by the reader's root-skill rule as a
 * source on it would be, with any licence file in it.
 */
export const SkillProbeFolder = z
  .object({
    folder: SkillSourceFolder.meta({ description: "The folder, from the repository's root: what skills.sources.add takes; . for the root." }),
    members: z.array(SkillProbeMember).meta({ description: "Its members as the reader reads them: the folder itself when it holds SKILL.md, else each child folder holding SKILL.md, in name order." }),
    count: z.int().nonnegative().meta({ description: "How many of its members are valid: the skills a source on the folder would yield." }),
    licence: SkillSourceFolder.nullable().meta({
      description: "The licence file in the folder (LICENSE, LICENCE, COPYING or UNLICENSE, any extension, in any case), from the repository's root; null when it holds none.",
    }),
  })
  .meta({
    description:
      "A folder the probe found: the root when it is itself a skill, else a folder whose children hold SKILL.md, with its members as a source on it would read them, the count of valid ones, and any licence file in it.",
  });
export type SkillProbeFolder = z.infer<typeof SkillProbeFolder>;

/**
 * What `skills.probe` answers (skills spec, "Skill sources", the probe; ADR
 * 0029): the probe's id, the repository identity, the branch and commit
 * cloned, the root when it is itself a skill, and every folder up to
 * `SKILL_PROBE_DEPTH` levels down whose children hold `SKILL.md`. A
 * repository with no skill folder answers no root and no folders.
 */
export const SkillsProbeResult = z
  .object({
    probeId: SkillProbeId,
    identity: RepositoryIdentity.meta({ description: "The URL's repository identity, which a source on it is known by with its folder." }),
    branch: SkillSourceBranch.meta({ description: "The branch cloned: the one named, else the remote's default, the one its HEAD names." }),
    commit: GitCommit.meta({ description: "The commit the branch was at when it was cloned." }),
    root: SkillProbeFolder.nullable().meta({ description: "The root, when it holds SKILL.md and so is one skill, named after the repository unless its frontmatter names it; null otherwise." }),
    folders: z.array(SkillProbeFolder).meta({
      description:
        "Every folder up to four levels below the root, the root included, that does not hold SKILL.md itself and whose child folders do, in the order the walk finds them: by depth, then by name; empty when the repository has no skill folder.",
    }),
    truncated: z.boolean().meta({ description: "Whether the probe stopped at 2,000 directories read, so a folder further on may be missing." }),
  })
  .meta({
    description:
      "What skills.probe found in a repository: the probe's id, the identity, the branch and commit cloned, the root when it is itself a skill, and every folder whose children hold SKILL.md, each with its members, their count and any licence file.",
  });
export type SkillsProbeResult = z.infer<typeof SkillsProbeResult>;

/**
 * Why a probe could not reach the repository, `conflict` reason
 * `unreachable`'s `data.problem`: the forge refused the credential or asked
 * for one no forge account gives (`authentication`), there is no such
 * repository or branch (`not_found`), the host could not be reached in time
 * (`network`), or git failed otherwise (`git_failed`, with its `fatal:` line).
 */
export const SKILL_PROBE_PROBLEMS = ["authentication", "not_found", "network", "git_failed"] as const;
export const SkillProbeProblem = z.enum(SKILL_PROBE_PROBLEMS).meta({
  description:
    "Why skills.probe could not reach the repository: authentication (the forge refused the credential, or asked for one no forge account gives), not_found (no such repository or branch), network (the host could not be reached in time), git_failed (git failed otherwise; data.line holds its fatal: line).",
});
export type SkillProbeProblem = z.infer<typeof SkillProbeProblem>;

/** `conflict`'s data when a probe could not reach the repository. */
export const SkillProbeUnreachable = z
  .object({
    reason: z.literal("unreachable"),
    problem: SkillProbeProblem,
    line: z.string().min(1).meta({ description: "What git said, its fatal: line where it wrote one, scrubbed of every secret." }),
    origin: ForgeOrigin.meta({ description: "The URL's forge origin (an ssh URL's is https on its host): where a forge account would authenticate the probe." }),
  })
  .meta({ description: "The data of skills.probe's conflict, reason unreachable: the problem, what git said, and the origin." });
export type SkillProbeUnreachable = z.infer<typeof SkillProbeUnreachable>;

// Carry over ------------------------------------------------------------------------

/**
 * An original Carry over copied into the own directory, or kept out of it
 * (skills spec, "The own directory and Carry over"; ADR 0021): what it is,
 * its name, where it was found, and its path in the own directory.
 */
export const SkillCarriedItem = z
  .object({
    kind: SkillMemberKind,
    name: SkillName,
    from: AbsolutePath.meta({ description: "Where the original lies: a folder or command file in the adopted directory's skills/ or commands/, or in the machine's ~/.agents/skills." }),
    path: SkillMember.shape.path.meta({
      description: "Its path in the own directory: where it was copied to, skills/<folder> or commands/<file>; for one kept, the path of what the own directory already holds under its name.",
    }),
  })
  .meta({ description: "An original skill folder or command file Carry over copied into the own directory, or kept out of it because the own directory already holds its name." });
export type SkillCarriedItem = z.infer<typeof SkillCarriedItem>;

/**
 * A skill folder Carry over offers as a source rather than copying: it
 * resolves into a git working tree with a remote. The URL, folder and
 * follow are what `skills.sources.add` takes.
 */
export const SkillCarryOverOffer = z
  .object({
    name: SkillName,
    from: AbsolutePath.meta({ description: "Where the skill folder was found: in the adopted directory's skills/, or in the machine's ~/.agents/skills." }),
    url: SkillSourceUrl.meta({ description: "The working tree's remote, as git expands it, stripped of any credential." }),
    folder: SkillSourceFolder.meta({ description: "The skill folder's path in the repository, from its root; . when the folder is the repository's root." }),
    follow: SkillSourceFollow.meta({ description: "The branch the working tree is on (its upstream's on the remote, else the local one), or a pin at its commit when HEAD is detached." }),
  })
  .meta({ description: "A skill folder inside a git working tree with a remote, offered as a skill source instead of copied: the URL, folder and follow skills.sources.add takes." });
export type SkillCarryOverOffer = z.infer<typeof SkillCarryOverOffer>;

/** An original Carry over leaves where it is because it reads as invalid. */
export const SkillCarryOverInvalid = z
  .object({
    kind: SkillMemberKind,
    name: SkillName.nullable().meta({ description: "Its name by the member-naming rule; null when none passes, a name problem saying why." }),
    from: AbsolutePath.meta({ description: "Where the original lies." }),
    problems: z.array(SkillMemberProblem).min(1).meta({ description: "What leaves it invalid, as the own directory's reader would list it." }),
  })
  .meta({ description: "An original skill folder or command file that reads as invalid, with its problems: neither copied nor offered." });
export type SkillCarryOverInvalid = z.infer<typeof SkillCarryOverInvalid>;

/** What Carry over lists as not carried: the adopted directory's subagents and plugins. */
export const SKILL_NOT_CARRIED_KINDS = ["subagent", "plugin"] as const;
export const SkillNotCarried = z
  .object({
    kind: z.enum(SKILL_NOT_CARRIED_KINDS).meta({ description: "What it is: subagent, a Markdown file in the adopted directory's agents/; plugin, an installed plugin its plugins/ lists." }),
    name: z.string().min(1).meta({ description: "Its name: a subagent's file name without .md; a plugin's as its installed list names it, name@marketplace." }),
  })
  .meta({ description: "A subagent or plugin in the adopted directory, which Carry over does not carry." });
export type SkillNotCarried = z.infer<typeof SkillNotCarried>;

/**
 * What `skills.carryOver` answers (skills spec, "The own directory and
 * Carry over"; ADR 0021): each original skill folder and command file of
 * the adopted directory and the machine's `~/.agents/skills`, as copied,
 * kept, offered or invalid, each list's length its count, and the
 * subagents and plugins not carried. A dry run answers the same, having
 * written nothing.
 */
export const SkillsCarryOverReport = z
  .object({
    accountId: AccountId,
    dryRun: z.boolean().meta({ description: "Whether it was a dry run: the report of what a run would do, with nothing written." }),
    copied: z.array(SkillCarriedItem).meta({ description: "The originals copied into the own directory (in a dry run, those that would be); its length is the count." }),
    kept: z.array(SkillCarriedItem).meta({ description: "The valid originals not copied because the own directory already holds their name; its length is the count." }),
    offered: z.array(SkillCarryOverOffer).meta({ description: "The skill folders inside a git working tree with a remote, offered as sources and not copied; its length is the count." }),
    invalid: z.array(SkillCarryOverInvalid).meta({ description: "The originals that read as invalid, with their problems, left where they are; its length is the count." }),
    notCarried: z.array(SkillNotCarried).meta({ description: "The adopted directory's subagents and plugins, which are not carried." }),
  })
  .meta({
    description:
      "What Carry over's skills half did, or in a dry run would do: the originals copied into the own directory, kept out of it, offered as sources and invalid, and the subagents and plugins not carried.",
  });
export type SkillsCarryOverReport = z.infer<typeof SkillsCarryOverReport>;

// A run's skill set ------------------------------------------------------------------

/**
 * The plugin a generation is (skills spec, "Materialisation and the Claude
 * mapping"): its manifest names it after the product (the placeholder, ADR
 * 0017), and a provider that namespaces a plugin's skills invokes a linked
 * member under it (Claude: `/agent-harness:<name>`).
 */
export const SKILL_PLUGIN_NAME = PRODUCT_NAME;

/** A skill set's fingerprint: what a generation is keyed by, and what a kept provider process is spawned under. */
export const SkillSetFingerprint = z.string().min(1).meta({
  description:
    "A skill set's fingerprint: it covers the members' names, folders, origins and snapshot commits, whether each is native and always-on, and the hidden native names, so two sets with one fingerprint hold the same; a provider process spawned under another is not reused.",
});
export type SkillSetFingerprint = z.infer<typeof SkillSetFingerprint>;

/**
 * A member of a run's skill set as its adapter is handed it (skills spec,
 * "Contract changes"): its name, origin, invocation, whether it is native,
 * lying in a root the adapter loads itself under trust and so left out of
 * the generation, and whether the run's account made it always-on, which
 * the composer's always-on layer appends (#507).
 */
export const RunSkillSetMember = z
  .object({
    name: SkillName,
    origin: SkillOrigin.nullable().meta({ description: "Where it comes from; null for a member of the own directory with no provenance manifest, or of a repository with no identity." }),
    invocation: SkillInvocation,
    native: z.boolean().meta({
      description: "Whether it lies in a root the account's adapter loads itself under trust (Claude: a trusted repository's .claude/skills and its commands), and so is not in the generation.",
    }),
    alwaysOn: z.boolean().meta({ description: "Whether the run's account made it always-on, so its body rides the run's standing instructions." }),
  })
  .meta({
    description: "A member of a run's skill set as its adapter is handed it: its name, its origin, its invocation, whether the provider loads it itself, and whether it is always-on for the run's account.",
  });
export type RunSkillSetMember = z.infer<typeof RunSkillSetMember>;

/**
 * A run's skill set, resolved at its start and at each commands listing
 * (skills spec, "Materialisation and the Claude mapping"; ADR 0009): the
 * generation the adapter maps (Claude: its one local plugin), the set's
 * fingerprint, every member in the set, and the native names it hides,
 * each a native member switched off, which the adapter hides its own way
 * (Claude: `skillOverrides` `off`). Never on the wire: it crosses the
 * adapter contract.
 */
export const RunSkillSet = z
  .object({
    generation: AbsolutePath.nullable().meta({
      description: "The generation's directory: a plugin holding a link to every member that is not native. Null when there is nothing to link.",
    }),
    fingerprint: SkillSetFingerprint.nullable().meta({ description: "The set's fingerprint; null while none is resolved for the run." }),
    members: z.array(RunSkillSetMember).meta({ description: "Every member in the set, native ones included; a shadowed, disabled or invalid member is not one." }),
    hiddenNativeNames: z.array(SkillName).meta({ description: "The names of the native members switched off, which the adapter hides from its provider." }),
  })
  .meta({
    description:
      "A run's skill set as its adapter is handed it: the generation to map, the fingerprint, every member with its name, origin, invocation and whether it is native, and the native names to hide.",
  });
export type RunSkillSet = z.infer<typeof RunSkillSet>;

/** The skill set a run is handed while nothing resolves one: no generation, no fingerprint, no member and nothing hidden. */
export const EMPTY_RUN_SKILL_SET: RunSkillSet = { generation: null, fingerprint: null, members: [], hiddenNativeNames: [] };
