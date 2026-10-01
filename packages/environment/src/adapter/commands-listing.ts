import type { CommandsListEntry, RunSkillSet, RunSkillSetMember } from "@agent-harness/contracts";
import type { Adapter, ProviderCommand } from "./contract.js";

/**
 * What `commands.list` answers for a session (skills spec, "Materialisation
 * and the Claude mapping"; ADR 0009; #503), from the skill set its next run
 * would have and the provider's listing made under it: a skill entry for
 * each member a person may invoke, by name, then a command entry for each
 * command the provider offers of its own, in its order. The provider lists
 * each member too, by the text that invokes it (Claude:
 * `agent-harness:<name>`, or `<name>` for a native member), and that entry
 * is folded into the member's skill entry, so no skill is listed twice. A
 * built-in is never a member's listing, so one that shares a member's name
 * stays a command entry: `/<name>` is the built-in's (skills spec, "Slash
 * resolution").
 */
export const commandsListing = (
  skillSet: RunSkillSet,
  provided: readonly ProviderCommand[],
  invocationText: Adapter["invocationText"],
): CommandsListEntry[] => {
  const members = new Set(skillSet.members.map((member) => invocationText(member)));
  const skills = skillSet.members
    .filter((member) => member.userInvocable)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(skillEntry);
  const commands = provided
    .filter((command) => command.builtin || !members.has(`/${command.name}`))
    .map(({ name, description, builtin }): CommandsListEntry => ({ kind: "command", name, description, builtin }));
  return [...skills, ...commands];
};

const skillEntry = ({ name, description, invocation, origin, alwaysOn, argumentHint }: RunSkillSetMember): CommandsListEntry => ({
  kind: "skill",
  name,
  description,
  invocation,
  origin,
  alwaysOn,
  argumentHint,
});
