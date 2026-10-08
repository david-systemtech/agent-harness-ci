import {
  BETWEEN_ENVIRONMENTS,
  MODE_BADGE_WORDS,
  clampWords,
  formatTokens,
  formatUsd,
  liveRunIdOf,
  statusOf,
  type StatusFacts,
} from "@agent-harness/client-runtime";
import { ArrowRightLeft, ChevronDown, Settings2 } from "lucide-react";
import { useMemo, useState, useId } from "react";
import { useSlashCommand } from "../composer/slash-commands.js";
import { usePaneLine } from "../session/pane-line.js";
import { EnvironmentBadge } from "../connections/environment-badge.js";
import { PhoneComposerSheet } from "../composer/phone-composer-sheet.js";
import { Button, Dialog, DialogTrigger, Tooltip } from "../ui/index.js";
import { useFollowed, useObservable, useRuntime, useShell } from "../window-context.js";
import { useHandoffPicker } from "./pane-dialogs.js";
import { AccountPicker, ContainmentPicker, ModePicker, ModelPicker, RunPickerRequest, modeLabel, type RunPickerCommand } from "./pickers.js";
import { useHandedOnto, useModelChoice } from "./run-choices.js";
import { SessionBrowserPicker } from "../browser/session-picker.js";
import { UsageMeter } from "./usage-meter.js";
import { SessionContextMeter } from "./context-meter.js";
import { WebRegisteredSurfaces } from "../platform/web-registrations.js";

export interface StatusLineProps {
  readonly environmentId: string;
  readonly sessionId: string;
  readonly compact?: boolean;
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
 * - **Run spend**: its tokens and cost, the last run's once it has ended; or,
 *   while the account's window is out and no run is live, the hand-off offer
 *   in `accounts.handoff.recommend`'s words, which opens the hand-off picker.
 *   Run info (Mod+I) is the pane's caption's. `/handoff` opens the hand-off
 *   picker whenever; naming another environment, it says that is milestone 2's.
 */
export const StatusLine = ({ environmentId, sessionId, compact = false }: StatusLineProps) => {
  const web = useShell() === undefined;
  const [expanded, setExpanded] = useState(false);
  const [requestedPicker, setRequestedPicker] = useState<RunPickerCommand | null>(null);
  const detailsId = useId();
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
  const openHandoff = useHandoffPicker();
  const [, say] = usePaneLine();
  // `/handoff <environment>` naming another environment is milestone 2's (ADR 0005), as the terminal UI answers it.
  useSlashCommand("handoff", (named) =>
    named === "" || named.toLowerCase() === (environment?.name ?? "").toLowerCase() ? openHandoff() : say(`Not handed off to ${named}: ${BETWEEN_ENVIRONMENTS}.`),
  );

  const details = <>
      <div id={detailsId} className={`flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 ${compact ? "" : "grow basis-[352px]"}`}>
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
        {facts.offer !== undefined ? <HandoffOffer offer={facts.offer} /> : <RunLine facts={facts} />}
      </div>
      <span className="ml-auto flex min-w-0 max-w-full items-center gap-2">
        <SessionContextMeter environmentId={environmentId} sessionId={sessionId} accountId={facts.accountId} model={facts.model?.model ?? null} />
        <UsageMeter environmentId={environmentId} accountId={facts.accountId} />
      </span>
  </>;
  if (compact) return <>
    {!expanded && (["account", "model", "mode", "containment"] as const).map(command => <PhonePickerCommand key={command} environmentId={environmentId} command={command} open={picker => { setRequestedPicker(picker); setExpanded(true); }} />)}
    <Dialog open={expanded} onOpenChange={open => { setExpanded(open); if (!open) setRequestedPicker(null); }}>
      <DialogTrigger asChild><Button aria-label="Run settings"><Settings2 aria-hidden="true" className="size-4" /></Button></DialogTrigger>
      <PhoneComposerSheet data-phone-run-settings title="Run settings">
        <RunPickerRequest value={requestedPicker === null ? null : { command: requestedPicker, handled: () => setRequestedPicker(null) }}>{details}</RunPickerRequest>
      </PhoneComposerSheet>
    </Dialog>
    <span data-phone-composer-browser><WebRegisteredSurfaces location="session-status" /></span>
  </>;
  return (
    <section data-phone-status={expanded ? "open" : "closed"} aria-label="Status line" className="flex min-h-7 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-1 text-2xs text-ink-muted">
      {web && <Button data-phone-status-toggle className="hidden" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(!expanded)}><Settings2 aria-hidden="true" />Run settings<ChevronDown aria-hidden="true" /></Button>}
      {web && <WebRegisteredSurfaces location="session-status" />}
      {details}
    </section>
  );
};

const PICKER_CAPABILITIES = { account: "accounts.list", model: "models.list", mode: "permissions.mode.set", containment: "permissions.containment.set" } as const;

/** Closed phone details keep the same command availability; mounted pickers take over when opened. */
const PhonePickerCommand = ({ environmentId, command, open }: { readonly environmentId: string; readonly command: RunPickerCommand; readonly open: (command: RunPickerCommand) => void }) => {
  const runtime = useRuntime();
  useObservable(runtime.projections.environments);
  const offer = runtime.capability(environmentId, PICKER_CAPABILITIES[command]);
  const [, say] = usePaneLine();
  useSlashCommand(command, () => { if (offer.status === "absent") say(offer.message); else open(command); }, offer);
  return null;
};

/** Spend remains in status; the composer owns the single activity and elapsed-time tail. */
const RunLine = ({ facts }: { readonly facts: StatusFacts }) => {
  const { spend } = facts;
  if (spend === undefined) return null;
  return <p className="min-w-0 flex-1 truncate" aria-label="Run status">{`${formatTokens(spend.tokens)} tok${spend.costUsd === null ? "" : ` · ${formatUsd(spend.costUsd)}`}`}</p>;
};

/** The hand-off offer: the recommendation's sentence, and the button that opens the hand-off picker. */
const HandoffOffer = ({ offer }: { readonly offer: string }) => {
  const openHandoff = useHandoffPicker();
  return (
    <p className="flex min-w-0 flex-1 items-center gap-2 text-amber">
      <span className="min-w-0 truncate">{offer}</span>
      <Tooltip content="Hand off · /handoff" keys="Enter to open"><Button className="h-[22px] max-w-[240px] shrink-0 gap-1 rounded-md bg-wash px-1.5 text-2xs [&_svg]:size-3" onClick={() => openHandoff()}><ArrowRightLeft aria-hidden="true" />Hand off…</Button></Tooltip>
    </p>
  );
};
