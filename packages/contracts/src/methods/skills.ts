import { z } from "zod";
import { commandParams, defineMethod } from "../method.js";
import { SessionId } from "../sessions.js";
import { SkillName } from "../skill-rules.js";
import { SkillMember, SkillsView } from "../skills.js";

/**
 * The skill set's methods this far (skills spec, "The own directory and
 * Carry over" and "Wire summary"; ADR 0009, ADR 0018, ADR 0029): the read
 * of the environment's skills, and the own directory's create and remove.
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
 * directory does not hold is `not_found` (data `kind: skill`).
 */
export const skillsOwnRemove = defineMethod({
  name: "skills.own.remove",
  scope: "admin",
  kind: "command",
  params: commandParams({ name: SkillName }),
  result: z.object({ member: SkillMember.meta({ description: "The member moved to the trash, as it was read before." }) }),
  errors: [],
});
