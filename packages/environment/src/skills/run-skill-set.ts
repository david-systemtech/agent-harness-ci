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

/** Whether a resolved member is in the set: valid, so named and described, and shadowed by none. */
const inTheSet = (member: SkillSetMember): member is SkillSetMember & { readonly name: string; readonly description: string } =>
  member.name !== null && member.description !== null && member.problems.length === 0 && member.shadowedBy === null;

/** What a set is current for: the account, the workspace and the trust it was resolved under. */
const scopeKey = (scope: SkillSetScope): string => JSON.stringify([scope.accountId, scope.workspace.path, scope.trust.key, scope.trust.decision]);

/**
 * The members in the set for `accountId` by precedence, each its choices
 * leave on (null: the environment's choices alone), with the sources read
 * for them and the choices.
 */
const membersFor = async (options: Pick<RunSkillSetsOptions, "own" | "sources" | "log">, accountId: string | null) => {
  const choices = choicesFor(readSkillChoices(options.log), accountId);
  const [ownMembers, sources] = await Promise.all([options.own.read(), options.sources.read()]);
  const members = resolveSkillSet([...ownMembers, ...sources.members], sources.sources)
    .filter(inTheSet)
    .filter((member) => choices.enabled(member.name));
  return { members, sources, choices };
};

/**
 * The names in the skill set of `accountId` (null: before any account's
 * choices), as a run on it resolves them, with no generation made: what a
 * routine's skills are checked against (#531).
 */
export const skillSetNames =
  (options: Pick<RunSkillSetsOptions, "own" | "sources" | "log">) =>
  async (accountId: string | null): Promise<ReadonlySet<string>> =>
    new Set((await membersFor(options, accountId)).members.map((member) => member.name));

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
    const { members, sources, choices } = await membersFor(options, scope.accountId);
    // An own directory's member is linked live, from its folder or command file there; a source's into its current snapshot.
    const placed = members.map((member): PlacedMember => {
      const { target, commit } = member.layer.kind === "source" ? sources.place(member) : { target: join(own.path, ...member.path.split("/")), commit: null };
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
      members: set.members.map(({ name, description, origin, invocation, userInvocable, argumentHint, native, alwaysOn, kind, target, commit }) => ({
        name,
        description,
        origin,
        invocation,
        userInvocable,
        argumentHint,
        native,
        alwaysOn,
        file: generation === null || native ? (kind === "skill" ? join(target, "SKILL.md") : target) : join(generation, "skills", name, "SKILL.md"),
        commit,
      })),
      hiddenNativeNames: [...set.hiddenNativeNames],
    };
  };
};
