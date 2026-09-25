import type { AccountCatalogue, AccountIdentity, AccountRecord } from "@agent-harness/contracts";
import { derived, dynamic, type Observable } from "../observable.js";
import type { CachedAnswer, QueryMethodName, RequestFailure } from "../requests.js";

/**
 * `projections.accounts`, `projections.models` and `projections.usage`
 * (docs/specs/client-runtime.md, "Projections"; ADR 0005, ADR 0018): what
 * the account and model pickers and the plan gauges read, per environment
 * from the request cache (`requests.cached`), so each is fetched while
 * followed, kept five minutes, and fetched again on every ready and on the
 * notices that say it changed (`QUERY_REFRESH_NOTICES`: `account.updated`
 * and `signin.updated` for all three, `usage.updated` for plan usage).
 * Accounts and models are per environment (ADR 0001: an account is an
 * environment's); plan usage is pooled across the enabled environments by
 * account identity, so one login signed in on two environments is one gauge
 * (`poolUsage`).
 */

/** One environment's answer to a query, as a picker reads it. */
export interface EnvironmentAnswer<T> {
  readonly environmentId: string;
  /** What the environment last answered; null until an answer came. */
  readonly value: T | null;
  /** When that answer came, on this client's clock. */
  readonly fetchedAt: string | null;
  /** Why the last fetch failed, the last value kept beside it. */
  readonly error: RequestFailure | null;
  readonly loading: boolean;
}

/** A cached query's answer as an environment's answer: `pick` takes what the picker lists from the result. */
export const answerOf = <N extends QueryMethodName, T>(environmentId: string, cached: Observable<CachedAnswer<N>>, pick: (result: NonNullable<CachedAnswer<N>["result"]>) => T): Observable<EnvironmentAnswer<T>> =>
  derived([cached] as const, (answer) => ({
    environmentId,
    value: answer.result === null ? null : pick(answer.result as NonNullable<CachedAnswer<N>["result"]>),
    fetchedAt: answer.fetchedAt,
    error: answer.error,
    loading: answer.loading,
  }));

export type AccountsAnswer = EnvironmentAnswer<readonly AccountRecord[]>;
export type ModelsAnswer = EnvironmentAnswer<readonly AccountCatalogue[]>;

/**
 * One plan window of an account's reading: #136's `UsageWindow`, which this
 * build's contracts do not hold yet. The merge with #136 replaces these two
 * types with the contracts' `UsageWindow` and `AccountUsage`.
 */
export interface UsageWindow {
  /** The window in the provider's words: five_hour, seven_day, model_scoped:<model>. */
  readonly window: string;
  /** How much of it is used, 0 to 1 and beyond; null when the provider does not say. */
  readonly utilisation: number | null;
  readonly resetsAt: string | null;
  /** The latest rate-limit verdict a run reported for it since the read. */
  readonly verdict: "allowed" | "warning" | "rejected" | null;
  /** When these numbers were observed: the reading's `readAt`, or a run's report folded in since. What pooling compares. */
  readonly observedAt: string;
}

/** One account's plan usage as `accounts.usage` answers it (#136's `AccountUsage`). */
export interface UsageReading {
  readonly accountId: string;
  /** Who the account is signed in as: what readings are pooled by. Null when it has never been read. */
  readonly identity: AccountIdentity | null;
  readonly windows: readonly UsageWindow[];
  readonly readAt: string;
  /** Why the reading has no windows, when it has none. */
  readonly unavailableReason: string | null;
}

/** One gauge: the readings of one account identity across environments, merged window by window. */
export interface UsageGauge {
  /** The identity pooled; null for an account never read, which is a gauge of its own. */
  readonly identity: AccountIdentity | null;
  /** The accounts it pools, in the connection list's order, then each environment's. */
  readonly accounts: readonly { readonly environmentId: string; readonly accountId: string }[];
  /** Each window from whichever reading observed it last; in the order of the newest reading, then any only others have. */
  readonly windows: readonly UsageWindow[];
  /** The newest of the pooled readings' `readAt`. */
  readonly readAt: string;
  /** Why there is no window, when no pooled reading has one: the newest reading's reason. */
  readonly unavailableReason: string | null;
}

