import { z } from "zod";
import { AccountId } from "../accounts.js";
import { commandParams, defineMethod } from "../method.js";
import { SkillReadiness } from "../readiness.js";
import { SessionId, Workspace } from "../sessions.js";
import { SkillName, SkillSourceFolder, SkillSourceUrl } from "../skill-rules.js";
import {
  SkillChoice,
  SkillMember,
  SkillProbeId,
  SkillSourceBranch,
  SkillSourceFollow,
  SkillSourceId,
  SkillsAlwaysOnSetPayload,
  SkillsCarryOverReport,
  SkillsEnabledSetPayload,
  SkillsProbeResult,
  SkillsView,
  SkillsViewSource,
} from "../skills.js";

/**
 * The skill set's methods this far (skills spec, "The own directory and
 * Carry over", "Choices" and "Wire summary"; ADR 0009, ADR 0018, ADR 0021,
 * ADR 0029): the read of the environment's skills, the own directory's
 * create and remove, Carry over's skills half, and the choices that switch
 * a name off and make it always-on. The own directory is read at each
 * run's start and on `skills.get`, never watched; a read that finds it
 * changed, and each command that changes it or a choice, raises
 * `skills.updated` on `environment.subscribe`.
 */

/**
 * The environment's skills: the own directory's path, the sources, the
 * choices, the accounts with whether an always-on skill reaches their
 * runs, and the set for a session's account and repository, or, without a
 * session, the default account's, each member with its layer, any member
 * that shadows it, and its choices. Reads the own directory. A session the
 * environment does not hold, or a deleted one, is `not_found` (data `kind:
 * session`).
 */
export const skillsGet = defineMethod({
  name: "skills.get",
  scope: "read",
  kind: "query",
  params: z.object({
    sessionId: SessionId.optional().meta({ description: "The session whose account and repository the set is resolved for; the environment's default account when absent." }),
  }),
  result: SkillsView,
  errors: [],
});

/** A description `skills.own.create` writes: 1 to 1,024 characters, not all white space (the Agent Skills bound). */
const OwnSkillDescription = z
  .string()
  .min(1)
  .max(1024)
  .regex(/\S/)
  .meta({ description: "The skill's description: 1 to 1,024 characters, not all white space; the model reads it to choose the skill." });

/**
 * Writes a skill folder named `name` into the own directory's `skills/`,
 * holding a minimal `SKILL.md` with the name and description in its
 * frontmatter, and answers the member as read. A name failing the
 * skill-name rule is `invalid_params`; a name the own directory already
 * holds, as a folder, a command file or a member's name, is `conflict`
 * (reason `exists`), and so is an own directory whose `skills/` holds a
 * `SKILL.md` itself, which makes it one skill whose folders are not read
 * (reason `root_skill`); nothing is written then.
 */
export const skillsOwnCreate = defineMethod({
  name: "skills.own.create",
  scope: "admin",
  kind: "command",
  params: commandParams({ name: SkillName, description: OwnSkillDescription }),
  result: z.object({ member: SkillMember.meta({ description: "The new member, as the own directory's read gives it." }) }),
  errors: [],
});

/**
 * Moves the own directory's member named `name` that wins there (a skill
 * folder over a command file), else the member whose folder or command
 * file is named `name`, to the data directory's trash, which deletes it
 * once thirty days old, and answers the member as it was. A name the own
 * directory does not hold is `not_found` (data `kind: skill`); `skills/`
 * itself, while a `SKILL.md` of its own makes it one skill, is `conflict`
 * (reason `root_skill`), since trashing it would take every folder in it.
 */
export const skillsOwnRemove = defineMethod({
  name: "skills.own.remove",
  scope: "admin",
  kind: "command",
  params: commandParams({ name: SkillName }),
  result: z.object({ member: SkillMember.meta({ description: "The member moved to the trash, as it was read before." }) }),
  errors: [],
});

