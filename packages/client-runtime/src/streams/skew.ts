import type { Clock } from "../platform.js";
import type { Retention } from "./cache.js";

/**
 * Each environment's clock as this client reckons it (docs/specs/client-runtime.md,
 * "Subscriptions, cursor cache and snapshots"): `hello` carries the
 * environment's time, and the difference from this client's clock when it
 * arrives is the skew, kept per environment (in its meta document, so it
 * holds offline too). Snooze-until, prompt TTLs and anything else the
 * environment stamped are compared with `now(environmentId)`, never with the
 * client's clock alone. The estimate ignores the socket's latency, which is
 * well under the minute a snooze or a TTL is read at.
 */
export interface Skew {
  /** `hello` said the environment's time is `serverTime`, now. */
  record(environmentId: string, serverTime: string): void;
  /** The environment's clock minus this client's, in milliseconds; 0 when never measured. */
  offset(environmentId: string): number;
  /** The environment's time now, as this client reckons it. */
  now(environmentId: string): Date;
}

export const createSkew = (clock: Clock, retention: Pick<Retention, "skew" | "setSkew">, report: (error: unknown) => void): Skew => {
  const offset = (environmentId: string) => retention.skew(environmentId) ?? 0;
  return {
    record(environmentId, serverTime) {
      const skewMs = Date.parse(serverTime) - clock.now().getTime();
      if (Number.isFinite(skewMs)) void retention.setSkew(environmentId, skewMs).catch(report);
    },
    offset,
    now: (environmentId) => new Date(clock.now().getTime() + offset(environmentId)),
  };
};
