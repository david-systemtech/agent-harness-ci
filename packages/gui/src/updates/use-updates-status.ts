import type { CachedAnswer } from "@agent-harness/client-runtime";
import { useMemo } from "react";
import { useObservable, useRuntime } from "../window-context.js";

/**
 * An environment's `updates.status` as the request cache holds it, read
 * again on each step of an update (pending, started, updated, failed,
 * cancelled), which the runtime's cache follows (#344).
 */
export const useUpdatesStatus = (environmentId: string): CachedAnswer<"updates.status"> => {
  const runtime = useRuntime();
  return useObservable(useMemo(() => runtime.requests.cached(environmentId, "updates.status", {}), [runtime, environmentId]));
};
