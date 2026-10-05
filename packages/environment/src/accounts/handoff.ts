import { usageWindowLabel } from "@agent-harness/contracts";
import type { AccountUsage, HandoffBasis, UsageWindow } from "@agent-harness/contracts";

/**
 * The hand-off policy (claude-adapter spec, "Wire methods":
 * `accounts.handoff.recommend`; ADR 0005), an implementation the port audit
 * write-up (core) found pure, host-free and well tested:
 *
 * - **Thresholds**: when an account is near enough its limit that the work
 *   should be handed on, per window rather than on the worst one, since the
 *   5-hour window refills within the day and the weekly one does not.
 * - **Load**: what the runs already on an account are going to spend,
 *   reserved before ranking so the next session does not herd onto the
 *   account a reading still shows as emptiest.
 * - **Recommendation**: the account with the most room, on fresh readings
 *   only, never a metered one, ties to the caller's order.
 *
 * Notes on the shape here: a reading is the wire's `AccountUsage`, so
 * utilisation is a fraction (a percentage divided by 100, the thresholds and
 * the reservation included), a window is named by its `window` and carries
 * its own `observedAt`, and a verdict is `allowed`; a reading is available
 * when it has no `unavailableReason`. `handoffTrigger` takes the time, so a
 * window that has rolled over since it was read meets no threshold.
 * `recommendAccount` takes `minCandidates` (two), so a hand-off from one
 * account to the only other is still a choice, and never names an account
 * with no room (a refused window, or a full one): both still count toward
 * `candidates`, but neither is ever `best`, so a set that is every account
 * full or refused answers no recommendation.
 * Freshness is one rule (`isFresh`): under six minutes old, so a reading
 * ages out at six minutes exactly, as the pool reads it again then. No
 * reading carries a plan tier yet, so an entry's `plan` is the caller's to
 * give and the environment gives none, which makes every basis `percentage`
 * until one does.
 */

// Thresholds.

/**
 * A window to watch, and how full it may get before the work is handed on.
 * `match` is a family for the per-model buckets, which vary by account
 * (`model_scoped:Fable` on one, another spelling on the next).
 */
export interface HandoffThreshold {
  /** Stable key for the rule, so a preference can be stored against it. */
  readonly id: string;
  /** What to call the window in a sentence. */
  readonly label: string;
  /** Utilisation, 0 to 1, at or above which the work should be handed on. */
  readonly at: number;
  readonly match: { readonly kind: "window"; readonly window: string } | { readonly kind: "model"; readonly name: string };
}

/**
 * The shipped rules, deliberately asymmetric: the 5-hour window at 90%
 * (it refills within the day, so the margin is cheap), the weekly at 98%
 * (gone for days once spent, so ridden close to the edge), Fable at 95%
 * (metered apart, and its exhaustion takes one model rather than the account).
 */
export const DEFAULT_HANDOFF_THRESHOLDS: readonly HandoffThreshold[] = [
  { id: "five_hour", label: usageWindowLabel("five_hour"), at: 0.9, match: { kind: "window", window: "five_hour" } },
  { id: "seven_day", label: usageWindowLabel("seven_day"), at: 0.98, match: { kind: "window", window: "seven_day" } },
  { id: "fable", label: usageWindowLabel("model_scoped:Fable"), at: 0.95, match: { kind: "model", name: "fable" } },
];

/**
 * The shipped rules with a person's thresholds applied, keyed by rule id:
 * an absent rule keeps its default, an unknown key is ignored, a value is
 * clamped to 1% to 100% and rounded to a whole percent, and anything that is
 * not a finite number leaves the default.
 */
export const handoffThresholdsWith = (overrides: Readonly<Record<string, number>> | undefined): readonly HandoffThreshold[] => {
  if (overrides === undefined) return DEFAULT_HANDOFF_THRESHOLDS;
  return DEFAULT_HANDOFF_THRESHOLDS.map((threshold) => {
    const at = overrides[threshold.id];
    if (typeof at !== "number" || !Number.isFinite(at)) return threshold;
    return { ...threshold, at: Math.min(100, Math.max(1, Math.round(at * 100))) / 100 };
  });
};

/** A rule that has been met, and the window that met it. */
export interface HandoffTriggerMatch {
  readonly threshold: HandoffThreshold;
  readonly window: UsageWindow;
  /** The window's utilisation rounded to a whole percent, for a sentence; 1 for a refused window that reported none. */
  readonly utilisation: number;
}

/** True for the per-model weekly buckets. */
export const isModelScoped = (window: string): boolean => window === "model_scoped" || window.startsWith("model_scoped:");

/** Whether a reading has plan windows to reason about: read, and not unavailable. */
export const isAvailable = (reading: AccountUsage | null | undefined): reading is AccountUsage => reading !== null && reading !== undefined && reading.unavailableReason === null;

