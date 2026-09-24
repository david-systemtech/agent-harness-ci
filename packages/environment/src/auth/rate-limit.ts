import type { Clock } from "../serve/clock.js";

/**
 * The rate the unauthenticated exchanges take from one remote address: a
 * burst of `capacity`, refilled evenly over `windowMs`. A chosen default: 10
 * a minute. `/api/bootstrap` uses it now and `/api/pair` with #109.
 */
export const EXCHANGE_RATE = { capacity: 10, windowMs: 60_000 } as const;

export type Take = { readonly ok: true } | { readonly ok: false; readonly retryAfterMs: number };

export interface RateLimiter {
  /** Spends one from `key`'s bucket, or says how long until there is one to spend. */
  take(key: string): Take;
}

export interface RateLimiterOptions {
  readonly clock: Clock;
  readonly capacity?: number;
  readonly windowMs?: number;
}

/** Buckets kept before full ones are forgotten; a full bucket is the same as none. */
const PRUNE_ABOVE = 256;

/**
 * A token bucket per key. Each bucket holds its allowance in milliseconds of
 * refill, so the arithmetic is integral: one exchange costs `windowMs /
 * capacity`, and a full bucket holds `windowMs`.
 */
export const createRateLimiter = (options: RateLimiterOptions): RateLimiter => {
  const capacity = options.capacity ?? EXCHANGE_RATE.capacity;
  const windowMs = options.windowMs ?? EXCHANGE_RATE.windowMs;
  const cost = windowMs / capacity;
  const buckets = new Map<string, { allowance: number; at: number }>();

  const level = (bucket: { allowance: number; at: number }, now: number) => Math.min(windowMs, bucket.allowance + (now - bucket.at));

  return {
    take(key) {
      const now = options.clock.now().getTime();
      if (buckets.size > PRUNE_ABOVE) {
        for (const [other, bucket] of buckets) if (level(bucket, now) >= windowMs) buckets.delete(other);
      }
      const bucket = buckets.get(key) ?? { allowance: windowMs, at: now };
      const allowance = level(bucket, now);
      if (allowance < cost) {
        buckets.set(key, { allowance, at: now });
        return { ok: false, retryAfterMs: Math.ceil(cost - allowance) };
      }
      buckets.set(key, { allowance: allowance - cost, at: now });
      return { ok: true };
    },
  };
};
