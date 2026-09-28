import { useEffect, useMemo } from "react";
import { formatTokens, formatUsd, type Clock, type EnvironmentView, type RunState, type Runtime, type SessionProjection } from "@agent-harness/client-runtime";
import { lowerMode, type ContainmentLevel, type KeyActionId } from "@agent-harness/contracts";
import type { Opened } from "../session/use-session.js";
import { useFollow } from "../session/use-session.js";
import { gaugeOf } from "../transcript/plan.js";
import { nameOf } from "../view.js";
import { MODE_BADGES, containmentBadge, elapsedClock, meterCells, readingsOf, spendOf, windowOut, workingWords, type Styled } from "./line.js";
import type { StatusLineOne, StatusLineTwo } from "./status-line.js";

/**
 * The status line's data (docs/specs/tui.md, "Status, usage, pickers"),
 * read from the runtime: the session's summary and runs from
 * `projections.session`, its account's label from `projections.accounts`,
 * the plan windows of its account's identity from `projections.usage`, the
 * containment default and the hand-off recommendation from the request cache
 * (`permissions.settings.get`, `accounts.handoff.recommend`), each followed
 * while the line shows it. What this terminal chose for the session's next
 * runs (a model and effort from `/model`, a containment level it set) is
 * handed in.
 */

/** The model and effort this terminal sends with the session's next `runs.start` (`/model`). */
export interface RunChoice {
  readonly model: string;
  readonly effort: string | null;
}

export interface StatusInputs {
  readonly runtime: Runtime;
  readonly clock: Clock;
  readonly request: () => void;
  /** The session's environment, else the header's. */
  readonly environment: EnvironmentView | undefined;
  readonly opened: Opened | null;
  readonly projection: SessionProjection | undefined;
  readonly runState: RunState | undefined;
  readonly liveRunId: string | undefined;
  /** The session's provider steers a message sent during a run into it. */
  readonly steers: boolean;
  readonly choice: RunChoice | undefined;
  /** The session's own containment level, as this terminal set it; undefined when it has not. */
  readonly containment: ContainmentLevel | undefined;
  /** The account this terminal handed the session off onto, which its summary names only once a run of it has used it. */
  readonly forkedOnto: string | undefined;
  /** The columns the line has. */
  readonly width: number;
  /** The composer has the keys: the line then says them. */
  readonly composerKeys: boolean;
  readonly keys: (action: KeyActionId) => string;
}

export interface StatusView {
  readonly one: StatusLineOne;
  readonly two: StatusLineTwo;
}