const toWhole = (fraction: number): number => Math.round(fraction * 100) / 100;

/** The windows of a reading still true at `now`: every one when no time is given. */
const windowsAt = (reading: AccountUsage, now: number | undefined): UsageWindow[] =>
  now === undefined ? [...reading.windows] : reading.windows.flatMap((window) => currentWindow(window, now) ?? []);

/**
 * The window a rule is about, or null when this plan reports none; within a
 * model family the most used bucket, since the one closest to full is the
 * one that will stop you, and a bucket the provider is refusing before any
 * other, whether or not it carries a number (as `bindingWindow` reads it).
 * With `now`, a window that has rolled over since it was read is not one.
 */
export const windowFor = (reading: AccountUsage | null | undefined, threshold: HandoffThreshold, now?: number): UsageWindow | null => {
  if (!isAvailable(reading)) return null;
  const windows = windowsAt(reading, now);
  const { match } = threshold;
  if (match.kind === "window") return windows.find((window) => window.window === match.window) ?? null;
  const name = match.name.toLowerCase();
  let refused: UsageWindow | null = null;
  let worst: UsageWindow | null = null;
  for (const window of windows) {
    if (!isModelScoped(window.window) || !window.window.toLowerCase().includes(name)) continue;
    if (window.verdict === "rejected") {
      if (refused === null || (window.utilisation ?? -1) > (refused.utilisation ?? -1)) refused = window;
      continue;
    }
    if (window.utilisation === null) continue;
    if (worst === null || window.utilisation > (worst.utilisation ?? -1)) worst = window;
  }
  return refused ?? worst;
};

/**
 * The first rule, in threshold order, this reading has met, or null: the
 * result is a reason shown to a person, so the order of the rules rather
 * than the size of an overshoot decides. A window the provider is refusing
 * has been hit whatever its utilisation reads; a window reported without a
 * number is not a match.
 */
export const handoffTrigger = (
  reading: AccountUsage | null | undefined,
  thresholds: readonly HandoffThreshold[] = DEFAULT_HANDOFF_THRESHOLDS,
  now?: number,
): HandoffTriggerMatch | null => {
  if (!isAvailable(reading)) return null;
  for (const threshold of thresholds) {
    const window = windowFor(reading, threshold, now);
    if (window === null) continue;
    if (window.verdict === "rejected") return { threshold, window, utilisation: toWhole(window.utilisation ?? 1) };
    if (window.utilisation === null) continue;
    if (window.utilisation >= threshold.at) return { threshold, window, utilisation: toWhole(window.utilisation) };
  }
  return null;
};

// Load.

/** What one live run is doing, as far as its cost is concerned. */
export interface LiveRunLoad {
  /** The model id in whatever spelling the catalogue used; matched by family. */
  readonly model?: string | null;
  /** The reasoning effort; absent for the provider's default. */
  readonly effort?: string | null;
  /** Whether the run was asked to spend materially more compute (fanning out across subagents). */
  readonly ultracode?: boolean;
}

/*
 * THE CONSTANTS BELOW ARE AN INFORMED GUESS AND HAVE NOT BEEN CALIBRATED
 * AGAINST REAL CONSUMPTION. They encode an ordering believed
 * correct and magnitudes that are plausible; the tests assert the ordering
 * and the invariants, so better numbers can be dropped in.
 * `BASELINE_RESERVATION` is the one knob.
 */

/** Relative load by model family, against Sonnet at 1. */
export const MODEL_LOAD: Readonly<Record<string, number>> = { haiku: 0.25, sonnet: 1, opus: 4, fable: 8 };

/** Relative load by reasoning effort, against medium at 1. */
export const EFFORT_LOAD: Readonly<Record<string, number>> = { low: 0.5, medium: 1, high: 2, xhigh: 3, max: 4 };

/** What ultracode multiplies a run's load by: it multiplies the turns, where effort deepens one. */
export const ULTRACODE_MULTIPLIER = 2;

/**
 * The share of a baseline plan's binding window one Sonnet run at medium
 * effort is expected to use: 0.75 percentage points, as a fraction.
 */
export const BASELINE_RESERVATION = 0.0075;

const SONNET = MODEL_LOAD["sonnet"] ?? 1;
const MEDIUM = EFFORT_LOAD["medium"] ?? 1;

/** The model's load, matched by family inside whatever id arrived, the longest family first; an unknown model is a middling one. */
export const modelLoadFactor = (model: string | null | undefined): number => {
  if (typeof model !== "string" || model.length === 0) return SONNET;
  const id = model.toLowerCase();
  const families = Object.keys(MODEL_LOAD).sort((a, b) => b.length - a.length);
  for (const family of families) if (id.includes(family)) return MODEL_LOAD[family] ?? SONNET;
  return SONNET;
};

