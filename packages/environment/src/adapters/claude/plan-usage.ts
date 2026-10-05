import { PLAN_USAGE_WINDOW_LABELS, isKnownUsageWindow } from "@agent-harness/contracts";
import type { AccountIdentity } from "@agent-harness/contracts";
import type { AccountRef, UsageReading, UsageWindow } from "../../adapter/contract.js";
import type { Clock } from "../../serve/clock.js";

/**
 * Plan usage for a Claude account (claude-adapter spec, "Plan usage"). The
 * read costs no tokens: it is a control request on a query whose prompt never
 * yields, so the model is never sampled and the cost is one spawn under the
 * account's directory (`control-query.ts`). The method is reached by a
 * tolerant name lookup, since the SDK marks it experimental; a rename
 * degrades to unavailable rather than throwing.
 *
 * Verified against the pinned 0.3.281's declarations: `Query` has no stable
 * name yet, only `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
 * (opts?: { skipBehaviors?: boolean })` over the control request `get_usage`,
 * whose docstring says the name will change when it stabilises. So the
 * likely stable names stay ahead of it in the lookup and the experimental
 * one is last; when a stable one ships, it goes first. `skipBehaviors` spares
 * the read the scan of seven days of local transcripts a meter never shows.
 */
export const USAGE_METHOD_NAMES = ["usage", "getUsage", "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"] as const;

/** How long a reading answers before it is read again. */
export const PLAN_USAGE_MAX_AGE_MS = 6 * 60 * 1000;

/** What asking a query for its usage came to. */
export type UsageOutcome =
  | { readonly kind: "read"; readonly response: unknown }
  | { readonly kind: "missing" }
  | { readonly kind: "failed"; readonly message: string };

/** One read of an account: who it is, and what the usage method said. */
export interface UsageProbe {
  readonly identity: AccountIdentity;
  readonly outcome: UsageOutcome;
}

/** A rate-limit verdict a run reported (`plan.limit`), as it folds into a reading. */
export interface PlanLimitVerdict {
  readonly window: string;
  readonly status: "allowed" | "warning" | "rejected";
  readonly utilisation: number | null;
  readonly resetsAt: string | null;
}

/** Asks a live query for its usage through whichever name this SDK build has. Never rejects. */
export const readUsageMethod = async (query: unknown): Promise<UsageOutcome> => {
  if (query === null || typeof query !== "object") return { kind: "missing" };
  const bag = query as Record<string, unknown>;
  const name = USAGE_METHOD_NAMES.find((candidate) => typeof bag[candidate] === "function");
  if (name === undefined) return { kind: "missing" };
  try {
    const method = bag[name] as (options: { skipBehaviors: boolean }) => Promise<unknown>;
    return { kind: "read", response: await method.call(query, { skipBehaviors: true }) };
  } catch (error) {
    return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
  }
};

/** The fixed windows, in the order a client lists them; the rest follow as they come. */
const KNOWN_WINDOWS = Object.keys(PLAN_USAGE_WINDOW_LABELS).filter((window) => window !== "extra_usage");

/** A percentage 0 to 100 as the fraction a reading carries (0 to 1 and beyond); null when absent. */
const fraction = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) / 100 : null);

