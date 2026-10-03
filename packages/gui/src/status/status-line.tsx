import {
  BETWEEN_ENVIRONMENTS,
  MODE_BADGE_WORDS,
  clampWords,
  elapsedClock,
  formatTokens,
  formatUsd,
  liveRunIdOf,
  statusOf,
  type Clock,
  type StatusFacts,
} from "@agent-harness/client-runtime";
import { ArrowRightLeft, CircleHelp, ShieldQuestion } from "lucide-react";
import { useEffect, useMemo, useReducer } from "react";
import { useSlashCommand } from "../composer/slash-commands.js";
import { usePaneLine } from "../session/pane-line.js";
import { EnvironmentBadge } from "../connections/environment-badge.js";
import { Button, Tooltip } from "../ui/index.js";
import { useClock, useFollowed, useObservable, useRuntime } from "../window-context.js";
import { useHandoffPicker } from "./pane-dialogs.js";
import { AccountPicker, ContainmentPicker, ModePicker, ModelPicker, modeLabel } from "./pickers.js";
import { useHandedOnto, useModelChoice } from "./run-choices.js";
import { SessionBrowserPicker } from "../browser/session-picker.js";
import { UsageMeter } from "./usage-meter.js";
import { SessionContextMeter } from "./context-meter.js";

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
 *   used-share ring, a refused window named in its tooltip and details.
 * - **What the run is doing**: its activity, its elapsed time in the
 *   environment's time (drawn again once a second while it runs, never
 *   otherwise), its tokens and cost, the last run's once it has ended; or,
 *   while the account's window is out and no run is live, the hand-off offer
 *   in `accounts.handoff.recommend`'s words, which opens the hand-off picker.
 *   Run info (Mod+I) is the pane's caption's. `/handoff` opens the hand-off
 *   picker whenever; naming another environment, it says that is milestone 2's.
 */
export const StatusLine = ({ environmentId, sessionId }: StatusLineProps) => {
  const runtime = useRuntime();
  const environments = useObservable(runtime.projections.environments);
  const environment = environments.find((view) => view.environmentId === environmentId);
  const projection = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const runs = useObservable(useMemo(() => runtime.projections.runs.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
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
    <section aria-label="Status line" className="flex min-h-7 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-1 text-2xs text-ink-muted">
      <div className="flex min-w-0 grow basis-[352px] flex-wrap items-center gap-x-2 gap-y-1">
        <span data-status-chip className="inline-flex h-[22px] max-w-[240px] items-center overflow-hidden rounded-md bg-wash px-1.5 [&_svg]:size-3 [&>span]:min-w-0 [&>span>span]:truncate" title={`${environment?.name ?? "This machine"}: ${environment?.phase ?? "connecting"}`}><EnvironmentBadge view={environment} /></span>
        <AccountPicker environmentId={environmentId} sessionId={sessionId} accountId={facts.accountId} />
        <ModelPicker environmentId={environmentId} sessionId={sessionId} accountId={facts.accountId} model={facts.model} />
        <ModePicker
          environmentId={environmentId}
          sessionId={sessionId}
          value={`${modeLabel(MODE_BADGE_WORDS[facts.mode.mode])}${facts.mode.clampedFrom !== null ? ` ${clampWords(facts.mode.clampedFrom)}` : ""}`}
        >
          <span className={facts.mode.mode === "bypassPermissions" ? "font-semibold text-signal" : "text-ink"}>{modeLabel(MODE_BADGE_WORDS[facts.mode.mode])}</span>
          {facts.mode.clampedFrom !== null && <span className="text-amber"> {clampWords(facts.mode.clampedFrom)}</span>}
        </ModePicker>
        <ContainmentPicker environmentId={environmentId} sessionId={sessionId} containment={facts.containment} />
        <SessionBrowserPicker environmentId={environmentId} sessionId={sessionId} />
        {facts.offer !== undefined ? <HandoffOffer offer={facts.offer} /> : <RunLine facts={facts} count={projection.parkedPrompts.length} question={projection.parkedPrompts.some((prompt) => prompt.prompt.kind === "question")} />}
      </div>
      <span className="ml-auto flex shrink-0 items-center gap-2">
        <SessionContextMeter environmentId={environmentId} sessionId={sessionId} accountId={facts.accountId} model={facts.model?.model ?? null} />
        <UsageMeter environmentId={environmentId} accountId={facts.accountId} />
      </span>
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

const ACTIVITY_TONES: Readonly<Record<StatusFacts["activity"]["kind"], string>> = { waiting: "text-amber", starting: "text-ink", working: "text-cyan", idle: "text-ink-faint" };

/** What the run is doing: its activity, then its elapsed time while it runs, and the tokens and dollars of the live run, else of the last. */
const RunLine = ({ facts, count, question }: { readonly facts: StatusFacts; readonly count: number; readonly question: boolean }) => {
  const { activity, elapsedMs, spend } = facts;
  const details = [
    ...(elapsedMs !== undefined ? [elapsedClock(elapsedMs)] : []),
    ...(spend ? [`${formatTokens(spend.tokens)} tok`, ...(spend.costUsd !== null ? [formatUsd(spend.costUsd)] : [])] : []),
  ];
  if (activity.kind === "idle" && details.length === 0) return null;
  return (
    <p className="flex min-w-0 items-center gap-1 whitespace-nowrap" aria-label="Run status">
      {activity.kind === "working" && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-cyan" />}
      {activity.kind === "waiting" && (question ? <CircleHelp aria-hidden="true" className="size-3 text-cyan" /> : <ShieldQuestion aria-hidden="true" className="size-3 text-amber" />)}
      <span className="truncate">{activity.kind !== "idle" && <span className={ACTIVITY_TONES[activity.kind]}>{activity.words}</span>}
      {activity.kind === "waiting" && count > 0 ? ` (${count})` : ""}{details.map((detail, index) => `${activity.kind === "idle" && index === 0 ? "" : " · "}${detail}`).join("")}</span>
    </p>
  );
};

/** The hand-off offer: the recommendation's sentence, and the button that opens the hand-off picker. */
const HandoffOffer = ({ offer }: { readonly offer: string }) => {
  const openHandoff = useHandoffPicker();
  return (
    <p className="flex min-w-0 flex-1 items-center gap-2 text-amber">
      <span className="min-w-0 truncate">{offer}</span>
      <Tooltip content="Hand off · /handoff · Enter to open"><Button className="h-[22px] max-w-[240px] shrink-0 gap-1 rounded-md bg-wash px-1.5 text-2xs [&_svg]:size-3" onClick={() => openHandoff()}><ArrowRightLeft aria-hidden="true" />Hand off…</Button></Tooltip>
    </p>
  );
};
