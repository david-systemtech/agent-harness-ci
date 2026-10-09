import { useEffect, useMemo } from "react";
import {
  clampWords,
  elapsedClock,
  formatTokens,
  formatUsd,
  gaugeOf,
  modelChoiceWords,
  modelsOf,
  statusOf,
  type Clock,
  type EnvironmentView,
  type RunState,
  type Runtime,
  type SessionProjection,
} from "@agent-harness/client-runtime";
import type { ContainmentLevel, KeyActionId } from "@agent-harness/contracts";
import { TERMINAL_ROLES } from "@agent-harness/theme";
import type { Badge } from "../rail/badge.js";
import type { Opened } from "../session/use-session.js";
import { useFollow } from "../session/use-session.js";
import { nameOf } from "../view.js";
import { MODE_BADGES, containmentBadge, meterCells, readingsOf, type Styled } from "./line.js";
import type { StatusLineOne, StatusLineTwo } from "./status-line.js";

/**
 * The status line's data (docs/specs/tui.md, "Status, usage, pickers"),
 * read from the runtime: the session's summary and runs from
 * `projections.session`, its account's label from `projections.accounts`,
 * the plan windows of its account's identity from `projections.usage`, the
 * containment default and the hand-off recommendation from the request cache
 * (`permissions.settings.get`, `accounts.handoff.recommend`), each followed
 * while the line shows it; the model and effort `/model` chose are the
 * summary's (`runChoice`, #1961). What this terminal set for the session's
 * next runs (a containment level) is handed in. What the line says is the client runtime's rule (`statusOf`,
 * which the desktop window's status line says too; #402).
 */

export interface StatusInputs {
  readonly runtime: Runtime;
  readonly clock: Clock;
  readonly request: () => void;
  /** The session's environment, else the header's. */
  readonly environment: EnvironmentView | undefined;
  /** That environment's badge: its two letters and its colour, which its name is drawn in too. */
  readonly badge: Badge | undefined;
  readonly opened: Opened | null;
  readonly projection: SessionProjection | undefined;
  readonly runState: RunState | undefined;
  readonly liveRunId: string | undefined;
  /** The session's provider steers a message sent during a run into it. */
  readonly steers: boolean;
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

  const facts =
    opened && environmentId !== undefined && projection
      ? statusOf({
          projection,
          runState: inputs.runState,
          liveRunId: inputs.liveRunId,
          ceiling: environment?.ceiling ?? null,
          forkedOnto: inputs.forkedOnto,
          containmentSet: inputs.containment,
          containmentDefault: permissions?.read().result?.values["permissions.containment.default"],
          recommendation: recommendation?.read().result,
          now: () => runtime.environmentNow(environmentId).getTime(),
        })
      : undefined;
  const elapsed = facts?.elapsedMs;
  // The clock moves on a second at a time while a run is live: one frame per second, and none while nothing runs.
  const second = elapsed === undefined ? undefined : Math.floor(elapsed / 1000);
  const untilNext = elapsed === undefined ? undefined : 1000 - (((elapsed % 1000) + 1000) % 1000);
  useEffect(() => {
    if (untilNext === undefined) return;
    const timer = clock.setTimeout(request, untilNext);
    return () => timer.cancel();
    // Armed again each second, from the frame that drew the second before.
  }, [clock, request, second]);

  // The environment's badge and name in its colour (#327); the terminal UI draws no icon (#19).
  const badge: Styled = !environment
    ? { text: "no environment", dim: true }
    : inputs.badge
      ? { text: `${inputs.badge.abbreviation} ${nameOf(environment)}`, color: inputs.badge.colour }
      : { text: nameOf(environment) };
  const live = facts?.live ?? false;
  const hints = (): string | undefined => {
    if (!inputs.composerKeys) return undefined;
    if (!opened) return `${keys("app.interruptOrQuit")} quits · ${keys("app.help")} keys · /pair · /environment · /resume · /new`;
    return live
      ? `${keys("composer.send")} ${inputs.steers ? "steers" : "queues"} · ${keys("app.interrupt")} interrupts · ${keys("app.pager.open")} pager · ${keys("app.help")} keys`
      : `${keys("composer.send")} sends · ${keys("app.pager.open")} pager · ${keys("app.help")} keys`;
  };

  if (!facts || environmentId === undefined) {
    return {
      one: { parts: [badge, { text: "no session open", dim: true }], readings: [] },
      two: { kind: "working", activity: undefined, details: [], hints: hints() },
    };
  }

  const label = facts.accountId === null ? undefined : (accounts?.read().value?.find((account) => account.id === facts.accountId)?.label ?? facts.accountId);
  const { model, mode, containment } = facts;
  // The provider's name for a model the display table does not know, from the catalogue a picker last read; reading it never fetches.
  const listed = model && modelsOf(runtime.projections.models(environmentId).read().value ?? [], facts.accountId).find((entry) => entry.id === model.model);
  const modeBadge = MODE_BADGES[mode.mode];
  const one: StatusLineOne = {
    parts: [
      badge,
      label !== undefined ? { text: label, bold: true } : { text: "default account", dim: true },
      model ? { text: modelChoiceWords(model, listed?.label) } : { text: "default model", dim: true },
      mode.clampedFrom === null ? modeBadge : { ...modeBadge, text: `${modeBadge.text} ${clampWords(mode.clampedFrom)}` },
      ...(containment ? [containmentBadge(containment.level, containment.isDefault)] : []),
    ],
    readings: readingsOf(gaugeOf(runtime.projections.usage.read().gauges, environmentId, facts.accountId), meterCells(inputs.width)),
  };

  if (facts.offer !== undefined) return { one, two: { kind: "offer", text: `${facts.offer} · ${keys("app.handoff")} or /handoff` } };
  const details = [
    ...(elapsed !== undefined ? [elapsedClock(elapsed)] : []),
    ...(facts.spend ? [`${formatTokens(facts.spend.tokens)} tok`, ...(facts.spend.costUsd !== null ? [formatUsd(facts.spend.costUsd)] : [])] : []),
  ];
  const { activity } = facts;
  const styled: Styled =
    activity.kind === "waiting" ? { text: activity.words, color: TERMINAL_ROLES.warning } : activity.kind === "idle" ? { text: activity.words, dim: true } : { text: activity.words };
  return { one, two: { kind: "working", activity: styled, details, hints: hints() } };
};