/** An ISO 8601 instant, normalised; null when absent or unreadable. */
const instant = (value: unknown): string | null => {
  if (typeof value !== "string" || value === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

const windowOf = (window: string, entry: Record<string, unknown>): UsageWindow => ({
  window,
  utilisation: fraction(entry["utilization"]),
  resetsAt: instant(entry["resets_at"]),
});

const NO_LIMITS =
  "No plan limits were reported for this account. That is expected for an API-key login; on a subscription it usually means the stored token cannot read the usage endpoint.";

/**
 * The `/usage` answer as a reading. Known windows first; each per-model
 * bucket (`model_scoped`, a list, not a window) as its own window named
 * after its bucket; usage credits (`extra_usage`, a spend, with no reset);
 * then any window added since, passed through rather than hidden.
 */
export const mapUsageResponse = (raw: unknown, identity: AccountIdentity, readAt: string): UsageReading => {
  const response = isRecord(raw) ? raw : {};
  const limits = response["rate_limits"];
  if (response["rate_limits_available"] !== true || !isRecord(limits)) return { identity, windows: [], readAt, unavailableReason: NO_LIMITS };
  const windows: UsageWindow[] = [];
  for (const name of KNOWN_WINDOWS) {
    const entry = limits[name];
    if (isRecord(entry)) windows.push(windowOf(name, entry));
  }
  const scoped = limits["model_scoped"];
  if (Array.isArray(scoped)) {
    for (const entry of scoped) {
      if (!isRecord(entry) || typeof entry["display_name"] !== "string" || entry["display_name"] === "") continue;
      windows.push(windowOf(`model_scoped:${entry["display_name"]}`, entry));
    }
  }
  const extra = limits["extra_usage"];
  if (isRecord(extra)) windows.push({ window: "extra_usage", utilisation: fraction(extra["utilization"]), resetsAt: null });
  for (const [name, entry] of Object.entries(limits)) {
    if (KNOWN_WINDOWS.includes(name) || name === "model_scoped" || name === "extra_usage") continue;
    if (isRecord(entry)) windows.push(windowOf(name, entry));
  }
  return { identity, windows, readAt };
};

const unavailable = (identity: AccountIdentity, readAt: string, reason: string): UsageReading => ({ identity, windows: [], readAt, unavailableReason: reason });

const readingOf = (probe: UsageProbe, readAt: string): UsageReading => {
  switch (probe.outcome.kind) {
    case "read":
      return mapUsageResponse(probe.outcome.response, probe.identity, readAt);
    case "missing":
      return unavailable(probe.identity, readAt, "This version of the Claude binary does not report plan usage; updating the SDK may enable it.");
    case "failed":
      return unavailable(probe.identity, readAt, `Could not read plan usage: ${probe.outcome.message}`);
  }
};

/** A reading with a run's rate-limit verdict folded into its window: the verdict's use and reset where it says them. */
const foldVerdict = (reading: UsageReading, verdict: PlanLimitVerdict): UsageReading => {
  const before = reading.windows.find((window) => window.window === verdict.window);
  const folded: UsageWindow = {
    window: verdict.window,
    utilisation: verdict.utilisation ?? before?.utilisation ?? null,
    resetsAt: verdict.resetsAt ?? before?.resetsAt ?? null,
    verdict: verdict.status,
  };
  const windows = before === undefined ? [...reading.windows, folded] : reading.windows.map((window) => (window === before ? folded : window));
  // A window a run reported makes the reading available, whatever the read said.
  return { identity: reading.identity, windows, readAt: reading.readAt };
};

export interface PlanUsageReader {
  /** The account's reading: the cached one while it is under six minutes old, else a fresh read, shared with any in flight. */
  read(account: AccountRef): Promise<UsageReading>;
  /** Folds a run's rate-limit verdict into the account's reading, when there is one to fold into. */
  fold(account: AccountRef, verdict: PlanLimitVerdict): void;
}

export interface PlanUsageReaderOptions {
  readonly clock: Pick<Clock, "now">;
  /** Reports each unknown provider window once during this reader's lifetime. */
  readonly diagnostic?: (message: string) => void;
  /** Reads an account once: its identity and its usage. Rejects when the account cannot be identified. */
  readonly probe: (account: AccountRef) => Promise<UsageProbe>;
}

interface Held {
  reading: UsageReading;
  readonly at: number;
}

/**
 * The reader: one reading per account, keyed by its directory (one account
 * per identity per environment, ADR 0018, so this is one per identity too).
 * A failed read is not kept, so the next ask reads again; a reading with no
 * windows for a known reason is, for its six minutes.
 */
export const createPlanUsageReader = (options: PlanUsageReaderOptions): PlanUsageReader => {
  const unknown = new Set<string>();
  const reportUnknown = (window: string) => {
    if (isKnownUsageWindow(window) || unknown.has(window)) return;
    unknown.add(window);
    options.diagnostic?.(`Claude reported an unknown plan-usage window: ${window}`);
  };
  const held = new Map<string, Held>();
  const inFlight = new Map<string, Promise<UsageReading>>();
  /**
   * Verdicts that arrived while a read was in flight, with when: the
   * reading takes those at or after its stamp, and not those the provider
   * answered the read after, whose numbers are newer (#136).
   */
  const arrivedDuring = new Map<string, { readonly verdict: PlanLimitVerdict; readonly at: number }[]>();
  const keyOf = (account: AccountRef): string => account.directory ?? "";

  return {
    read(account) {
      const key = keyOf(account);
      const now = options.clock.now().getTime();
      const cached = held.get(key);
      if (cached !== undefined && now - cached.at < PLAN_USAGE_MAX_AGE_MS) return Promise.resolve(cached.reading);
      const pending = inFlight.get(key);
      if (pending !== undefined) return pending;
      const read = (async () => {
        try {
          const probe = await options.probe(account);
          // Stamped once the provider has answered: that is when the numbers were true.
          const at = options.clock.now();
          const reading = (arrivedDuring.get(key) ?? [])
            .filter((arrived) => arrived.at >= at.getTime())
            .reduce((folded, arrived) => foldVerdict(folded, arrived.verdict), readingOf(probe, at.toISOString()));
          for (const window of reading.windows) reportUnknown(window.window);
          if (probe.outcome.kind !== "failed") held.set(key, { reading, at: at.getTime() });
          return reading;
        } finally {
          inFlight.delete(key);
          arrivedDuring.delete(key);
        }
      })();
      inFlight.set(key, read);
      return read;
    },
    fold(account, verdict) {
      reportUnknown(verdict.window);
      const key = keyOf(account);
      // A read under way takes this verdict unless the provider answers it after the verdict; one that begins after is
      // newer (a verdict with no reading to fold into is dropped for that reason).
      if (inFlight.has(key)) arrivedDuring.set(key, [...(arrivedDuring.get(key) ?? []), { verdict, at: options.clock.now().getTime() }]);
      const cached = held.get(key);
      if (cached !== undefined) cached.reading = foldVerdict(cached.reading, verdict);
    },
  };
};
