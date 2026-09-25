import { ContractError, type AccountRecord, type AccountUsage, type HandoffRecommendation, type HandoffTrigger } from "@agent-harness/contracts";
import type { Clock } from "../serve/clock.js";
import type { MethodHandlers } from "../serve/methods.js";
import {
  DEFAULT_HANDOFF_THRESHOLDS,
  USAGE_MAX_AGE_MS,
  bindingWindow,
  handoffTrigger,
  isAvailable,
  isModelScoped,
  recommendAccount,
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
 * the account with the most room of two or more (Artemis's
 * `recommendProfile`). Asked from an account, it says which threshold that
 * account has met (`handoffTrigger`, on a reading under six minutes old, or
 * a window the provider is refusing on a reading of any age: a percentage
 * goes stale, a refusal does not) and names the other account with the most
 * room, one being a choice, never one whose tightest window the provider is
 * refusing. No plan weights are known yet, so the basis is `percentage`.
 */

export interface UsageMethodsOptions {
  readonly pool: UsagePool;
  readonly accounts: { list(): AccountRecord[] };
  readonly clock: Pick<Clock, "now">;
}

const percent = (fraction: number): string => `${Math.round(fraction * 100)}%`;

/** A window as a sentence names it: the threshold's label when a shipped rule is about it, else the provider's name. */
const windowInWords = (window: string): string => {
  const rule = DEFAULT_HANDOFF_THRESHOLDS.find(({ match }) =>
    match.kind === "window" ? match.window === window : isModelScoped(window) && window.toLowerCase().includes(match.name),
  );
  return rule?.label ?? window;
};

const triggerOf = (match: HandoffTriggerMatch): HandoffTrigger => ({
  threshold: match.threshold.id,
  label: match.threshold.label,
  at: match.threshold.at,
  window: match.window.window,
  utilisation: match.utilisation,
  verdict: match.window.verdict,
});

/** Whether a reading is young enough to forecast from. */
const fresh = (reading: AccountUsage, now: number): boolean => Math.max(0, now - Date.parse(reading.readAt)) <= USAGE_MAX_AGE_MS;

/** The threshold `reading` has met: any, on a fresh reading; only a refused window, on a stale one. */
const metThreshold = (reading: AccountUsage | null, now: number): HandoffTriggerMatch | null => {
  if (!isAvailable(reading)) return null;
  const match = handoffTrigger(reading, DEFAULT_HANDOFF_THRESHOLDS, now);
  if (match === null) return null;
  return fresh(reading, now) || match.window.verdict === "rejected" ? match : null;
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
  const targets =
    fromAccountId === undefined
      ? entries
      : entries.filter((entry) => entry.accountId !== fromAccountId && bindingWindow(entry.reading, now)?.verdict !== "rejected");
  const chosen = recommendAccount(targets, { now, minCandidates: fromAccountId === undefined ? 2 : 1 });

  const from = fromAccountId === undefined ? null : labelOf(fromAccountId);
  const said =
    trigger === null
      ? null
      : trigger.window.verdict === "rejected"
        ? `${from}'s ${trigger.threshold.label} window has run out`
        : `${from}'s ${trigger.threshold.label} window is at ${percent(trigger.utilisation)}`;
  if (chosen === null) {
    const none =
      fromAccountId === undefined ? "Fewer than two accounts have a fresh plan reading to compare." : "No other account has a fresh plan reading with room to hand the work to.";
    return {
      accountId: null,
      reason: "no-target",
      message: said === null ? none : `${said}. ${none}`,
      fromAccountId: fromAccountId ?? null,
      trigger: trigger === null ? null : triggerOf(trigger),
      headroom: null,
      binding: null,
      // The accounts that could be ranked, too few to choose between.
      candidates: recommendAccount(targets, { now, minCandidates: 0 })?.candidates ?? 0,
      basis: null,
    };
  }
  const room = `${labelOf(chosen.accountId)} has the most room, ${percent(chosen.headroom)} free in its ${windowInWords(chosen.binding.window)} window.`;
  return {
    accountId: chosen.accountId,
    reason: trigger === null ? "most-room" : trigger.window.verdict === "rejected" ? "limit-reached" : "limit-near",
    message: said === null ? room : `${said}; ${room}`,
    fromAccountId: fromAccountId ?? null,
    trigger: trigger === null ? null : triggerOf(trigger),
    headroom: chosen.headroom,
    binding: chosen.binding.window,
    candidates: chosen.candidates,
    basis: chosen.basis,
  };
};

export const usageMethods = (options: UsageMethodsOptions): MethodHandlers => ({
  "accounts.usage": async (params) => ({ readings: await options.pool.read(params.accountId) }),

  "accounts.handoff.recommend": (params) => recommendHandoff(options, params.fromAccountId),
});
