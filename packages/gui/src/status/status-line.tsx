import {
  BETWEEN_ENVIRONMENTS,
  MODE_BADGE_WORDS,
  clampWords,
  elapsedClock,
  formatTokens,
  formatUsd,
  gaugeOf,
  liveRunIdOf,
  readingsOf,
  statusOf,
  type Clock,
  type EnvironmentView,
  type Pressure,
  type Reading,
  type StatusFacts,
} from "@agent-harness/client-runtime";
import { useEffect, useMemo, useReducer } from "react";
import { useSlashCommand } from "../composer/slash-commands.js";
import { usePaneLine } from "../session/pane-line.js";
import { THIS_MACHINE } from "../frame/sidebar-region.js";
import { environmentColour } from "../theme/paint.js";
import { classes } from "../ui/classes.js";
import { Button } from "../ui/index.js";
import { useClock, useFollowed, useObservable, useRuntime } from "../window-context.js";
import { useHandoffPicker } from "./pane-dialogs.js";
import { AccountPicker, ContainmentPicker, ModePicker, ModelPicker } from "./pickers.js";
import { useHandedOnto, useModelChoice } from "./run-choices.js";
import { RunInfo } from "./run-info.js";

export interface StatusLineProps {
  readonly environmentId: string;
  readonly sessionId: string;
}

/**
 * The status line under a session's composer (docs/specs/gui.md, "A session
 * pane"; story 12; #402), saying what the client runtime's rule says
 * (`statusOf`, which the terminal UI's status line says too):
 *
 * - **What the next run goes out as**: the environment's badge (its icon in
 *   its colour's token, and its name), the session's account (label and
 *   identity), model and effort, the mode badge with its clamp, and
 *   containment as set or the environment's default marked so; the account,
 *   model, mode and containment are each a picker's button.
 * - **The plan gauge**, at the right: the windows of the session's account
 *   identity, pooled across environments (`projections.usage`), each with its
 *   bar and percent, a refused window marked out.
 * - **What the run is doing**: its activity, its elapsed time in the
 *   environment's time (drawn again once a second while it runs, never
 *   otherwise), its tokens and cost, the last run's once it has ended; or,
 *   while the account's window is out and no run is live, the hand-off offer
 *   in `accounts.handoff.recommend`'s words, which opens the hand-off picker.
 *   Run info (Mod+I) sits at its end. `/handoff` opens the hand-off picker
 *   whenever; naming another environment, it says that is milestone 2's.
 */
