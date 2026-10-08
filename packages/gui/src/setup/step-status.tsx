import {
  RESTORE_METHODS,
  SETUP_ACTION_WORDS,
  lastGoodWords,
  plainRefusal,
  planSetupAction,
  pullSetupSources,
  restoreStep,
  runTool,
  setupActions,
  stepLine,
  stepNote,
  updateEnvironment,
  uuidv7,
  type ActionOutcome,
  type CardAction,
  type NamedItem,
  type OfferedSetupAction,
  type RefusedAnswer,
  type SetupActionPlan,
} from "@agent-harness/client-runtime";
import { PRODUCT_NAME, managedTool, type SetupAction, type SetupTarget } from "@agent-harness/contracts";
import { ExternalLink, Play, RefreshCw } from "lucide-react";
import { useId, useRef, useState } from "react";
import { SignInCard } from "../accounts/sign-in-card.js";
import { nameOf } from "../connections/words.js";
import { ToolTerminal, type ShownRun } from "../managed-tools/tool-terminal.js";
import { HostUpdaterSetup } from "../machines/host-updater-setup.js";
import { CopyLine } from "../settings/copy-line.js";
import { useSettings } from "../settings/settings-window.js";
import { Button, Tooltip } from "../ui/index.js";
import { useClock, useObservable, useRuntime } from "../window-context.js";
import type { StepCardProps } from "./cards.js";
import { useChecklist } from "./checklist-window.js";
import { TechnicalDetails } from "./details.js";
import type { SetupState } from "./health-dot.js";
import { SetupNotice } from "./notice.js";
import { StartFailed, useStart } from "./reach-line.js";
import { StateBadge } from "./state-badge.js";
import { useDetails } from "./use-details.js";
import { checkSetup, useCheckRefusal } from "./use-setup.js";

/** A step's restore, as its named action plans it. */
export type RestorePlan = Extract<SetupActionPlan, { readonly kind: "restore" }>;

/**
 * A card's own way with its step's restore (the Permissions card's: asked
 * once, then through the denylist it shows): what it did in one line, or
 * null when the person did not go ahead.
 */
export type CardRestore = (plan: RestorePlan) => Promise<ActionOutcome | null>;

/** What the card last said an action did: its line, whether it went ahead, its raw words for Details, and a refused tool's own command to run. */
type Said = Pick<ActionOutcome, "ok" | "line" | "details"> & { readonly command?: string };

/** What a check that could not run says (setup-copy.md §3, the patterns). */
const CHECK_REFUSED = `${PRODUCT_NAME} could not run the check.`;

/**
 * Carries out a named action on the environment checked (`planSetupAction`):
 * `setup.check`, the step's restore (the card's, else the client runtime's
 * `restoreStep`) and its check again, the local service's start, the
 * checklist switched to another environment, an account's sign-in (through
 * `signIn`), the environment's update, or a row of Settings, which leaves the
 * full checklist; a named tool's Install or Update opens its tool terminal
 * on the card, Pull now reports every named source's sync (#733), and How
 * to set it up on Your machines shows the host updater's setup (#1883).
 * A verb that is a step card's, on a card that has none, opens the step's
 * home row. What a command did is said through `say`; a check that did not
 * run is kept by `checkSetup`, and a start that did not start by `start`.
 */
const useSetupActions = (environmentId: string, say: (said: Said | undefined) => void, signIn: (account: NamedItem) => void, restore: CardRestore | undefined, started: (run: ShownRun) => void, start: (environmentId: string) => void, showHostUpdater: () => void) => {
  const runtime = useRuntime();
  const clock = useClock();
  const environment = useObservable(runtime.projections.environments).find((view) => view.environmentId === environmentId);
  const { pick } = useSettings();
  const { leave } = useChecklist();
  return async (plan: SetupActionPlan): Promise<void> => {
    switch (plan.kind) {
      case "check":
        return void (await checkSetup(runtime, environmentId, plan.step));
      case "restore": {
        const restored = restore === undefined ? await restoreStep(runtime, environmentId, plan.step, uuidv7(clock.now()), plan.sections) : await restore(plan);
        if (restored === null) return;
        say(restored);
        if (restored.ok) void checkSetup(runtime, environmentId, plan.step);
        return;
      }
      case "start-service":
        return start(environmentId);
      case "pick":
        return pick(plan.environmentId);
      case "sign-in":
        return signIn(plan.account);
      case "update":
        return say(await updateEnvironment(runtime, environmentId, environment === undefined ? "the environment" : nameOf(environment), uuidv7(clock.now())));
      case "pull-sources":
        say(undefined);
        return say(await pullSetupSources(runtime, environmentId, plan.sources, () => clock.now()));
      case "run-tool": {
        say(undefined);
        const outcome = await runTool(runtime, environmentId, plan.tool, plan.action, clock.now());
        if (outcome.ok) return started(outcome.run);
        return say({ ok: false, ...plainRefusal(outcome.refusal, SETUP_ACTION_WORDS[plan.action === "update" ? "update" : "install"]), ...(outcome.command !== null && { command: outcome.command }) });
      }
      case "managed-tools":
        return leave("about.about", environmentId, "managed-tools");
      case "host-updater-setup":
        return showHostUpdater();
      case "card":
        return leave(plan.home, environmentId);
      case "row":
        return leave(plan.row, environmentId);
    }
  };
};

