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
 * Skills' attention is the ticket's that adds it. The next due time is the
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

/** What a routine's attention reads of the environment beyond its accounts: whether a file is at a path in the scripts directory. */
export interface RoutineSurroundings extends RoutineAccounts {
  readonly scriptPresent: (path: string) => boolean;
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

/** Each attention code that holds, in the codes' own order. */
const attentionOf = (routine: RoutineFacts, account: AccountFacts | null, mode: ModeResolution, where: RoutineSurroundings): RoutineAttention[] => {
  const { model, preCheck, delivery } = routine.definition;
  const targets = delivery.filter((target) => target.kind === "webhook");
  const endpoints = targets.map((target) => storedEndpoint(where.reader, target.target));
  const holds: Partial<Record<RoutineAttention, boolean>> = {
    account_missing: account === null,
    account_signed_out: account !== null && !account.signedIn,
    model_unavailable: account !== null && model !== null && !account.models.some((option) => option.id === model),
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
  return ROUTINE_ATTENTION.filter((code) => holds[code] === true);
};

/** What a routine saved as `routine` would need attention for here, as `routines.list` would show it: an import's warnings (#528). */
export const routineAttention = (routine: RoutineFacts, where: RoutineSurroundings, unattendedMode: UnattendedMode): RoutineAttention[] => {
  const account = routineAccount(routine.definition.account, where);
  return attentionOf(routine, account, effectiveMode(routine, account, unattendedMode), where);
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
  return { definition: routine.definition, state: routine.state, nextDueAt: due?.toISOString() ?? null, mode, attention: attentionOf(routine, account, mode, where) };
};
