import { STEP_ORDER, type StepId } from "@agent-harness/contracts";
import { ArrowLeft, ArrowRight, BookOpen, Brain, Check, Download, Globe, KeyRound, Monitor, Palette, Shield, SkipForward, Sparkles, UserRound, type LucideIcon } from "lucide-react";
import { useId, useState } from "react";
import { Button, Tooltip } from "../ui/index.js";
import { useRegisteredCard, type StepCardProps } from "./cards.js";
import { useChecklist } from "./checklist-window.js";
import { ContinueHoldContext } from "./continue-hold.js";
import type { SetupState } from "./health-dot.js";
import { StateBadge } from "./state-badge.js";
import { StepIntro } from "./step-intro.js";
import { StepStatus } from "./step-status.js";
import { STEP_WORDS } from "./step-words.js";

/** Each step's icon, on the Set up pane's rows. */
export const STEP_ICONS: Readonly<Record<StepId, LucideIcon>> = {
  account: UserRound, "carry-over": Download, "your-machines": Monitor, forges: Globe,
  "key-manager": KeyRound, "memory-bank": Brain, skills: Sparkles, instructions: BookOpen,
  browser: Globe, permissions: Shield, appearance: Palette,
};

/** The step every computer needs, which Skip for now never passes (setup-copy.md §4.4). */
const REQUIRED_STEP: StepId = "account";

/** Why the footer holds Skip for now on the required step, and Continue too while nobody is signed in (setup-copy.md §4.4). */
const REQUIRED = "Account is the one required step.";
const SIGN_IN_FIRST = `Sign in to continue. ${REQUIRED}`;

export interface StepCardFrameProps extends StepCardProps {
  /** What the rail draws the step as; Not available puts §4.4's line in place of its card. */
  readonly state: SetupState;
  /** The name of the computer Set up is setting up; null for this computer unnamed. */
  readonly computer: string | null;
}

/**
 * A step's card in the full checklist (look.md §13.2; setup-copy.md §3 "Step
 * page" and §4.4), named by the step's label: its head ("Step {n} of 11",
 * the heading, the why line, "What is this?"), its registered card or the
 * health fallback, and Back, Skip for now and Continue (Finish set up on the
 * last step) outside the scrolling content. A step the computer's version
 * does not have says so in place of its card. Skip for now leaves an
 * optional step for later without recording health; Account holds it, and
 * a card may hold Continue with a reason through `useHoldContinue`. A held
 * button's reason is visible text beside it, never a tooltip alone.
 */
export const StepCard = ({ environmentId, step, state, computer }: StepCardFrameProps) => {
  const { choose, close } = useChecklist();
  const reasonId = useId();
  const Card = useRegisteredCard(step.id) ?? StepStatus;
  const index = STEP_ORDER.indexOf(step.id);
  const next = STEP_ORDER[index + 1];
  const previous = STEP_ORDER[index - 1];
  const words = STEP_WORDS[step.id];
  const [held, hold] = useState<string | undefined>(undefined);
  const required = step.id === REQUIRED_STEP;
  const reason = required ? (held === undefined ? REQUIRED : SIGN_IN_FIRST) : held;
  const forward = () => next === undefined ? close() : choose(next);
  return (
    <section aria-label={step.label} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div data-setup-scroll className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-[34px] md:px-10">
        <StepIntro step={step.id} title={words.heading} why={words.why} {...(words.what !== undefined && { what: words.what })} />
        <div className="flex w-full max-w-[620px] flex-col gap-4">
          {state === "unavailable" ? (
            <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
              <StateBadge state="unavailable" />
              <span>{computer ?? "This computer"} runs an older agent-harness without this step. Update {computer ?? "this computer"} to set it up.</span>
            </p>
          ) : (
            <ContinueHoldContext value={hold}>
              <Card environmentId={environmentId} step={step} />
            </ContinueHoldContext>
          )}
        </div>
      </div>
      <footer role="navigation" aria-label="Step navigation" className="relative flex min-h-[67px] shrink-0 flex-wrap items-center justify-between gap-3.5 border-t border-hairline bg-panel px-6 py-3.5 before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-6 before:bg-gradient-to-t before:from-panel before:to-transparent">
        <Tooltip content="Back" keys="Tab, Enter">
          <Button variant="outline" disabled={previous === undefined} onClick={() => { if (previous !== undefined) choose(previous); }}><ArrowLeft aria-hidden="true" />Back</Button>
        </Tooltip>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {reason !== undefined && <p id={reasonId} className="max-w-[32ch] text-xs text-ink-muted">{reason}</p>}
          <Tooltip content="Skip for now" keys="Tab, Enter">
            <Button variant="outline" disabled={required} aria-describedby={required ? reasonId : undefined} onClick={forward}><SkipForward aria-hidden="true" />Skip for now</Button>
          </Tooltip>
          <Tooltip content={next === undefined ? "Finish set up" : "Continue"} keys="Tab, Enter">
            <Button variant="default" disabled={held !== undefined} aria-describedby={held === undefined ? undefined : reasonId} onClick={forward}>
              {next === undefined ? <Check aria-hidden="true" /> : <ArrowRight aria-hidden="true" />}{next === undefined ? "Finish set up" : "Continue"}
            </Button>
          </Tooltip>
        </div>
      </footer>
    </section>
  );
};