/**
 * Carry over's skills half (ADR 0021): reads the adopted account
 * directory's `skills/` and `commands/`, and the machine's
 * `~/.agents/skills`. A skill folder that resolves into a git working tree
 * with a remote is offered as a source, not copied, once for each folder
 * it resolves to. Every other valid skill
 * folder and command file is copied into the own directory, dereferencing
 * links, unless the own directory already holds its name (a member's, or
 * the folder or file it would be copied to), when it is kept and reported.
 * An invalid one is reported with its problems and left. A provenance
 * manifest beside the originals has the copied folders' entries merged
 * into the own directory's. The report lists the subagents and plugins,
 * which are not carried; `skills.updated` follows a run that copied.
 * `dryRun` answers the same report and writes nothing. Nothing in the
 * adopted directory or `~/.agents/skills` is created, linked or deleted.
 * An account the environment does not hold is `not_found` (data `kind:
 * account`); one whose directory it owns rather than adopted is `conflict`
 * (reason `not_adopted`); an own directory whose `skills/` holds a
 * `SKILL.md` itself, which makes it one skill whose folders are not read,
 * is `conflict` (reason `root_skill`), dry run or not. A prepared command:
 * the reads and the copies come first, outside the transaction, and are
 * undone when it is not accepted.
 */
export const skillsCarryOver = defineMethod({
  name: "skills.carryOver",
  scope: "admin",
  kind: "command",
  params: commandParams({
    accountId: AccountId.meta({ description: "The adopted account whose directory's skills and commands to carry over." }),
    dryRun: z.boolean().meta({ description: "Answer the report of what a run would do, and write nothing." }),
  }),
  result: SkillsCarryOverReport,
  errors: [],
});

/** What a choice's command answers: the choice as the environment holds it now. */
const choiceResult = z.object({ choice: SkillChoice.meta({ description: "The choice as the environment holds it now." }) });

/**
 * Makes a name always-on, or not, for one account: `skills.always-on-set`
 * on the skills stream, then `skills.updated`. Nothing is always-on until
 * this is sent. A name failing the skill-name rule is `invalid_params`; an
 * account the environment does not hold is `not_found` (data `kind:
 * account`). A choice the environment already holds appends nothing.
 */
export const skillsSetAlwaysOn = defineMethod({
  name: "skills.setAlwaysOn",
  scope: "admin",
  kind: "command",
  params: commandParams(SkillsAlwaysOnSetPayload.shape),
  result: choiceResult,
  errors: [],
});

/**
 * Switches a name off, or on again, for one account or, with a null
 * account, the whole environment, whose choice outranks an account's:
 * `skills.enabled-set` on the skills stream, then `skills.updated`. Keyed
 * by name, it applies to every layer holding the name, and to a name no
 * layer holds once one does. A name failing the skill-name rule is
 * `invalid_params`; an account the environment does not hold is
 * `not_found` (data `kind: account`). A choice the environment already
 * holds appends nothing.
 */
export const skillsSetEnabled = defineMethod({
  name: "skills.setEnabled",
  scope: "admin",
  kind: "command",
  params: commandParams(SkillsEnabledSetPayload.shape),
  result: choiceResult,
  errors: [],
});

/**
 * Probes a repository for its skill folders (skills spec, "Skill sources",
 * the probe; ADR 0029), so a person adding a source ticks folders the
 * environment found rather than guessing one. The environment shallow-clones
 * `branch`, else the remote's default, through the ForgeService's git, which
 * never prompts: the forge account for the URL's origin authenticates it,
 * an origin with none is read anonymously, and an ssh URL on a host no forge
 * account covers is read over ssh with the user's own keys. It answers the
 * probe's id, the identity, the branch and commit, the root when it holds
 * `SKILL.md`, and every folder up to four levels down whose children hold
 * `SKILL.md`, each with its members, their count and any licence file; at
 * most 2,000 directories are read, `.git` and `node_modules` skipped, and no
 * link leading out of the checkout is followed. A URL failing the source
 * URL rule is `invalid_params`. A repository it cannot reach is `conflict`,
 * reason `unreachable` (`SkillProbeUnreachable`: the problem
 * `authentication`, `not_found`, `network`, `git_missing` or `git_failed`, what git said,
 * and the origin). The checkout lies under the data directory and is kept
 * thirty minutes for `skills.sources.add` to reuse by the probe's id, then
 * removed.
 */
