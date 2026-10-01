import { join } from "node:path";
import type { SkillSetMember } from "@agent-harness/contracts";
import type { SkillSetScope, SkillSetSeam } from "../adapter/seams.js";
import type { EventLog } from "../event-log/event-log.js";
import { choicesFor, readSkillChoices } from "./choices.js";
import type { Generations, PlacedMember, PlacedSet } from "./generations.js";
import type { OwnDirectory } from "./own-directory.js";
import { resolveSkillSet } from "./precedence.js";
import { isNativeMember, readRepositorySkills, repositorySkillTarget } from "./repository.js";
import type { SkillSources } from "./sources.js";

/**
 * The run's skill set, resolved at each run's start and each commands
 * listing (skills spec, "Materialisation and the Claude mapping"; ADR
 * 0009): what fills the host's skill-set seam. It reads the layers, the
 * own directory's read raising `skills.updated` when it finds it changed,
 * resolves them by precedence, leaves out each name the choices switch off
 * for the account (#501), marks each the account made always-on, places
 * each member in the set where its files lie, and has the materialiser give
 * the set its fingerprint and generation, current for the scope it was
 * resolved for (the account, the workspace and the trust). The own and
 * trusted repository layers are linked live; sources point into their
 * immutable snapshots. Members in the adapter's native roots are listed
 * without links, and their names hidden when switched off or shadowed by a linked member.
 */

export interface RunSkillSetsOptions {
  readonly own: Pick<OwnDirectory, "path" | "read">;
  readonly sources: Pick<SkillSources, "read">;
  /** The log the choices are read from. */
  readonly log: Pick<EventLog, "read">;
  readonly generations: Pick<Generations, "materialise">;
}

/** Whether a resolved member is in the set: valid, so named and described, and shadowed by none. */
const inTheSet = (member: SkillSetMember): member is SkillSetMember & { readonly name: string; readonly description: string } =>
  member.name !== null && member.description !== null && member.problems.length === 0 && member.shadowedBy === null;

/** What a set is current for: the account, the workspace and the trust it was resolved under. */
const scopeKey = (scope: SkillSetScope): string => JSON.stringify([scope.accountId, scope.workspace.path, scope.trust.key, scope.trust.decision]);

/**
 * The set resolved for `scope`, placed: each member in it with where its
 * files lie, before the materialiser gives it a fingerprint and a
 * generation. What the seam materialises, and what readiness checks
 * (`readiness.ts`) without making a generation.
 */
export const placeSkillSet =
  (options: Pick<RunSkillSetsOptions, "own" | "sources" | "log">) =>
  async (scope: SkillSetScope): Promise<PlacedSet> => {
    const { own } = options;
    const choices = choicesFor(readSkillChoices(options.log), scope.accountId);
    const [ownMembers, sources, repository] = await Promise.all([own.read(), options.sources.read(), readRepositorySkills(scope)]);
    const members = resolveSkillSet([...repository, ...ownMembers, ...sources.members], sources.sources)
      .filter(inTheSet)
      .filter((member) => choices.enabled(member.name));
    // Own and repository members are linked live; a source points into its current snapshot.
    const placed = members.map((member): PlacedMember => {
      const { target, commit } = member.layer.kind === "source" ? sources.place(member) : { target: member.layer.kind === "repository" ? repositorySkillTarget(scope.workspace, member) : join(own.path, ...member.path.split("/")), commit: null };
      return {
        name: member.name,
        description: member.description,
        kind: member.kind,
        target,
        origin: member.origin,
        commit,
        invocation: member.invocation,
        userInvocable: member.userInvocable,
        argumentHint: member.argumentHint,
        native: isNativeMember(scope, member),
        alwaysOn: choices.alwaysOn(member.name),
      };
    });
    const linkedNames = new Set(placed.filter((member) => !member.native).map((member) => member.name));
    const hiddenNativeNames = [...new Set(repository.flatMap((member) =>
      member.name !== null && isNativeMember(scope, member) && (!choices.enabled(member.name) || linkedNames.has(member.name)) ? [member.name] : [],
    ))].sort();
    return { members: placed, hiddenNativeNames };
  };

export const runSkillSets = (options: RunSkillSetsOptions): SkillSetSeam => {
  const place = placeSkillSet(options);
  return async (scope) => {
    const set = await place(scope);
    const { fingerprint, generation } = await options.generations.materialise(set, scopeKey(scope));
    return {
      generation,
      fingerprint,
      members: set.members.map(({ name, description, origin, invocation, userInvocable, argumentHint, native, alwaysOn }) => ({
        name,
        description,
        origin,
        invocation,
        userInvocable,
        argumentHint,
        native,
        alwaysOn,
      })),
      hiddenNativeNames: [...set.hiddenNativeNames],
    };
  };
};
