import { adapterOf, type SessionProjection } from "@agent-harness/client-runtime";
import type { AdapterCapabilities } from "@agent-harness/contracts";
import { useMemo } from "react";
import { useObservable, useRuntime } from "../window-context.js";

/**
 * The session's provider, once `providers.list` has answered (both in the
 * request cache): the environment's only one, else its account's. Undefined
 * while it is not known, when nothing is refused on its say-so.
 */
export const useProvider = (environmentId: string, projection: Pick<SessionProjection, "summary">): AdapterCapabilities | undefined => {
  const runtime = useRuntime();
  const providers = useObservable(useMemo(() => runtime.requests.cached(environmentId, "providers.list", {}), [runtime, environmentId]));
  const accounts = useObservable(useMemo(() => runtime.projections.accounts(environmentId), [runtime, environmentId]));
  return adapterOf(projection.summary?.accountId ?? null, accounts.value, providers.result?.providers ?? null) ?? undefined;
};