/** The effort's load; medium for anything unknown. */
export const effortLoadFactor = (effort: string | null | undefined): number => {
  if (typeof effort !== "string" || effort.length === 0) return MEDIUM;
  return EFFORT_LOAD[effort.toLowerCase()] ?? MEDIUM;
};

/** How heavy one run is, relative to a Sonnet run at medium effort. */
export const runLoadFactor = (run: LiveRunLoad): number => {
  const base = modelLoadFactor(run.model) * effortLoadFactor(run.effort);
  return run.ultracode === true ? base * ULTRACODE_MULTIPLIER : base;
};

/** What a set of live runs reserves, as a share of a baseline plan's window: additive, and deliberately not clamped. */
export const reservationFor = (runs: readonly LiveRunLoad[] | undefined): number => {
  if (runs === undefined || runs.length === 0) return 0;
  let total = 0;
  for (const run of runs) total += runLoadFactor(run) * BASELINE_RESERVATION;
  return total;
};

// Recommendation.

/** How old a reading may be and still be recommended on: six minutes, and the pool's (`usage-pool.ts`). */
export const USAGE_MAX_AGE_MS = 6 * 60_000;

/**
 * Whether something observed at `observedAt` is still fresh at `now`: under
 * `maxAgeMs` old, so it ages out at six minutes exactly. A time in the
 * future is a clock that disagrees with itself, and counts as now. The one
 * comparison the pool (when to read again), the ranking and the trigger make.
 */
export const isFresh = (observedAt: number, now: number, maxAgeMs: number = USAGE_MAX_AGE_MS): boolean => Math.max(0, now - observedAt) < maxAgeMs;

