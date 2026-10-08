import { homeEnvironment, homedChecks, type SetupView } from "@agent-harness/client-runtime";
import { settingsRow, type SettingsRowId, type StepId } from "@agent-harness/contracts";
import { useEffect, useMemo } from "react";
import { usePickedEnvironment } from "../settings/settings-window.js";
import { useClock, useFollowed, useObservable, useRuntime } from "../window-context.js";

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

/** The least time between two checks of a shown step the window's focus asks for (#1860). */
const FOCUS_CHECK_MS = 10_000;

/**
 * Checks the step Set up shows again each time the window regains focus, at
 * most once in {@link FOCUS_CHECK_MS}: a cause fixed outside the app, such as
 * installing Tailscale or opening Chrome, shows without Check again (#1860).
 */
export const useCheckOnFocus = (environmentId: string | undefined, step: StepId | undefined): void => {
  const runtime = useRuntime();
  const clock = useClock();
  useEffect(() => {
    if (environmentId === undefined || step === undefined) return;
    let last: number | undefined;
    const check = () => {
      const now = clock.now().getTime();
      if (last !== undefined && now - last < FOCUS_CHECK_MS) return;
      last = now;
      void runtime.setup.check(environmentId, step);
    };
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [runtime, clock, environmentId, step]);
};

/**
 * Checks the steps a row of Settings is home to as its pane opens (ADR
 * 0031: a client calls `setup.check` when a step's pane opens), each alone,
 * on the environments the pane shows: an `environment` row's picked one, an
 * `everywhere` row's every one, a `client` row's home environment; again as
 * it is pointed at another. The results held show meanwhile.
 */
export const useCheckHomedSteps = (row: SettingsRowId): void => {
  const runtime = useRuntime();
  const picked = usePickedEnvironment();
  const environments = useObservable(runtime.projections.environments);
  const { scope } = settingsRow(row);
  const shown = scope === "everywhere" ? environments : scope === "environment" ? [picked] : [homeEnvironment(environments)];
  // The environments' ids, joined: the list is a new array whenever any environment's state changes.
  const ids = shown.flatMap((view) => (view === undefined ? [] : [view.environmentId])).join(" ");
  useEffect(() => {
    for (const environmentId of ids === "" ? [] : ids.split(" ")) for (const step of homedChecks(row)) void runtime.setup.check(environmentId, step);
  }, [runtime, row, ids]);
};
