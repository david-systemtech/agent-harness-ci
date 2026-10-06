import { STEP_HINTS, STEP_ORDER, type StepId } from "@agent-harness/contracts";
import { ArrowLeft, ArrowRight, BookOpen, Brain, Check, Download, Globe, KeyRound, Monitor, Palette, Shield, SkipForward, Sparkles, UserRound, type LucideIcon } from "lucide-react";
import { useId, useState } from "react";
import { Button, Tooltip } from "../ui/index.js";
import { useRegisteredCard, type StepCardProps } from "./cards.js";
import { useChecklist } from "./checklist-window.js";
import { ContinueHoldContext } from "./continue-hold.js";
import { HealthDot } from "./health-dot.js";
import { StepStatus } from "./step-status.js";

/** The concepts shared by the numbered rail and the card heading. */
export const STEP_ICONS: Readonly<Record<StepId, LucideIcon>> = {
  account: UserRound, "carry-over": Download, "your-machines": Monitor, forges: Globe,
  "key-manager": KeyRound, "memory-bank": Brain, skills: Sparkles, instructions: BookOpen,
  browser: Globe, permissions: Shield, appearance: Palette,
};

/**
 * A step's card in the full checklist (look.md §13.2): its outcome lead,
 * registered card or health fallback, and navigation outside the scrolling
 * content. Back revisits the previous step; optional steps may be left for
 * later without recording health. Finish sets the first-launch mark.
 * A card may hold Continue with a reason through `useHoldContinue`.
 */
export const StepCard = ({ environmentId, step }: StepCardProps) => {
  const { choose, close } = useChecklist();
  const heading = useId();
  const Card = useRegisteredCard(step.id) ?? StepStatus;
  const index = STEP_ORDER.indexOf(step.id);
  const next = STEP_ORDER[index + 1];
  const previous = STEP_ORDER[index - 1];
  const Icon = STEP_ICONS[step.id];
  const [held, hold] = useState<string | undefined>(undefined);
  return (
    <section aria-labelledby={heading} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div data-setup-scroll className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-[34px] md:px-10">
        <header className="flex items-center gap-2">
          <Icon aria-hidden="true" className="size-5 text-ink-muted" />
          <h2 id={heading} className="text-xl leading-7 font-semibold text-ink">
            {step.label}
          </h2>
          <HealthDot state={step.result?.state ?? null} of={step.label} />
        </header>
        <p className="max-w-[56ch] text-sm text-ink-muted">{STEP_HINTS[step.id]}</p>
        <div className="flex w-full max-w-[620px] flex-col gap-4">
          <ContinueHoldContext value={hold}>
            <Card environmentId={environmentId} step={step} />
          </ContinueHoldContext>
        </div>
      </div>
      <footer role="navigation" aria-label="Step navigation" className="relative flex min-h-[67px] shrink-0 flex-wrap items-center justify-between gap-3.5 border-t border-hairline bg-panel px-6 py-3.5 before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-6 before:bg-gradient-to-t before:from-panel before:to-transparent">
        <Tooltip content="Back" keys="Tab, Enter">
          <Button variant="outline" disabled={previous === undefined} onClick={() => { if (previous !== undefined) choose(previous); }}><ArrowLeft aria-hidden="true" />Back</Button>
        </Tooltip>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {held !== undefined && <p className="max-w-[32ch] text-xs text-ink-muted">{held}</p>}
          <Tooltip content={step.id === "account" ? "Skip for now · Account is required to start a session" : "Skip for now"} keys={step.id === "account" ? undefined : "Tab, Enter"}>
            <span tabIndex={step.id === "account" ? 0 : undefined}>
              <Button variant="outline" disabled={step.id === "account"} onClick={() => next === undefined ? close() : choose(next)}><SkipForward aria-hidden="true" />Skip for now</Button>
            </span>
          </Tooltip>
          <Tooltip content={`${next === undefined ? "Finish" : "Continue"}${held === undefined ? "" : ` · ${held}`}`} keys="Tab, Enter">
            <span tabIndex={held === undefined ? undefined : 0}>
              <Button variant="default" disabled={held !== undefined} onClick={() => next === undefined ? close() : choose(next)}>
                {next === undefined ? <Check aria-hidden="true" /> : <ArrowRight aria-hidden="true" />}{next === undefined ? "Finish" : "Continue"}
              </Button>
            </span>
          </Tooltip>
        </div>
      </footer>
    </section>
  );
};