const instant = (value: string | null): number | null => {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

/**
 * The window, or null when its numbers were observed before a reset that has
 * passed: they describe a period that is over. A window observed at or after
 * its reset is kept, whatever the clock says.
 */
export const currentWindow = (window: UsageWindow, now: number): UsageWindow | null => {
  const resetsAt = instant(window.resetsAt);
  if (resetsAt === null || resetsAt > now) return window;
  return (instant(window.observedAt) ?? now) < resetsAt ? null : window;
};

/**
 * The window that will stop the account first: one the provider is refusing
 * outranks any number (it binds even with none), else the most used; a
 * window that has rolled over since it was read binds nothing.
 */
export const bindingWindow = (reading: AccountUsage | null | undefined, now: number): UsageWindow | null => {
  if (!isAvailable(reading)) return null;
  let rejected: UsageWindow | null = null;
  let worst: UsageWindow | null = null;
  for (const raw of reading.windows) {
    const window = currentWindow(raw, now);
    if (window === null) continue;
    if (window.verdict === "rejected") {
      if (rejected === null || (window.utilisation ?? -1) > (rejected.utilisation ?? -1)) rejected = window;
      continue;
    }
    if (window.utilisation === null) continue;
    if (worst === null || window.utilisation > (worst.utilisation ?? -1)) worst = window;
  }
  return rejected ?? worst;
};

/**
 * How much of the plan is left, 0 to 1, in its tightest window; 0 when
 * refused, and when the provider reports the window beyond its limit
 * (clamped here, rather than going negative); null with nothing to answer
 * from. The ranking
 * reckons its own room, and never names an account with none.
 */
export const planHeadroom = (reading: AccountUsage | null | undefined, now: number): number | null => {
  const binding = bindingWindow(reading, now);
  if (binding === null) return null;
  if (binding.verdict === "rejected") return 0;
  if (binding.utilisation === null) return null;
  return Math.max(0, 1 - binding.utilisation);
};

/** A plan's size against its provider's baseline, when one is known: the resolved plan weight. */
export interface PlanWeight {
  /** `<provider>:<plan>`, as the plan table names it. */
  readonly id: string;
  /** The multiple of the provider's baseline plan; null for a plan sold as no multiple (Team, Enterprise). */
  readonly weight: number | null;
  /** Whether the tier was inferred from an ambiguous reported family rather than pinned. */
  readonly assumed: boolean;
}

/** One account's latest reading, as `recommendAccount` takes them. */
export interface AccountPlanUsage {
  readonly accountId: string;
  readonly reading: AccountUsage | null | undefined;
  /** The provider, for weighting: weights are never compared across two. */
  readonly provider?: string;
  readonly plan?: PlanWeight | null;
  /** Runs already going on the account, which its reading does not show yet. */
  readonly liveRuns?: readonly LiveRunLoad[];
}

/** The account with the most room, and what decides it. */
export interface AccountRecommendation {
  readonly accountId: string;
  /** Its room, 0 to 1, in its tightest window: the reading's, not less what its runs reserve. */
  readonly headroom: number;
  readonly binding: UsageWindow;
  /** How many accounts it was chosen from: the ones ranked (`rankAccounts`), itself and any full or refused one among them. */
  readonly candidates: number;
  readonly basis: HandoffBasis;
  readonly plan: PlanWeight | null;
  readonly assumedPlan: boolean;
}

/** When a reading was last observed: its newest window, or its read. A run's verdict folded since keeps it fresh. */
export const newestObservation = (reading: AccountUsage): number => {
  let newest = instant(reading.readAt) ?? Number.NEGATIVE_INFINITY;
  for (const window of reading.windows) newest = Math.max(newest, instant(window.observedAt) ?? newest);
  return newest;
};

interface Ranked {
  readonly entry: AccountPlanUsage;
  readonly binding: UsageWindow;
  readonly headroom: number;
}

/** What the set can honestly be compared on, strongest claim first. */
const basisFor = (entries: readonly AccountPlanUsage[]): HandoffBasis => {
  const plans = new Set<string>();
  const providers = new Set<string>();
  let everyPlanWeighed = true;
  for (const entry of entries) {
    const plan = entry.plan ?? null;
    if (plan === null || plan.weight === null) everyPlanWeighed = false;
    plans.add(plan?.id ?? "unknown");
    providers.add(entry.provider ?? "unknown");
  }
  if (plans.size === 1 && !plans.has("unknown")) return "same-plan";
  if (everyPlanWeighed && providers.size === 1 && !providers.has("unknown")) return "weighted";
  return "percentage";
};

/**
 * Room scaled by plan size, less what the live runs reserve, in the
 * baseline plan's units; not clamped, so the least over-committed account
 * stays on top when every one is.
 */
const scoreOf = (candidate: Ranked, basis: HandoffBasis): number => {
  const weight = candidate.entry.plan?.weight ?? 1;
  const reserved = reservationFor(candidate.entry.liveRuns);
  if (basis === "percentage") return candidate.headroom - reserved / weight;
  return candidate.headroom * weight - reserved;
};

/** Options of a ranking: the time, the freshness bound, and how many rankable accounts make a choice. */
export interface RankOptions {
  readonly now: number;
  readonly maxAgeMs?: number;
  /** Preset two: with one rankable account there is no choice. */
  readonly minCandidates?: number;
}

/** A ranking: how many accounts were ranked (the candidates), and the one with the most room, or null. */
export interface Ranking {
  readonly candidates: number;
  readonly best: AccountRecommendation | null;
}

/**
 * Ranks the accounts. A candidate is an account with plan limits (never a
 * metered one), a fresh reading by its newest observation, and a usable
 * number; `candidates` counts these and nothing else, so an account never
 * read, one unavailable, one stale, or one whose every window has rolled
 * over is not one. Fewer than `minCandidates` candidates is no
 * recommendation. A refused account and a full one count among the
 * candidates but never win: no account with no room is named, so all of them
 * full or refused is no recommendation. Ties keep the caller's order, so the
 * answer does not swap between asks.
 */
export const rankAccounts = (entries: readonly AccountPlanUsage[], options: RankOptions): Ranking => {
  const ranked: Ranked[] = [];
  for (const entry of entries) {
    const reading = entry.reading;
    if (!isAvailable(reading)) continue;
    if (!isFresh(newestObservation(reading), options.now, options.maxAgeMs)) continue;
    const binding = bindingWindow(reading, options.now);
    if (binding === null) continue;
    const headroom = binding.verdict === "rejected" ? 0 : 1 - (binding.utilisation ?? Number.NaN);
    if (Number.isNaN(headroom)) continue;
    ranked.push({ entry, binding, headroom });
  }
  const candidates = ranked.length;
  if (candidates === 0 || candidates < (options.minCandidates ?? 2)) return { candidates, best: null };
  const basis = basisFor(ranked.map((candidate) => candidate.entry));
  let best: Ranked | null = null;
  for (const candidate of ranked) {
    if (candidate.binding.verdict === "rejected" || candidate.headroom <= 0) continue;
    // Strictly greater: the first at a score keeps it.
    if (best === null || scoreOf(candidate, basis) > scoreOf(best, basis)) best = candidate;
  }
  if (best === null) return { candidates, best: null };
  const plan = best.entry.plan ?? null;
  return {
    candidates,
    best: { accountId: best.entry.accountId, headroom: best.headroom, binding: best.binding, candidates, basis, plan, assumedPlan: plan?.assumed ?? false },
  };
};

/** The account with the most room, or null when that is not a question (`rankAccounts`). */
export const recommendAccount = (entries: readonly AccountPlanUsage[], options: RankOptions): AccountRecommendation | null => rankAccounts(entries, options).best;
