import { z } from "zod";
import { AccountId } from "../accounts.js";
import { commandParams, defineMethod } from "../method.js";
import { SessionId } from "../sessions.js";
import { SkillName } from "../skill-rules.js";
import { SkillMember, SkillsCarryOverReport, SkillsView } from "../skills.js";

/**
 * The skill set's methods this far (skills spec, "The own directory and
 * Carry over" and "Wire summary"; ADR 0009, ADR 0018, ADR 0021, ADR 0029):
 * the read of the environment's skills, the own directory's create and
 * remove, and Carry over's skills half.
 * The own directory is read at each run's start and on `skills.get`, never
 * watched; a read that finds it changed, and each command that changes it,
 * raises `skills.updated` on `environment.subscribe`.
 */

/**
 * The environment's skills: the own directory's path, the sources, the
 * choices, and the set for a session's account and repository, or, without
 * a session, the default account's, each member with its layer and any
 * member that shadows it. Reads the own directory. A session the
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
 * with a remote is offered as a source, not copied. Every other valid skill
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
 * (reason `not_adopted`). A prepared command: the reads and the copies come
 * first, outside the transaction, and are undone when it is not accepted.
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
