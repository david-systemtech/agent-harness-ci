import { homeEnvironment, homedChecks, writable, type RefusedAnswer, type RequestAnswer, type Runtime, type SetupView, type Writable } from "@agent-harness/client-runtime";
import { STEP_ORDER, settingsRow, type RegisteredStepId, type SettingsRowId, type StepId } from "@agent-harness/contracts";
import { useEffect, useMemo } from "react";
import { usePickedEnvironment } from "../settings/settings-window.js";
import { useClock, useFollowed, useObservable, useRuntime } from "../window-context.js";

/** The checklist of the environment `environmentId` (`projections.setup`), followed while the component is mounted; undefined without one. */
export const useSetupView = (environmentId: string | undefined): SetupView | undefined => {
  const runtime = useRuntime();
  return useFollowed(useMemo(() => (environmentId === undefined ? undefined : runtime.projections.setup(environmentId)), [runtime, environmentId]));
};

/** This window's last `setup.check` of a step: when it was asked, on the environment's clock, and its refusal if it did not run. */
interface AskedCheck {
  readonly askedAt: number;
  readonly refusal: RefusedAnswer | undefined;
}

/** This window's last check of each step, by `${environmentId} ${step}`, held per runtime. */
const ASKED = new WeakMap<Runtime, Writable<ReadonlyMap<string, AskedCheck>>>();
const askedOf = (runtime: Runtime): Writable<ReadonlyMap<string, AskedCheck>> => {
  const held = ASKED.get(runtime) ?? writable<ReadonlyMap<string, AskedCheck>>(new Map());
  ASKED.set(runtime, held);
  return held;
};

/**
 * `setup.check` of `step`, or of every step, as this window asks it
 * (setup-copy.md §3: a failed check is said, never silent; #1840): a
 * refusal is kept for each step it asked about, which that step's status
 * says until a check of it runs. An answer never overwrites one to a
 * check asked after it, so a slow refusal leaves a newer success standing.
 */
export const checkSetup = async (runtime: Runtime, environmentId: string, step?: RegisteredStepId): Promise<RequestAnswer<"setup.check">> => {
  const askedAt = runtime.environmentNow(environmentId).getTime();
  const answer = await runtime.setup.check(environmentId, step);
  const keys = (step === undefined ? STEP_ORDER : [step]).map((id) => `${environmentId} ${id}`);
  askedOf(runtime).update((held) => {
    const next = new Map(held);
    for (const key of keys) {
      if ((next.get(key)?.askedAt ?? -Infinity) > askedAt) continue;
      next.set(key, { askedAt, refusal: answer.ok ? undefined : answer.error });
    }
    return next;
  });
  return answer;
};

/**
 * Why this window's last check of `step` on the environment did not run;
 * undefined once one has, or once the step's result, `checkedAt`, was
 * checked after it was asked (the environment's own pass, or another
 * client's check).
 */
export const useCheckRefusal = (environmentId: string, step: StepId, checkedAt: string | undefined): RefusedAnswer | undefined => {
  const asked = useObservable(askedOf(useRuntime())).get(`${environmentId} ${step}`);
  if (asked?.refusal === undefined) return undefined;
  return checkedAt !== undefined && Date.parse(checkedAt) > asked.askedAt ? undefined : asked.refusal;
};

/**
 * Checks every step of the environment as Set up opens on it, and again as
 * it is pointed at another (ADR 0031: a client calls `setup.check` when Set
 * up opens), until the `setup` subscription is served everywhere (#88).
 */
export const useCheckOnOpen = (environmentId: string | undefined): void => {
  const runtime = useRuntime();
  useEffect(() => {
    if (environmentId !== undefined) void checkSetup(runtime, environmentId);
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
      void checkSetup(runtime, environmentId, step);
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
    for (const environmentId of ids === "" ? [] : ids.split(" ")) for (const step of homedChecks(row)) void checkSetup(runtime, environmentId, step);
  }, [runtime, row, ids]);
};
