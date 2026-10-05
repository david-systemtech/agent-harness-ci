import { ContractError, usageWindowLabel, type AccountRecord, type AccountUsage, type HandoffRecommendation, type HandoffTrigger } from "@agent-harness/contracts";
import type { Clock } from "../serve/clock.js";
import type { MethodHandlers } from "../serve/methods.js";
import {
  DEFAULT_HANDOFF_THRESHOLDS,
  handoffTrigger,
  isFresh,
  rankAccounts,
  type AccountPlanUsage,
  type HandoffTriggerMatch,
} from "./handoff.js";
import type { UsagePool } from "./usage-pool.js";

/**
 * The plan-usage methods (claude-adapter spec, "Wire methods"; #136):
 * `accounts.usage` reads through the pool (`usage-pool.ts`), and
 * `accounts.handoff.recommend` answers from what the pool holds with the
 * ported policy (`handoff.ts`).
 *
 * The recommendation reads no provider, so it answers at once and every
 * client asking at the same moment gets the same answer: the candidates are
 * the signed-in accounts in the store's order (the tie-break), each with the
 * pool's reading and the runs live on it. Asked with no account, it names
 * the account with the most room of two or more. Asked from an account, it
 * says which threshold that account has met (`handoffTrigger`, on a window
 * observed under six minutes ago, or one the provider is refusing whatever
 * its age: a percentage goes stale, a refusal does not) and names the other
 * account with the most room, one being a choice, never one whose tightest
 * window the provider is refusing. No account with no room is ever named,
 * though one counts among the `candidates`: the accounts ranked
 * (`rankAccounts`). No plan weights are known yet, so the basis is
 * `percentage`.
 */

export interface UsageMethodsOptions {
  readonly pool: UsagePool;
  readonly accounts: { list(): AccountRecord[] };
  readonly clock: Pick<Clock, "now">;
}

const percent = (fraction: number): string => `${Math.round(fraction * 100)}%`;

const triggerOf = (match: HandoffTriggerMatch): HandoffTrigger => ({
  threshold: match.threshold.id,
  label: match.threshold.label,
  at: match.threshold.at,
  window: match.window.window,
  utilisation: match.utilisation,
  verdict: match.window.verdict,
});

/**
 * The threshold `reading` has met: on a window observed under six minutes
 * ago (its `observedAt`, so a verdict a run reported since the read counts,
 * as the ranking counts it), or on a refused window of any age: a
 * percentage goes stale, a refusal does not.
 */
const metThreshold = (reading: AccountUsage | null, now: number): HandoffTriggerMatch | null => {
  const match = handoffTrigger(reading, DEFAULT_HANDOFF_THRESHOLDS, now);
  if (match === null) return null;
  return match.window.verdict === "rejected" || isFresh(Date.parse(match.window.observedAt), now) ? match : null;
};

export const recommendHandoff = (options: UsageMethodsOptions, fromAccountId: string | undefined): HandoffRecommendation => {
  const { pool, accounts, clock } = options;
  const now = clock.now().getTime();
  const records = accounts.list();
  const labelOf = (id: string): string => records.find((record) => record.id === id)?.label ?? id;
  if (fromAccountId !== undefined && !records.some((record) => record.id === fromAccountId)) {
    throw new ContractError({ code: "not_found", message: `No account ${fromAccountId} is on this environment.`, data: { kind: "account", accountId: fromAccountId } });
  }
  const entries: AccountPlanUsage[] = records
    .filter((record) => record.status.state === "signed-in")
    .map((record) => ({ accountId: record.id, provider: record.provider, reading: pool.cached(record.id), liveRuns: pool.liveRuns(record.id) }));

  const trigger = fromAccountId === undefined ? null : metThreshold(pool.cached(fromAccountId), now);
  // Handing off, the others are the targets, one being a choice; a refused one is ranked, and counted, but never named.
  const targets = fromAccountId === undefined ? entries : entries.filter((entry) => entry.accountId !== fromAccountId);
  const { candidates, best } = rankAccounts(targets, { now, minCandidates: fromAccountId === undefined ? 2 : 1 });

  const from = fromAccountId === undefined ? null : labelOf(fromAccountId);
  const said =
    trigger === null
      ? null
      : trigger.window.verdict === "rejected"
        ? `${from}'s ${trigger.threshold.label} window has run out`
        : `${from}'s ${trigger.threshold.label} window is at ${percent(trigger.utilisation)}`;
  if (best === null) {
    const none =
      fromAccountId === undefined ? "No two accounts have a fresh plan reading to compare, or none has room." : "No other account has a fresh plan reading with room to hand the work to.";
    return {
      accountId: null,
      reason: "no-target",
      message: said === null ? none : `${said}. ${none}`,
      fromAccountId: fromAccountId ?? null,
      trigger: trigger === null ? null : triggerOf(trigger),
      headroom: null,
      binding: null,
      candidates,
      basis: null,
    };
  }
  const most = fromAccountId === undefined ? "the most room" : "the most room of the others";
  const room = `${labelOf(best.accountId)} has ${most}, ${percent(best.headroom)} free in its ${usageWindowLabel(best.binding.window)} window.`;
  return {
    accountId: best.accountId,
    reason: trigger === null ? "most-room" : trigger.window.verdict === "rejected" ? "limit-reached" : "limit-near",
    message: said === null ? room : `${said}; ${room}`,
    fromAccountId: fromAccountId ?? null,
    trigger: trigger === null ? null : triggerOf(trigger),
    headroom: best.headroom,
    binding: best.binding.window,
    candidates,
    basis: best.basis,
  };
};

export const usageMethods = (options: UsageMethodsOptions): MethodHandlers => ({
  "accounts.usage": async (params) => ({ readings: await options.pool.read(params.accountId) }),

  "accounts.handoff.recommend": (params) => recommendHandoff(options, params.fromAccountId),
});