interface StepStatusProps extends StepCardProps {
  /** The card's own restore, in place of the client runtime's. */
  readonly restore?: CardRestore;
  /** A registered card's commands for named health actions. */
  readonly actions?: Readonly<Partial<Record<SetupAction, { readonly disabled: boolean; readonly run: (targets: readonly SetupTarget[]) => void }>>> | undefined;
  /** An authoring or import card's actions, on the targets its result names. */
  readonly cardAction?: (action: CardAction, targets: readonly SetupTarget[]) => Promise<void>;
  /** Actions drawn and carried out by the card itself, beside the inventory they act on. */
  readonly handledActions?: readonly SetupAction[];
  /** A card with its own tool terminal draws the named action's run there too. */
  readonly toolStarted?: (run: ShownRun) => void;
}

/** A check this client met itself unable to reach the environment: the reach line says that, so the step does not say it twice. */
const unreachable = (refusal: RefusedAnswer): boolean => refusal.code === "unreachable" && refusal.data === undefined;

/**
 * Where a step stands, at the head of its card (setup-copy.md §3, "Status
 * line" and the patterns; docs/specs/gui.md, "Set up in the window"): its
 * state word, then its line (pending, aged, stale) with the note beneath it,
 * and the last good result beneath one that could not check. A result that
 * needs a fix is a notice with its named actions on the items they name in
 * place and Details (the result's raw words, the checks that failed, when
 * it ran). One Check again (a check of the step, or of every step for one
 * this build cannot ask about alone), whether or not the result offers it;
 * Open in Settings with its visible hint that it leaves Set up, and every
 * other action that leaves says so in its label. A check that did not run
 * (Check again, or the check as Set up opened), a start that did not start
 * and each action's outcome are notices with Details. An authoring or
 * import card may bind its named actions through `cardAction`. Restore is
 * greyed where the connection lacks the method it calls, whose line the
 * card says. Sign in again opens the sign-in card over it. It is the whole
 * of the fallback card, and the head of a registered one.
 */
