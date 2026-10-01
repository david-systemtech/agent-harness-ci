import {
  lastGoodWords,
  planSetupAction,
  restoreStep,
  setupActions,
  stepLine,
  updateEnvironment,
  uuidv7,
  type NamedItem,
  type SetupActionPlan,
} from "@agent-harness/client-runtime";
import { STEP_ORDER, settingsRow } from "@agent-harness/contracts";
import { useId, useState } from "react";
import { SignInCard } from "../accounts/sign-in-card.js";
import { useLocalService } from "../connections/local-service.js";
import { nameOf } from "../connections/words.js";
import { useSettings } from "../settings/settings-window.js";
import { Button } from "../ui/index.js";
import { useClock, useObservable, useRuntime } from "../window-context.js";
import { useRegisteredCard, type StepCardProps } from "./cards.js";
import { useChecklist } from "./checklist-window.js";
import { HealthDot } from "./health-dot.js";

/**
 * Carries out a named action on the environment checked (`planSetupAction`):
 * `setup.check`, the step's restore and its check again, the local
 * service's start, the checklist switched to another environment, an
 * account's sign-in (through `signIn`), the environment's update, or a row of
 * Settings, which leaves the full checklist; a verb that is a step card's,
 * on the fallback card, which has none, opens the step's home row. What a
 * restore or an update did is said through `say`.
 */
const useSetupActions = (environmentId: string, say: (line: string) => void, signIn: (account: NamedItem) => void) => {
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
        const restored = await restoreStep(runtime, environmentId, plan.step, uuidv7(clock.now()), plan.sections);
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
      case "card":
        return leave(plan.home, environmentId);
      case "row":
        return leave(plan.row, environmentId);
    }
  };
};

/**
 * The card a step has until one is registered for it (docs/specs/gui.md,
 * "Set up in the window"): its line (pending, aged, stale, the last good
 * result beneath one that could not check), its named actions on the items
 * they name, Check now where Check again is not among them (a check of the
 * step, or of every step for one this build cannot ask about alone), and a
 * link to its home row. Sign in again opens the sign-in card over it.
 */
export const FallbackCard = ({ environmentId, step }: StepCardProps) => {
  const runtime = useRuntime();
  const { leave } = useChecklist();
  const [line, say] = useState<string | undefined>(undefined);
  const [signingIn, signIn] = useState<NamedItem | null>(null);
  const act = useSetupActions(environmentId, say, signIn);
  const { result } = step;
  const offered = result === null ? [] : setupActions(step, result);
  return (
    <>
      <p className="text-sm text-ink">{stepLine(step)}</p>
      {result?.lastGood !== undefined && <p className="text-sm text-ink-muted">{lastGoodWords(result.lastGood, runtime.environmentNow(environmentId))}</p>}
      <div className="flex flex-wrap gap-2">
        {offered.map((action) => (
          <Button key={action.key} tone="primary" onClick={() => void act(action.plan)}>
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

/**
 * A step's card in the full checklist (docs/specs/gui.md, "Set up in the
 * window"): the step's name and dot, then the card registered for the step
 * (`cards.ts`), else the fallback card, then the checklist's way on:
 * Continue to the next step, beside it Skip for now on a step that may be
 * skipped, which moves on and records nothing (the Set up specification,
 * "Skipped"), or Finish on the last, which sets the first-launch mark.
 */
export const StepCard = ({ environmentId, step }: StepCardProps) => {
  const { choose, close } = useChecklist();
  const heading = useId();
  const Card = useRegisteredCard(step.id) ?? FallbackCard;
  const next = STEP_ORDER[STEP_ORDER.indexOf(step.id) + 1];
  return (
    <section aria-labelledby={heading} className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
      <header className="flex items-center gap-2">
        <h2 id={heading} className="text-lg font-semibold text-ink">
          {step.label}
        </h2>
        <HealthDot state={step.result?.state ?? null} of={step.label} />
      </header>
      <Card environmentId={environmentId} step={step} />
      <div className="mt-auto flex justify-end gap-2">
        {next === undefined ? (
          <Button tone="primary" onClick={close}>
            Finish
          </Button>
        ) : (
          <>
            {step.skippable && <Button onClick={() => choose(next)}>Skip for now</Button>}
            <Button tone="primary" onClick={() => choose(next)}>
              Continue
            </Button>
          </>
        )}
      </div>
    </section>
  );
};
