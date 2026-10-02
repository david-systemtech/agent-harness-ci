import { COUNTDOWN_TICK_MS } from "@agent-harness/client-runtime";
import { useEffect, useReducer } from "react";
import { useClock, useRuntime } from "./window-context.js";

/**
 * How long is left until `expiresAt`, a time on the environment's clock, in
 * milliseconds as this window reckons that clock (`environmentNow`), drawn
 * again every second while time is left; undefined without one. A parked
 * prompt's TTL and a sign-in's ten minutes (#575) count down this way.
 */
export const useEnvironmentCountdown = (environmentId: string, expiresAt: string | null | undefined): number | undefined => {
  const runtime = useRuntime();
  const clock = useClock();
  const [tick, redraw] = useReducer((count: number) => count + 1, 0);
  const remaining = expiresAt === null || expiresAt === undefined ? undefined : Date.parse(expiresAt) - runtime.environmentNow(environmentId).getTime();
  const running = remaining !== undefined && remaining > 0;
  useEffect(() => {
    if (!running) return;
    const timer = clock.setTimeout(redraw, COUNTDOWN_TICK_MS);
    return () => timer.cancel();
  }, [clock, running, tick]);
  return remaining;
};