export const StepStatus = ({ environmentId, step, restore, actions, cardAction, handledActions = [], toolStarted }: StepStatusProps) => {
  const runtime = useRuntime();
  const { leave } = useChecklist();
  const details = useDetails();
  const hint = useId();
  const [said, say] = useState<Said | undefined>(undefined);
  const [signingIn, signIn] = useState<NamedItem | null>(null);
  const [drawn, started] = useState<ShownRun | null>(null);
  const [hostUpdater, showHostUpdater] = useState(false);
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const service = useStart();
  const act = useSetupActions(environmentId, say, signIn, restore, toolStarted ?? started, service.start, () => showHostUpdater(true));
  const run = async (plan: SetupActionPlan) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    try {
      await act(plan);
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };
  const { result } = step;
  const offered = result === null ? [] : setupActions(step, result).filter((offered) => offered.action !== "check-again" && !handledActions.includes(offered.action));
  const capabilityOf = (plan: SetupActionPlan) => {
    const method = plan.kind === "restore" ? RESTORE_METHODS[plan.step] : plan.kind === "pull-sources" ? "skills.sources.pull" : plan.kind === "run-tool" ? "tools.run" : undefined;
    return method === undefined ? undefined : runtime.capability(environmentId, method);
  };
  const reasons = [...new Set(offered.flatMap(({ action, plan }) => {
    if (actions?.[action] !== undefined) return [];
    const capability = capabilityOf(plan);
    return capability?.status === "absent" ? [capability.message] : [];
  }))];
  const now = runtime.environmentNow(environmentId);
  const environment = useObservable(runtime.projections.environments).find((view) => view.environmentId === environmentId);
  const name = environment === undefined ? "this computer" : nameOf(environment);
  const note = stepNote(step, now, name);
  const line = stepLine(step, now);
  const state: SetupState = step.pending ? "pending" : result?.state ?? "unchecked";
  const refused = useCheckRefusal(environmentId, step.id);
  const refusal = refused === undefined || unreachable(refused) ? undefined : refused;
  const fix = !step.pending && result?.state === "needs-attention";
  const report = {
    ...(environment !== undefined && { computer: { name, ...(environment.version !== null && { version: environment.version }) } }),
    step: { label: step.label, id: step.id, state },
  };
  const leaves = ({ action, plan }: OfferedSetupAction) =>
    actions?.[action] === undefined && (plan.kind === "row" || plan.kind === "managed-tools" || (plan.kind === "card" && cardAction === undefined));
  const named = offered.map((action) => {
    const label = leaves(action) ? `${action.words} (leaves Set up)` : action.words;
    return (
      <Tooltip key={action.key} content={label} keys="Tab, Enter">
        <Button
          variant="outline"
          disabled={sending || (actions?.[action.action]?.disabled ?? capabilityOf(action.plan)?.status === "absent")}
          onClick={() => {
            const own = actions?.[action.action];
            if (own !== undefined) own.run(action.targets);
            else if (action.plan.kind === "card" && cardAction !== undefined) void cardAction(action.plan.action, action.plan.targets);
            else void run(action.plan);
          }}
        >
          {leaves(action) ? <ExternalLink aria-hidden="true" /> : <Play aria-hidden="true" />}{label}
        </Button>
      </Tooltip>
    );
  });
  const checkAgain = (
    <Tooltip content="Check again" keys="Tab, Enter">
      <Button variant="outline" disabled={sending} onClick={() => void run(planSetupAction(step, "check-again"))}><RefreshCw aria-hidden="true" />Check again</Button>
    </Tooltip>
  );
  return (
    <>
      <div data-step-status className="flex min-w-0 flex-col gap-2">
        <StateBadge state={state} className="self-start" />
        {fix ? (
          <SetupNotice
            tone="warning"
            title={line}
            {...(note !== undefined && { description: note })}
            actions={<>{named}{refusal === undefined && checkAgain}</>}
            details={details({ ...report, checkedAt: result.checkedAt, line, failing: result.failing, details: result.details ?? [] })}
          />
        ) : (
          <>
            <p className="text-sm text-ink">{line}</p>
            {note !== undefined && <p className="text-xs text-ink-muted">{note}</p>}
          </>
        )}
        {result?.lastGood !== undefined && <p className="text-sm text-ink-muted">{lastGoodWords(result.lastGood, now)}</p>}
        {!fix && result !== null && !step.pending && <TechnicalDetails {...details({ ...report, checkedAt: result.checkedAt, line, failing: result.failing, details: result.details ?? [] })} />}
        {!fix && <div className="flex flex-wrap gap-2">{named}{refusal === undefined && checkAgain}</div>}
        {reasons.map((reason) => <p key={reason} className="text-sm text-ink-faint">{reason}</p>)}
        {refusal !== undefined && (
          <SetupNotice
            tone="error"
            title={CHECK_REFUSED}
            description="Choose Check again."
            actions={checkAgain}
            details={details({ ...report, line: `${CHECK_REFUSED} Choose Check again.`, details: plainRefusal(refusal, "Check again").details })}
          />
        )}
        {service.failure !== undefined && <StartFailed name={name} failure={service.failure} />}
        {said !== undefined && (
          <SetupNotice
            tone={said.ok ? "info" : "error"}
            title={said.line}
            {...((said.details ?? []).length > 0 || said.command !== undefined ? {
              details: {
                ...details({ ...report, line: said.line, details: said.details ?? [] }),
                ...(said.command !== undefined && { children: <CopyLine label={`Or run this yourself on ${name}:`} text={said.command} /> }),
              },
            } : {})}
          />
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Tooltip content="Open in Settings" keys="Tab, Enter">
            <Button variant="outline" aria-describedby={hint} onClick={() => leave(step.home, environmentId)}><ExternalLink aria-hidden="true" />Open in Settings</Button>
          </Tooltip>
          <span id={hint} className="text-xs text-ink-muted">Leaves Set up</span>
        </div>
      </div>
      {hostUpdater && offered.some(({ plan }) => plan.kind === "host-updater-setup") && <HostUpdaterSetup close={() => showHostUpdater(false)} />}
      {drawn !== null && <ToolTerminal key={drawn.terminal.id} environmentId={environmentId} run={drawn} label={managedTool(drawn.tool).label} close={() => started(null)} />}
      {signingIn !== null && <SignInCard environmentId={environmentId} account={signingIn} close={() => signIn(null)} say={(line) => say({ ok: true, line })} />}
    </>
  );
};
