import type { SetupView } from "@agent-harness/client-runtime";
import { useEffect, useMemo } from "react";
import { useFollowed, useRuntime } from "../window-context.js";

/** The checklist of the environment `environmentId` (`projections.setup`), followed while the component is mounted; undefined without one. */
export const useSetupView = (environmentId: string | undefined): SetupView | undefined => {
  const runtime = useRuntime();
  return useFollowed(useMemo(() => (environmentId === undefined ? undefined : runtime.projections.setup(environmentId)), [runtime, environmentId]));
};

/**
 * Checks every step of the environment as Set up opens on it, and again as
 * it is pointed at another (ADR 0031: a client calls `setup.check` when Set
 * up opens), until the `setup` subscription is served everywhere (#88).
 */
export const useCheckOnOpen = (environmentId: string | undefined): void => {
  const runtime = useRuntime();
  useEffect(() => {
    if (environmentId !== undefined) void runtime.setup.check(environmentId);
  }, [runtime, environmentId]);
};