export const StatusLine = ({ environmentId, sessionId }: StatusLineProps) => {
  const runtime = useRuntime();
  const environments = useObservable(runtime.projections.environments);
  const environment = environments.find((view) => view.environmentId === environmentId);
  const projection = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const runs = useObservable(useMemo(() => runtime.projections.runs.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const usage = useObservable(runtime.projections.usage);
  const permissions = useFollowed(useMemo(() => runtime.requests.cached(environmentId, "permissions.settings.get", {}), [runtime, environmentId]));
  const [choice] = useModelChoice(environmentId, sessionId);
  const handedOnto = useHandedOnto(environmentId, sessionId);
  const accountId = projection.summary?.accountId ?? handedOnto ?? null;
  const recommendation = useFollowed(
    useMemo(() => (accountId === null ? undefined : runtime.requests.cached(environmentId, "accounts.handoff.recommend", { fromAccountId: accountId })), [runtime, environmentId, accountId]),
  );
  const ceiling = environment?.ceiling ?? null;
  const facts = statusOf({
    projection,
    runState: runs.state,
    liveRunId: liveRunIdOf(projection, runs),
    ceiling,
    choice,
    forkedOnto: handedOnto,
    containmentDefault: permissions?.result?.values["permissions.containment.default"],
    recommendation: recommendation?.result,
    now: () => runtime.environmentNow(environmentId).getTime(),
  });
  useSecondTicks(useClock(), facts.elapsedMs);
  const openHandoff = useHandoffPicker();
  const [, say] = usePaneLine();
  // `/handoff <environment>` naming another environment is milestone 2's (ADR 0005), as the terminal UI answers it.
  useSlashCommand("handoff", (named) =>
    named === "" || named.toLowerCase() === (environment?.name ?? "").toLowerCase() ? openHandoff() : say(`Not handed off to ${named}: ${BETWEEN_ENVIRONMENTS}.`),
  );

  return (
    <section aria-label="Status line" className="flex shrink-0 flex-col gap-1 border-t border-hairline px-4 py-2 text-xs text-ink-muted">
      <div className="flex min-w-0 items-center gap-1">
        <EnvironmentBadge view={environment} />
        <AccountPicker environmentId={environmentId} sessionId={sessionId} accountId={facts.accountId} />
        <ModelPicker environmentId={environmentId} sessionId={sessionId} accountId={facts.accountId} model={facts.model} />
        <ModePicker
          environmentId={environmentId}
          sessionId={sessionId}
          value={`${MODE_BADGE_WORDS[facts.mode.mode]}${facts.mode.clampedFrom !== null ? ` ${clampWords(facts.mode.clampedFrom)}` : ""}`}
        >
          <span className={facts.mode.mode === "bypassPermissions" ? "font-semibold text-signal" : "text-ink"}>{MODE_BADGE_WORDS[facts.mode.mode]}</span>
          {facts.mode.clampedFrom !== null && <span className="text-amber"> {clampWords(facts.mode.clampedFrom)}</span>}
        </ModePicker>
        <ContainmentPicker environmentId={environmentId} sessionId={sessionId} containment={facts.containment} />
        <Gauge readings={readingsOf(gaugeOf(usage.gauges, environmentId, facts.accountId))} />
      </div>
      <div className="flex min-w-0 items-center gap-2">
        {facts.offer !== undefined ? <HandoffOffer offer={facts.offer} /> : <RunLine facts={facts} />}
        <RunInfo environmentId={environmentId} sessionId={sessionId} />
      </div>
    </section>
  );
};

/** Draws the component again as the live run's clock moves on a second: one frame a second while a run is live, none otherwise. */
const useSecondTicks = (clock: Clock, elapsed: number | undefined): void => {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const second = elapsed === undefined ? undefined : Math.floor(elapsed / 1000);
  const untilNext = elapsed === undefined ? undefined : 1000 - (((elapsed % 1000) + 1000) % 1000);
  useEffect(() => {
    if (untilNext === undefined) return;
    const timer = clock.setTimeout(redraw, untilNext);
    return () => timer.cancel();
    // Armed again each second, from the frame that drew the second before.
  }, [clock, second]);
};

/**
 * The environment's badge: its icon (a dot until it has one) in its colour's
 * token (ADR 0023: the colour is a name, drawn with the theme's token for it),
 * then its name.
 */
const EnvironmentBadge = ({ view }: { readonly view: EnvironmentView | undefined }) => {
  const colour = environmentColour(view?.colour ?? null);
  return (
    <span className="flex shrink-0 items-center gap-1 pr-1 font-medium text-ink">
      <span aria-hidden="true" style={colour === undefined ? undefined : { color: colour }} className={colour === undefined ? "text-cyan" : undefined}>
        {view?.icon ?? "●"}
      </span>
      <span>{view?.name ?? THIS_MACHINE}</span>
    </span>
  );
};

/** A window's bar and percent by its pressure: out and high in the danger colour, raised in the warning's, low in success's. */
const BAR_TONES: Readonly<Record<Pressure, string>> = { out: "bg-signal", high: "bg-signal", raised: "bg-amber", low: "bg-sage" };
const VALUE_TONES: Readonly<Record<Pressure, string>> = { out: "font-semibold text-signal", high: "font-semibold text-signal", raised: "text-amber", low: "text-ink-muted" };

/**
 * The plan gauge: each window of the session's account identity, pooled
 * across environments, as its short name, a bar lit for any use and full
 * only when the window is, and its percent, `out` when the provider refuses
 * it. Nothing while the account has no reading.
 */
const Gauge = ({ readings }: { readonly readings: readonly Reading[] }) =>
  readings.length === 0 ? null : (
    <span role="group" aria-label="Plan usage" className="ml-auto flex shrink-0 items-center gap-3">
      {readings.map((reading) => (
        <span key={reading.window} className="flex items-center gap-1">
          {`${reading.label} `}
          {reading.utilisation !== null && (
            <span aria-hidden="true" className="h-1.5 w-10 overflow-hidden rounded-full bg-wash-strong">
              <span className={classes("block h-full", reading.pressure === undefined ? "bg-ink-faint" : BAR_TONES[reading.pressure])} style={{ width: `${barWidth(reading.utilisation)}%` }} />
            </span>
          )}
          <span className={reading.pressure === undefined ? "text-ink-faint" : VALUE_TONES[reading.pressure]}>{reading.value}</span>
        </span>
      ))}
    </span>
  );

/** How much of a bar a window lights, in percent: some for any use, and all only when the window is full. */
const barWidth = (utilisation: number): number => {
  const percent = utilisation * 100;
  if (percent <= 0) return 0;
  if (percent >= 100) return 100;
  return Math.min(Math.max(percent, 8), 92);
};

const ACTIVITY_TONES: Readonly<Record<StatusFacts["activity"]["kind"], string>> = { waiting: "text-amber", starting: "text-ink", working: "text-ink", idle: "text-ink-faint" };

/** What the run is doing: its activity, then its elapsed time while it runs, and the tokens and dollars of the live run, else of the last. */
const RunLine = ({ facts }: { readonly facts: StatusFacts }) => {
  const { activity, elapsedMs, spend } = facts;
  const details = [
    ...(elapsedMs !== undefined ? [elapsedClock(elapsedMs)] : []),
    ...(spend ? [`${formatTokens(spend.tokens)} tok`, ...(spend.costUsd !== null ? [formatUsd(spend.costUsd)] : [])] : []),
  ];
  return (
    <p className="min-w-0 flex-1 truncate">
      <span className={ACTIVITY_TONES[activity.kind]}>{activity.words}</span>
      {details.map((detail) => ` · ${detail}`).join("")}
    </p>
  );
};

/** The hand-off offer: the recommendation's sentence, and the button that opens the hand-off picker. */
const HandoffOffer = ({ offer }: { readonly offer: string }) => {
  const openHandoff = useHandoffPicker();
  return (
    <p className="flex min-w-0 flex-1 items-center gap-2 text-amber">
      <span className="min-w-0 truncate">{offer}</span>
      <Button className="h-6 shrink-0 px-2 text-xs" onClick={openHandoff}>
        Hand off…
      </Button>
    </p>
  );
};
