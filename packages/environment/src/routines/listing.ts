import {
  ROUTINE_ATTENTION,
  nextDueAt,
  type AccountIdentity,
  type ListedRoutine,
  type ModeResolution,
  type RoutineAttention,
  type RoutineDefinition,
  type RoutineState,
  type UnattendedMode,
} from "@agent-harness/contracts";
import type { HostAccounts } from "../accounts/account-service.js";
import { accountByIdentity } from "../accounts/account-store.js";
import { EVERY_MODE, clampMode, startingMode } from "../permissions/resolver.js";
import type { AccountFacts } from "../runs/run-decider.js";
import type { Reader } from "../sessions/session-tables.js";
import { storedEndpoint } from "./endpoint-store.js";
import type { StoredRoutine } from "./routine-store.js";

/**
 * A routine as `routines.list` answers it (routines spec, "Methods on the
 * wire"): its definition and state, its effective mode with the clamp, and
 * what needs attention, read from the environment as it is now, so the
 * attention follows an account's change without a save. The account, model
 * and clamp attention are here, `failing` while the failure streak is not
 * zero (#523), and `script_missing` while no file is at a script
 * pre-check's path in the scripts directory (#526). Endpoint and delivery
 * attention read the stored endpoints and each target's latest result (#529).
 * `skill_unknown` while the skill set of its account, as read for the list,
 * lacks a name in its skills, each named in `unknownSkills` (#531): the set
 * of the environment's own layers, since the repository layer is a
 * workspace's, placed only when a firing starts. The next due time is the
 * scheduler's (#527): the first after the later of `handledThrough` and now.
 */

/** Where a routine's account is looked up: the account store's live accounts by identity, and the host's facts and default account. */
export interface RoutineAccounts {
  readonly reader: Reader;
  readonly accounts: Pick<HostAccounts, "facts" | "defaultId">;
}

/**
 * The account a routine's firing would run on, as the environment holds it
 * now: the live account signed in as its identity, whatever it reads now, or
 * for null the environment's default account; null when there is none.
 */
export const routineAccount = (identity: AccountIdentity | null, { reader, accounts }: RoutineAccounts): AccountFacts | null => {
  const id = identity === null ? accounts.defaultId() : (accountByIdentity(reader, identity)?.id ?? null);
  return id === null ? null : accounts.facts(id);
};

/**
 * Which names the skill set of an account holds (null: the environment's,
 * before any account's choices), as one reading of the set found them.
 */
export type SkillSetHolds = (accountId: string | null) => ReadonlySet<string>;

/** Reads the skill set as it is now: what a routine's skills are checked against (#531). */
export type SkillSetReader = () => Promise<SkillSetHolds>;

/** The names in `skills` that the set of `accountId` lacks, in their order; none when the set was not read. */
export const unknownSkills = (skills: readonly string[], holds: SkillSetHolds | null, accountId: string | null): string[] => {
  if (holds === null || skills.length === 0) return [];
  const known = holds(accountId);
  return skills.filter((name) => !known.has(name));
};

/** The set as read now when `skills` names any; else null at once, since no name is checked. */
export const readSkillSetFor = (skills: readonly string[], read: SkillSetReader): Promise<SkillSetHolds> | null => (skills.length === 0 ? null : read());

/**
 * What a routine's attention reads of the environment beyond its accounts:
 * whether a file is at a path in the scripts directory, and the skill set as
 * read for it (null when it was not, since no routine read names a skill).
 */
export interface RoutineSurroundings extends RoutineAccounts {
  readonly scriptPresent: (path: string) => boolean;
  readonly skillSet: SkillSetHolds | null;
}

/** What a routine's effective mode and attention read: its definition, the ceiling it is saved under and its failure streak. */
export interface RoutineFacts {
  readonly definition: RoutineDefinition;
  readonly state: Pick<RoutineState, "savedUnderCeiling" | "failureStreak"> & Partial<Pick<RoutineState, "id">>;
}

/**
 * A routine's effective mode, as the policy resolver clamps an unattended
 * run: its mode, else the unattended default, clamped to the ceiling it was
 * saved under and the account's modes (every mode when the account is not
 * here). When no mode at or below the ceiling is available to the account,
 * the ceiling's clamp alone: a firing could not start then, which the run's
 * start refuses.
 */