export interface UsageView {
  /** The gauges, in the order their first account appears. */
  readonly gauges: readonly UsageGauge[];
  /** Each enabled environment's readings and how its read went, in the connection list's order. */
  readonly environments: readonly EnvironmentAnswer<readonly UsageReading[]>[];
}

/** One login, as deep equality reads an identity: #136 makes one login read as one deep-equal identity on every environment. */
const identityKey = (identity: AccountIdentity): string => JSON.stringify([identity.provider, identity.email, identity.organisation]);

const later = (a: string, b: string): boolean => Date.parse(a) > Date.parse(b);

/**
 * The readings of every environment pooled by account identity (ADR 0018):
 * the readings of one identity are one gauge, each window taken from the
 * reading that observed it last (`observedAt`, Artemis's `mergePlanUsage`
 * per window; a tie goes to the earlier environment in the list), so a run's
 * verdict folded in on one environment beats an older read on another. An
 * account with no identity yet is a gauge of its own.
 */
export const poolUsage = (environments: readonly { readonly environmentId: string; readonly readings: readonly UsageReading[] }[]): UsageGauge[] => {
  const pools = new Map<string, { identity: AccountIdentity | null; members: { environmentId: string; reading: UsageReading }[] }>();
  for (const { environmentId, readings } of environments) {
    for (const reading of readings) {
      const key = reading.identity === null ? `unread ${environmentId} ${reading.accountId}` : identityKey(reading.identity);
      let pool = pools.get(key);
      if (pool === undefined) pools.set(key, (pool = { identity: reading.identity, members: [] }));
      pool.members.push({ environmentId, reading });
    }
  }
  return [...pools.values()].map(({ identity, members }) => {
    const newest = members.reduce((best, member) => (later(member.reading.readAt, best.reading.readAt) ? member : best));
    // Each window from the reading that observed it last; the members are in the connection list's order, so a tie stays with the earlier environment.
    const observed = new Map<string, UsageWindow>();
    for (const { reading } of members) {
      for (const window of reading.windows) {
        const held = observed.get(window.window);
        if (held === undefined || later(window.observedAt, held.observedAt)) observed.set(window.window, window);
      }
    }
    // In the newest reading's order, the provider's, then any window only an older reading has.
    const order = new Set([newest, ...members.filter((m) => m !== newest)].flatMap(({ reading }) => reading.windows.map(({ window }) => window)));
    return {
      identity,
      accounts: members.map(({ environmentId, reading }) => ({ environmentId, accountId: reading.accountId })),
      windows: [...order].flatMap((window) => observed.get(window) ?? []),
      readAt: newest.reading.readAt,
      unavailableReason: order.size === 0 ? newest.reading.unavailableReason : null,
    };
  });
};

type UsageAnswer = CachedAnswer<never>;

export interface UsageHost {
  /** The enabled environments, in the connection list's order. */
  readonly environments: Observable<readonly string[]>;
  /** The request cache's `accounts.usage` for the environment: the same observable for each. */
  readonly source: (environmentId: string) => Observable<UsageAnswer>;
}

/** `projections.usage`: every enabled environment's readings, followed while the view is, and pooled. */
export const usageProjection = (host: UsageHost): Observable<UsageView> =>
  dynamic(
    () => [host.environments, ...host.environments.read().map(host.source)],
    (): UsageView => {
      const environments = host.environments.read().map((environmentId): EnvironmentAnswer<readonly UsageReading[]> => {
        const answer = host.source(environmentId).read();
        const result = answer.result as { readonly readings?: readonly UsageReading[] } | null;
        return { environmentId, value: result?.readings ?? null, fetchedAt: answer.fetchedAt, error: answer.error, loading: answer.loading };
      });
      return { gauges: poolUsage(environments.map(({ environmentId, value }) => ({ environmentId, readings: value ?? [] }))), environments };
    },
  );