export const skillsProbe = defineMethod({
  name: "skills.probe",
  scope: "admin",
  kind: "query",
  params: z.object({
    url: SkillSourceUrl,
    branch: SkillSourceBranch.optional().meta({ description: "The branch to probe; the remote's default, the one its HEAD names, when absent." }),
  }),
  result: SkillsProbeResult,
  errors: [],
});

/**
 * Tracks a repository's folder as a skill source (skills spec, "Skill
 * sources"; ADR 0029): a prepared command whose fetch runs first. It reuses
 * the checkout of the live probe `probeId` names when that probe read the
 * same repository at what the source follows, else fetches through the
 * ForgeService's git as the probe does, then reads the folder at the commit
 * by the root-skill rule. A folder yielding no valid member is refused
 * `conflict`, reason `no_skills`, with the folders that would; otherwise the
 * folder (with any provenance manifest beside it or one level up) is
 * exported at the commit into the source's snapshot, an immutable,
 * read-only copy under the data directory, and `skills.source-added` and
 * `skills.source-synced` are appended on the skills stream, then
 * `skills.updated`. The source joins every account's set below the own
 * directory, after the sources added before it, from each run's next start.
 * A URL or folder failing its rule is `invalid_params`; a repository it
 * cannot reach is `conflict`, reason `unreachable`, as the probe's; a
 * twenty-first source is `conflict`, reason `source_limit`; a second source
 * with the same identity and folder is `conflict`, reason `duplicate`
 * (`SkillSourceAddConflict`). The same identity with another folder is
 * another source.
 */
export const skillsSourcesAdd = defineMethod({
  name: "skills.sources.add",
  scope: "admin",
  kind: "command",
  params: commandParams({
    url: SkillSourceUrl,
    folder: SkillSourceFolder,
    follow: SkillSourceFollow,
    probeId: SkillProbeId.optional().meta({ description: "The probe whose checkout to reuse while it is kept; the source is fetched afresh when it is absent or expired, or read another repository, or another branch or commit than the source follows." }),
  }),
  result: z.object({ source: SkillsViewSource.meta({ description: "The source as skills.get lists it now." }) }),
  errors: [],
});

/**
 * Stops tracking a source: `skills.source-removed` on the skills stream,
 * then `skills.updated`. Its members leave every account's set from each
 * run's next start; a run already live keeps the snapshot it began with.
 * A source the environment does not track is `not_found` (data `kind:
 * source`).
 */
export const skillsSourcesRemove = defineMethod({
  name: "skills.sources.remove",
  scope: "admin",
  kind: "command",
  params: commandParams({ sourceId: SkillSourceId }),
  result: z.object({ source: SkillsViewSource.meta({ description: "The source as skills.get listed it before." }) }),
  errors: [],
});

/**
 * Pull now (skills spec, "Skill sources"; ADR 0029): a prepared command
 * that syncs the source at once, or joins the sync of it already under way,
 * and answers the source as that sync left it. A sync is a depth-one fetch
 * of the branch the source follows within sixty seconds, then the folder
 * exported at that commit into a new snapshot, now current. Its outcome is
 * the source's `sync`: `ok`; `failed` with the probe's problem; or
 * `layout_moved` when the folder yields no valid member, with the folders
 * that would. Failed and layout_moved keep the last good snapshot current.
 * The sync is the environment's: it appends `skills.source-synced` and
 * `skills.updated` itself, and only when the commit, the members or the
 * outcome change; the command appends nothing of its own. A source the
 * environment does not track, or one removed while it synced, is
 * `not_found` (data `kind: source`); a pinned source never syncs and is
 * `conflict`, reason `pinned` (`SkillSourcePullConflict`).
 */
