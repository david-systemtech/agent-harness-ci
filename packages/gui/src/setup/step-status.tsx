import {
  RESTORE_METHODS,
  lastGoodWords,
  planSetupAction,
  restoreStep,
  setupActions,
  stepLine,
  updateEnvironment,
  uuidv7,
  type ActionOutcome,
  type NamedItem,
  type SetupActionPlan,
} from "@agent-harness/client-runtime";
import { settingsRow } from "@agent-harness/contracts";
import { useState } from "react";
import { SignInCard } from "../accounts/sign-in-card.js";
import { useLocalService } from "../connections/local-service.js";
import { nameOf } from "../connections/words.js";
import { useSettings } from "../settings/settings-window.js";
import { Button } from "../ui/index.js";
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
 * full checklist (a tool's Install or Update for About at its Managed tools,
 * #426); a verb that is a step card's, on a card that has none, opens the
 * step's home row. What a restore or an update did is said
 * through `say`.
 */
const useSetupActions = (environmentId: string, say: (line: string) => void, signIn: (account: NamedItem) => void, restore: CardRestore | undefined) => {
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
        say(restored.line);
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
        return say((await updateEnvironment(runtime, environmentId, environment === undefined ? "the environment" : nameOf(environment), uuidv7(clock.now()))).line);
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
}

/**
 * Where a step stands, at the head of its card (docs/specs/gui.md, "Set up
 * in the window"): its line (pending, aged, stale, the last good result
 * beneath one that could not check), its named actions on the items they
 * name, Check now where Check again is not among them (a check of the step,
 * or of every step for one this build cannot ask about alone), and a link to
 * its home row. Restore is greyed where the connection lacks the method it
 * calls, whose line the card says. Sign in again opens the sign-in card over
 * it. It is the whole of the fallback card, and the head of a registered one.
 */
export const StepStatus = ({ environmentId, step, restore }: StepStatusProps) => {
  const runtime = useRuntime();
  const { leave } = useChecklist();
  const [line, say] = useState<string | undefined>(undefined);
  const [signingIn, signIn] = useState<NamedItem | null>(null);
  const act = useSetupActions(environmentId, say, signIn, restore);
  const { result } = step;
  const offered = result === null ? [] : setupActions(step, result);
  /** Whether the connection may carry out a plan: a restore needs the method it calls. */
  const may = (plan: SetupActionPlan): boolean => plan.kind !== "restore" || runtime.capability(environmentId, RESTORE_METHODS[plan.step]).status === "present";
  return (
    <>
      <p className="text-sm text-ink">{stepLine(step)}</p>
      {result?.lastGood !== undefined && <p className="text-sm text-ink-muted">{lastGoodWords(result.lastGood, runtime.environmentNow(environmentId))}</p>}
      <div className="flex flex-wrap gap-2">
        {offered.map((action) => (
          <Button key={action.key} tone="primary" disabled={!may(action.plan)} onClick={() => void act(action.plan)}>
            {action.words}
          </Button>
        ))}
        {!result?.actions.includes("check-again") && <Button onClick={() => void act(planSetupAction(step, "check-again"))}>Check now</Button>}
        <Button onClick={() => leave(step.home, environmentId)}>Open {settingsRow(step.home).label}</Button>
      </div>
      {line !== undefined && <p className="text-sm text-ink-muted">{line}</p>}
      {signingIn !== null && <SignInCard environmentId={environmentId} account={signingIn} close={() => signIn(null)} say={say} />}
    </>
  );
};
