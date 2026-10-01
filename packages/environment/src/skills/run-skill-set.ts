import { join } from "node:path";
import type { SkillSetMember } from "@agent-harness/contracts";
import type { SkillSetScope, SkillSetSeam } from "../adapter/seams.js";
import type { EventLog } from "../event-log/event-log.js";
import { choicesFor, readSkillChoices } from "./choices.js";
import type { Generations, PlacedMember, PlacedSet } from "./generations.js";
import type { OwnDirectory } from "./own-directory.js";
import { resolveSkillSet } from "./precedence.js";
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
 * resolved for (the account, the workspace and the trust). Its layers so
 * far are the own directory, whose members are linked live, and the
 * sources, whose members are linked into their current snapshots (#498); a
 * trusted repository's members, which may be native and are then hidden
 * when switched off (#502), join as they land.
 */

export interface RunSkillSetsOptions {
  readonly own: Pick<OwnDirectory, "path" | "read">;
  readonly sources: Pick<SkillSources, "read">;
  /** The log the choices are read from. */
  readonly log: Pick<EventLog, "read">;
  readonly generations: Pick<Generations, "materialise">;
}

/** Whether a resolved member is in the set: valid, and shadowed by none. */
const inTheSet = (member: SkillSetMember): member is SkillSetMember & { readonly name: string } =>
  member.name !== null && member.problems.length === 0 && member.shadowedBy === null;

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
    const [ownMembers, sources] = await Promise.all([own.read(), options.sources.read()]);
    const members = resolveSkillSet([...ownMembers, ...sources.members], sources.sources)
      .filter(inTheSet)
      .filter((member) => choices.enabled(member.name));
    // An own directory's member is linked live, from its folder or command file there; a source's into its current snapshot.
    const placed = members.map((member): PlacedMember => {
      const { target, commit } = member.layer.kind === "source" ? sources.place(member) : { target: join(own.path, ...member.path.split("/")), commit: null };
      return {
        name: member.name,
        kind: member.kind,
        target,
        origin: member.origin,
        commit,
        invocation: member.invocation,
        native: false,
        alwaysOn: choices.alwaysOn(member.name),
      };
    });
    return { members: placed, hiddenNativeNames: [] };
  };

export const runSkillSets = (options: RunSkillSetsOptions): SkillSetSeam => {
  const place = placeSkillSet(options);
  return async (scope) => {
    const set = await place(scope);
    const { fingerprint, generation } = await options.generations.materialise(set, scopeKey(scope));
    return {
      generation,
      fingerprint,
      members: set.members.map(({ name, origin, invocation, native, alwaysOn }) => ({ name, origin, invocation, native, alwaysOn })),
      hiddenNativeNames: [...set.hiddenNativeNames],
    };
  };
};
