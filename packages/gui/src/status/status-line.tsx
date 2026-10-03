import {
  BETWEEN_ENVIRONMENTS,
  MODE_BADGE_WORDS,
  clampWords,
  formatTokens,
  formatUsd,
  gaugeOf,
  liveRunIdOf,
  readingsOf,
  statusOf,
  type Reading,
  type StatusFacts,
} from "@agent-harness/client-runtime";
import { useMemo } from "react";
import { Hand } from "lucide-react";
import { useSlashCommand } from "../composer/slash-commands.js";
import { usePaneLine } from "../session/pane-line.js";
import { EnvironmentBadge } from "../connections/environment-badge.js";
import { Button, Tooltip } from "../ui/index.js";
import { useFollowed, useObservable, useRuntime } from "../window-context.js";
import { useHandoffPicker } from "./pane-dialogs.js";
import { AccountPicker, ContainmentPicker, ModePicker, ModelPicker } from "./pickers.js";
import { useHandedOnto, useModelChoice } from "./run-choices.js";
import { SessionBrowserPicker } from "../browser/session-picker.js";
import { WindowReading } from "./window-reading.js";

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
 * - **Run spend**: its tokens and cost, the last run's once it has ended; or,
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
  const openHandoff = useHandoffPicker();
  const [, say] = usePaneLine();
  // `/handoff <environment>` naming another environment is milestone 2's (ADR 0005), as the terminal UI answers it.
  useSlashCommand("handoff", (named) =>
    named === "" || named.toLowerCase() === (environment?.name ?? "").toLowerCase() ? openHandoff() : say(`Not handed off to ${named}: ${BETWEEN_ENVIRONMENTS}.`),
  );

  return (
    <section aria-label="Status line" className="flex shrink-0 flex-col gap-1 px-3 py-1 text-xs text-ink-muted">
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
        <SessionBrowserPicker environmentId={environmentId} sessionId={sessionId} />
        <ContainmentPicker environmentId={environmentId} sessionId={sessionId} containment={facts.containment} />
        <Gauge readings={readingsOf(gaugeOf(usage.gauges, environmentId, facts.accountId))} />
      </div>
      <div className="flex min-w-0 items-center gap-2">
        {facts.offer !== undefined ? <HandoffOffer offer={facts.offer} /> : <RunLine facts={facts} />}
      </div>
    </section>
  );
};

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
          <WindowReading reading={reading} />
        </span>
      ))}
    </span>
  );

/** Spend remains in status; the composer owns the single activity and elapsed-time tail. */
const RunLine = ({ facts }: { readonly facts: StatusFacts }) => {
  const { spend } = facts;
  if (spend === undefined) return null;
  return <p className="min-w-0 flex-1 truncate">{`${formatTokens(spend.tokens)} tok${spend.costUsd === null ? "" : ` · ${formatUsd(spend.costUsd)}`}`}</p>;
};

/** The hand-off offer: the recommendation's sentence, and the button that opens the hand-off picker. */
const HandoffOffer = ({ offer }: { readonly offer: string }) => {
  const openHandoff = useHandoffPicker();
  return (
    <p className="flex min-w-0 flex-1 items-center gap-2 text-amber">
      <span className="min-w-0 truncate">{offer}</span>
      <Tooltip content="Hand off to another account · /handoff"><Button className="h-6 shrink-0 px-2 text-xs" onClick={() => openHandoff()}><Hand aria-hidden="true" className="size-3" />Hand off…</Button></Tooltip>
    </p>
  );
};