export const useStatus = (inputs: StatusInputs): StatusView => {
  const { runtime, clock, request, environment, opened, projection, keys } = inputs;
  const environmentId = environment?.environmentId;
  const summary = projection?.summary ?? null;
  const accountId = opened ? (summary?.accountId ?? inputs.forkedOnto ?? null) : null;

  const accounts = useMemo(() => (environmentId !== undefined ? runtime.projections.accounts(environmentId) : undefined), [runtime, environmentId]);
  useFollow(accounts, request);
  useFollow(opened ? runtime.projections.usage : undefined, request);
  const permissions = useMemo(
    () => (environmentId !== undefined ? runtime.requests.cached(environmentId, "permissions.settings.get", {}) : undefined),
    [runtime, environmentId],
  );
  useFollow(permissions, request);
  const recommendation = useMemo(
    () => (environmentId !== undefined && accountId !== null ? runtime.requests.cached(environmentId, "accounts.handoff.recommend", { fromAccountId: accountId }) : undefined),
    [runtime, environmentId, accountId],
  );
  useFollow(recommendation, request);

  const lastRun = projection?.runs.at(-1);
  const live = inputs.liveRunId !== undefined || inputs.runState === "starting";
  const liveRun = inputs.liveRunId !== undefined ? projection?.runs.find((run) => run.runId === inputs.liveRunId) : undefined;
  const elapsed = liveRun && environmentId !== undefined ? runtime.environmentNow(environmentId).getTime() - Date.parse(liveRun.startedAt) : undefined;
  // The clock moves on a second at a time while a run is live: one frame per second, and none while nothing runs.
  const second = elapsed === undefined ? undefined : Math.floor(elapsed / 1000);
  const untilNext = elapsed === undefined ? undefined : 1000 - (((elapsed % 1000) + 1000) % 1000);
  useEffect(() => {
    if (untilNext === undefined) return;
    const timer = clock.setTimeout(request, untilNext);
    return () => timer.cancel();
    // Armed again each second, from the frame that drew the second before.
  }, [clock, request, second]);

  const badge: Styled = environment ? { text: `${environment.icon ?? "●"} ${nameOf(environment)}`, color: environment.colour ?? "cyan" } : { text: "no environment", dim: true };
  const hints = (): string | undefined => {
    if (!inputs.composerKeys) return undefined;
    if (!opened) return `${keys("app.interruptOrQuit")} quits · ${keys("app.help")} keys · /pair · /environment · /resume · /new`;
    return live
      ? `${keys("composer.send")} ${inputs.steers ? "steers" : "queues"} · ${keys("app.interrupt")} interrupts · ${keys("app.pager.open")} pager · ${keys("app.help")} keys`
      : `${keys("composer.send")} sends · ${keys("app.pager.open")} pager · ${keys("app.help")} keys`;
  };

  if (!opened || environmentId === undefined) {
    return {
      one: { parts: [badge, { text: "no session open", dim: true }], readings: [] },
      two: { kind: "working", activity: undefined, details: [], hints: hints() },
    };
  }

  const label = accountId === null ? undefined : (accounts?.read().value?.find((account) => account.id === accountId)?.label ?? accountId);
  const model = inputs.choice ?? (lastRun ? { model: lastRun.model, effort: lastRun.effort } : summary?.model ? { model: summary.model, effort: null } : undefined);
  const ceiling = environment?.ceiling ?? null;
  // A session with no mode of its own runs in the attended default, acceptEdits, lowered to the ceiling (a lowered default is no clamp).
  const mode = summary?.mode ?? lowerMode("acceptEdits", ceiling ?? "acceptEdits");
  const containmentDefault = permissions?.read().result?.values["permissions.containment.default"];
  const containment =
    inputs.containment !== undefined ? containmentBadge(inputs.containment, false) : containmentDefault !== undefined ? containmentBadge(containmentDefault, true) : undefined;
  const gauge = runtime.projections.usage.read().gauges;
  const one: StatusLineOne = {
    parts: [
      badge,
      label !== undefined ? { text: label, bold: true } : { text: "default account", dim: true },
      model ? { text: model.effort !== null ? `${model.model} ${model.effort}` : model.model } : { text: "default model", dim: true },
      MODE_BADGES[mode],
      ...(containment ? [containment] : []),
    ],
    readings: readingsOf(gaugeOf(gauge, environmentId, accountId), meterCells(inputs.width)),
  };

  const recommended = recommendation?.read().result;
  if (!live && windowOut(recommended) && recommended) {
    return { one, two: { kind: "offer", text: `${recommended.message} · ${keys("app.handoff")} or /handoff` } };
  }
  const shown = liveRun ?? lastRun;
  const spend = shown ? spendOf(shown.usage) : undefined;
  const details = [
    ...(elapsed !== undefined ? [elapsedClock(elapsed)] : []),
    ...(spend ? [`${formatTokens(spend.tokens)} tok`, ...(spend.costUsd !== null ? [formatUsd(spend.costUsd)] : [])] : []),
  ];
  const activity: Styled =
    inputs.runState === "parked"
      ? { text: "waiting for you", color: "yellow" }
      : inputs.runState === "starting"
        ? { text: "starting…" }
        : live
          ? { text: workingWords(projection, inputs.liveRunId) }
          : { text: "idle", dim: true };
  return { one, two: { kind: "working", activity, details, hints: hints() } };
};
