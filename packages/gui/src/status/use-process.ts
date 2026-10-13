import { useMemo } from "react";
import { useFollowed, useRuntime } from "../window-context.js";

/** One shared, notice-refreshed read per environment, followed by every visible indicator. */
export const useProviderProcess = (environmentId: string, sessionId: string) => {
  const runtime = useRuntime();
  const answer = useFollowed(useMemo(() => runtime.requests.cached(environmentId, "providers.processes.status", {}), [runtime, environmentId]));
  return answer?.result == null ? undefined : answer.result.processes.find((process) => process.sessionId === sessionId.toLowerCase()) ?? null;
};