export const skillsSourcesPull = defineMethod({
  name: "skills.sources.pull",
  scope: "admin",
  kind: "command",
  params: commandParams({ sourceId: SkillSourceId }),
  result: z.object({ source: SkillsViewSource.meta({ description: "The source as the sync left it: its commit, skill count, what the sync came to, and when it ended." }) }),
  errors: [],
});

/**
 * Pins a source, or unpins it (skills spec, "Pin and remove"; ADR 0029): a
 * prepared command. A pin at the source's current commit is recorded as it
 * is; a pin at another commit fetches it first, exports the folder at it
 * into a snapshot, now current, and appends `skills.source-synced` with
 * it. Following a branch again appends `skills.source-follow-set` and the
 * source syncs at once, as the environment, after the command. A pinned
 * source never syncs. `skills.source-follow-set` and `skills.updated` are
 * appended unless the source already follows that. A source the
 * environment does not track is `not_found` (data `kind: source`); a commit
 * that cannot be fetched is `conflict`, reason `unreachable`, as the
 * probe's, and one at which the folder yields no valid member is
 * `conflict`, reason `no_skills`, with the folders that would
 * (`SkillSourceFollowConflict`).
 */
export const skillsSourcesSetFollow = defineMethod({
  name: "skills.sources.setFollow",
  scope: "admin",
  kind: "command",
  params: commandParams({
    sourceId: SkillSourceId,
    follow: SkillSourceFollow.meta({ description: "What the source follows from now: a commit to pin it at (its current one, or another, which is fetched), or a branch (null for the remote's default) to sync from." }),
  }),
  result: z.object({ source: SkillsViewSource.meta({ description: "The source as skills.get lists it now; one unpinned has not synced yet." }) }),
  errors: [],
});

/**
 * `skills.readiness`: a session, or an account and a workspace, never
 * both, with the names to answer and whether to read again. The
 * refinement is zod's half; the `oneOf` the export's.
 */
const ReadinessParams = z
  .object({
    sessionId: SessionId.optional().meta({ description: "The session whose next run's set and workspace to check; leave out accountId and workspace." }),
    accountId: AccountId.optional().meta({ description: "With workspace and no sessionId: the account of a new session whose set to check." }),
    workspace: Workspace.optional().meta({ description: "With accountId and no sessionId: the workspace of a new session, where the checks run." }),
    names: z.array(SkillName).optional().meta({ description: "The members to answer; every member of the set when absent. A name not in the set is left out." }),
    refresh: z.boolean().optional().meta({ description: "Check again rather than answer what was checked in the last sixty seconds." }),
  })
  .refine((target) => (target.sessionId === undefined ? target.accountId !== undefined && target.workspace !== undefined : target.accountId === undefined && target.workspace === undefined), {
    message: "Name a session, or an account and a workspace, not both.",
  })
  .meta({
    description: "A session, whose next run's set is checked in its workspace; or an account and a workspace, where a new session's first run would be; with the names to answer and whether to check again.",
    oneOf: [
      { required: ["sessionId"], properties: { sessionId: true, accountId: false, workspace: false } },
      { required: ["accountId", "workspace"], properties: { sessionId: false, accountId: true, workspace: true } },
    ],
  });

/**
 * Each member's readiness (skills spec, "Readiness"; ADR 0009): the set a
 * session's next run would have, or a new session's of the account and
 * workspace, each member checked against its sidecar, else the overlay's
 * declaration for its origin, in the workspace (paths from the repository's
 * root, else the workspace). Each check gets five seconds and the call ten;
 * one that runs out fails as could not be checked in time. Answers are kept
 * sixty seconds per workspace, account and set fingerprint, unless
 * `refresh`. Advisory: it never blocks an invocation or changes the set. A
 * session the environment does not hold, or a deleted one, is `not_found`
 * (kind `session`); an account it does not hold, `not_found` (kind
 * `account`).
 */
export const skillsReadiness = defineMethod({
  name: "skills.readiness",
  scope: "read",
  kind: "query",
  params: ReadinessParams,
  result: z.object({
    skills: z.array(SkillReadiness).meta({ description: "Each member asked for that is in the set, in the set's order." }),
  }),
  errors: [],
});