const effectiveMode = (routine: RoutineFacts, account: AccountFacts | null, unattendedMode: UnattendedMode): ModeResolution => {
  const { mode } = routine.definition;
  const start = startingMode(mode, false, unattendedMode);
  const ceiling = routine.state.savedUnderCeiling;
  return clampMode(mode, start, ceiling, account?.descriptor.modes ?? EVERY_MODE) ?? (clampMode(mode, start, ceiling, EVERY_MODE) as ModeResolution);
};

/** What needs attention on a routine: each code that holds, in the codes' own order, and the skills its account's set lacks. */
interface RoutineNeeds {
  readonly attention: RoutineAttention[];
  readonly unknownSkills: string[];
}

/** Each attention code that holds, in the codes' own order, with the skills the set of its account lacks. */
const needsOf = (routine: RoutineFacts, account: AccountFacts | null, mode: ModeResolution, where: RoutineSurroundings): RoutineNeeds => {
  const { model, preCheck, delivery, skills } = routine.definition;
  const unknown = unknownSkills(skills, where.skillSet, account?.id ?? null);
  const targets = delivery.filter((target) => target.kind === "webhook");
  const endpoints = targets.map((target) => storedEndpoint(where.reader, target.target));
  const holds: Partial<Record<RoutineAttention, boolean>> = {
    account_missing: account === null,
    account_signed_out: account !== null && !account.signedIn,
    model_unavailable: account !== null && model !== null && !account.models.some((option) => option.id === model),
    skill_unknown: unknown.length > 0,
    script_missing: preCheck?.kind === "script" && !where.scriptPresent(preCheck.path),
    endpoint_missing: endpoints.some((endpoint) => endpoint === null),
    endpoint_needs_secret: endpoints.some((endpoint) => endpoint?.secretKind === "missing"),
    delivery_failing: routine.state.id !== undefined && targets.some((target) => {
      const last = where.reader.all<{ result: string }>(
        `SELECT json_extract(d.value, '$.result') AS result FROM routine_entries e, json_each(e.entry, '$.deliveries') d
         WHERE e.routine_id = ? AND json_extract(d.value, '$.target.kind') = 'webhook'
         AND json_extract(d.value, '$.target.target') = ? AND json_extract(d.value, '$.target.on') = ?
         ORDER BY e.position DESC LIMIT 1`, routine.state.id!, target.target, target.on,
      )[0];
      return last?.result === "failed";
    }),
    clamped: mode.clamped,
    failing: routine.state.failureStreak > 0,
  };
  return { attention: ROUTINE_ATTENTION.filter((code) => holds[code] === true), unknownSkills: unknown };
};

/** What a routine saved as `routine` would need attention for here, as `routines.list` would show it: an import's warnings (#528). */
export const routineNeeds = (routine: RoutineFacts, where: RoutineSurroundings, unattendedMode: UnattendedMode): RoutineNeeds => {
  const account = routineAccount(routine.definition.account, where);
  return needsOf(routine, account, effectiveMode(routine, account, unattendedMode), where);
};

/**
 * When the routine is next due as the scheduler owes it (#527): the first
 * due time after the later of `now` and the latest it handled; null while it
 * is disabled, and for `manual`.
 */
export const routineNextDueAt = ({ definition, state }: StoredRoutine, now: Date): Date | null =>
  definition.enabled ? nextDueAt(definition, new Date(Math.max(handledInstant(state), now.getTime()))) : null;

/** The instant through which the routine's due times are handled, in milliseconds: `handledThrough`, else its creation. */
export const handledInstant = (state: Pick<RoutineState, "handledThrough" | "createdAt">): number => Date.parse(state.handledThrough ?? state.createdAt);

/** The routine as `routines.list` answers it at `now`, under the unattended default and the accounts and scripts as they are now. */
export const listRoutine = (routine: StoredRoutine, where: RoutineSurroundings, unattendedMode: UnattendedMode, now: Date): ListedRoutine => {
  const account = routineAccount(routine.definition.account, where);
  const mode = effectiveMode(routine, account, unattendedMode);
  const due = routineNextDueAt(routine, now);
  return { definition: routine.definition, state: routine.state, nextDueAt: due?.toISOString() ?? null, mode, ...needsOf(routine, account, mode, where) };
};
