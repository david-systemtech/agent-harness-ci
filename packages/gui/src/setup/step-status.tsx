import {
  RESTORE_METHODS,
  lastGoodWords,
  outcomeWords,
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
  type SetupActionPlan,
} from "@agent-harness/client-runtime";
import { managedTool, settingsRow, type SetupAction, type SetupTarget } from "@agent-harness/contracts";
import { ExternalLink, Play, RefreshCw } from "lucide-react";
import { useRef, useState } from "react";
import { SignInCard } from "../accounts/sign-in-card.js";
import { useLocalService } from "../connections/local-service.js";
import { nameOf } from "../connections/words.js";
import { ToolTerminal, type ShownRun } from "../managed-tools/tool-terminal.js";
import { CopyLine } from "../settings/copy-line.js";
import { useSettings } from "../settings/settings-window.js";
import { Button, Tooltip } from "../ui/index.js";
import { useClock, useObservable, useRuntime } from "../window-context.js";
import type { StepCardProps } from "./cards.js";
import { useChecklist } from "./checklist-window.js";

/** A step's restore, as its named action plans it. */
export type RestorePlan = Extract<SetupActionPlan, { readonly kind: "restore" }>;

/**
 * A card's own way with its step's restore (the Permissions card's: asked
 * once, then through the denylist it shows): what it did in one line, or
 * null when the person did not go ahead.
 */
export type CardRestore = (plan: RestorePlan) => Promise<ActionOutcome | null>;

/**
 * Carries out a named action on the environment checked (`planSetupAction`):
 * `setup.check`, the step's restore (the card's, else the client runtime's
 * `restoreStep`) and its check again, the local service's start, the
 * checklist switched to another environment, an account's sign-in (through
 * `signIn`), the environment's update, or a row of Settings, which leaves the
 * full checklist; a named tool's Install or Update opens its tool terminal
 * on the card, and Pull now reports every named source's sync (#733).
 * A verb that is a step card's, on a card that has none, opens the step's
 * home row. What a command did is said through `say`.
 */
const useSetupActions = (environmentId: string, say: (line: string | undefined) => void, signIn: (account: NamedItem) => void, restore: CardRestore | undefined, started: (run: ShownRun) => void, refused: (command: string | null) => void) => {
  const runtime = useRuntime();
  const clock = useClock();
  const service = useLocalService();
  const environment = useObservable(runtime.projections.environments).find((view) => view.environmentId === environmentId);
  const { pick } = useSettings();
  const { leave } = useChecklist();
  return async (plan: SetupActionPlan): Promise<void> => {
    switch (plan.kind) {
      case "check":
        return void runtime.setup.check(environmentId, plan.step);
      case "restore": {
        const restored = restore === undefined ? await restoreStep(runtime, environmentId, plan.step, uuidv7(clock.now()), plan.sections) : await restore(plan);
        if (restored === null) return;
        say(outcomeWords(restored));
        if (restored.ok) void runtime.setup.check(environmentId, plan.step);
        return;
      }
      case "start-service":
        return service.start(environmentId);
      case "pick":
        return pick(plan.environmentId);
      case "sign-in":
        return signIn(plan.account);
      case "update":
        return say(outcomeWords(await updateEnvironment(runtime, environmentId, environment === undefined ? "the environment" : nameOf(environment), uuidv7(clock.now()))));
      case "pull-sources":
        say(undefined);
        return say(outcomeWords(await pullSetupSources(runtime, environmentId, plan.sources, () => clock.now())));
      case "run-tool": {
        say(undefined);
        refused(null);
        const outcome = await runTool(runtime, environmentId, plan.tool, plan.action, clock.now());
        if (outcome.ok) return started(outcome.run);
        refused(outcome.command);
        return say(outcome.line);
      }
      case "managed-tools":
        return leave("about.about", environmentId, "managed-tools");
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

/**
 * Where a step stands, at the head of its card (docs/specs/gui.md, "Set up
 * in the window"): its line (pending, aged, stale, the last good result
 * beneath one that could not check), its named actions on the items they
 * name, Check now where Check again is not among them (a check of the step,
 * or of every step for one this build cannot ask about alone), and a link to
 * its home row. An authoring or import card may bind its named actions
 * through `cardAction`. Restore is greyed where the connection lacks the method it
 * calls, whose line the card says. Sign in again opens the sign-in card over
 * it. It is the whole of the fallback card, and the head of a registered one.
 */
export const StepStatus = ({ environmentId, step, restore, actions, cardAction, handledActions = [], toolStarted }: StepStatusProps) => {
  const runtime = useRuntime();
  const { leave } = useChecklist();
  const [line, say] = useState<string | undefined>(undefined);
  const [signingIn, signIn] = useState<NamedItem | null>(null);
  const [drawn, started] = useState<ShownRun | null>(null);
  const [refusedCommand, refused] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const act = useSetupActions(environmentId, say, signIn, restore, toolStarted ?? started, refused);
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
  const offered = result === null ? [] : setupActions(step, result).filter((offered) => !handledActions.includes(offered.action));
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
  const note = stepNote(step, now, environment === undefined ? "this computer" : nameOf(environment));
  return (
    <>
      <p className="text-sm text-ink">{stepLine(step, now)}</p>
      {note !== undefined && <p className="text-xs text-ink-muted">{note}</p>}
      {result?.lastGood !== undefined && <p className="text-sm text-ink-muted">{lastGoodWords(result.lastGood, now)}</p>}
      <div className="flex flex-wrap gap-2">
        {offered.map((action) => (
          <Tooltip key={action.key} content={action.words} keys="Tab, Enter">
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
              <Play aria-hidden="true" />{action.words}
            </Button>
          </Tooltip>
        ))}
        {!result?.actions.includes("check-again") && <Tooltip content="Check now" keys="Tab, Enter"><Button variant="outline" onClick={() => void act(planSetupAction(step, "check-again"))}><RefreshCw aria-hidden="true" />Check now</Button></Tooltip>}
        <Tooltip content={`Open ${settingsRow(step.home).label}`} keys="Tab, Enter"><Button variant="outline" onClick={() => leave(step.home, environmentId)}><ExternalLink aria-hidden="true" />Open {settingsRow(step.home).label}</Button></Tooltip>
      </div>
      {reasons.map((reason) => <p key={reason} className="text-sm text-ink-faint">{reason}</p>)}
      {line !== undefined && <p className="text-sm text-ink-muted">{line}</p>}
      {refusedCommand !== null && <CopyLine label="The vendor's command, to run yourself" text={refusedCommand} />}
      {drawn !== null && <ToolTerminal key={drawn.terminal.id} environmentId={environmentId} run={drawn} label={managedTool(drawn.tool).label} close={() => started(null)} />}
      {signingIn !== null && <SignInCard environmentId={environmentId} account={signingIn} close={() => signIn(null)} say={say} />}
    </>
  );
};
