import { ROUTINE_ATTENTION, type AccountIdentity, type ListedRoutine, type ModeResolution, type RoutineAttention, type UnattendedMode } from "@agent-harness/contracts";
import type { HostAccounts } from "../accounts/account-service.js";
import { accountByIdentity } from "../accounts/account-store.js";
import { EVERY_MODE, clampMode, startingMode } from "../permissions/resolver.js";
import type { AccountFacts } from "../runs/run-decider.js";
import type { Reader } from "../sessions/session-tables.js";
import type { StoredRoutine } from "./routine-store.js";

/**
 * A routine as `routines.list` answers it (routines spec, "Methods on the
 * wire"): its definition and state, its effective mode with the clamp, and
 * what needs attention, read from the environment as it is now, so the
 * attention follows an account's change without a save. The account, model
 * and clamp attention are here; the scripts', endpoints', skills', firings'
 * and deliveries' are the tickets' that add them, and the next due time the
 * scheduler's.
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
 * A routine's effective mode, as the policy resolver clamps an unattended
 * run: its mode, else the unattended default, clamped to the ceiling it was
 * saved under and the account's modes (every mode when the account is not
 * here). When no mode at or below the ceiling is available to the account,
 * the ceiling's clamp alone: a firing could not start then, which the run's
 * start refuses.
 */
const effectiveMode = (routine: StoredRoutine, account: AccountFacts | null, unattendedMode: UnattendedMode): ModeResolution => {
  const { mode } = routine.definition;
  const start = startingMode(mode, false, unattendedMode);
  const ceiling = routine.state.savedUnderCeiling;
  return clampMode(mode, start, ceiling, account?.descriptor.modes ?? EVERY_MODE) ?? (clampMode(mode, start, ceiling, EVERY_MODE) as ModeResolution);
};

/** Each attention code that holds, in the codes' own order. */
const attentionOf = (routine: StoredRoutine, account: AccountFacts | null, mode: ModeResolution): RoutineAttention[] => {
  const { model } = routine.definition;
  const holds: Partial<Record<RoutineAttention, boolean>> = {
    account_missing: account === null,
    account_signed_out: account !== null && !account.signedIn,
    model_unavailable: account !== null && model !== null && !account.models.some((option) => option.id === model),
    clamped: mode.clamped,
  };
  return ROUTINE_ATTENTION.filter((code) => holds[code] === true);
};

/** The routine as `routines.list` answers it, under the unattended default and the accounts as they are now. */
export const listRoutine = (routine: StoredRoutine, where: RoutineAccounts, unattendedMode: UnattendedMode): ListedRoutine => {
  const account = routineAccount(routine.definition.account, where);
  const mode = effectiveMode(routine, account, unattendedMode);
  return { definition: routine.definition, state: routine.state, nextDueAt: null, mode, attention: attentionOf(routine, account, mode) };
};
