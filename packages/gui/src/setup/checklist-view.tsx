import type { SetupStepView, SetupView } from "@agent-harness/client-runtime";
import { STEP_HINTS } from "@agent-harness/contracts";
import { ListChecks, X } from "lucide-react";
import { useId, useState } from "react";
import { nativeFrame, useWindowFrame, WindowControls } from "../frame/window-controls.js";
import { CredentialNoticeHost } from "../notices/credential-notice.js";
import { EnvironmentPicker } from "../settings/environment-picker.js";
import { usePickedEnvironment } from "../settings/settings-window.js";
import { PhoneNavigation, usePhoneSettings } from "../settings/phone-navigation.js";
import { classes } from "../ui/classes.js";
import { Button, Tooltip } from "../ui/index.js";
import { useChecklist } from "./checklist-window.js";
import type { SetupState } from "./health-dot.js";
import { ReachLine } from "./reach-line.js";
import { StateBadge } from "./state-badge.js";
import { StepCard } from "./step-card.js";
import { useCheckOnFocus, useCheckOnOpen, useSetupView } from "./use-setup.js";

/**
 * What Set up draws a step as (setup-copy.md §3 and §4.4): its result's
 * state; Not available once the computer has given results but none for it,
 * a step its version does not have; Checking while this window's check of it
 * waits; else Not checked yet.
 */
export const stepState = (view: SetupView, step: SetupStepView): SetupState =>
  step.result !== null ? step.result.state : view.steps.some((other) => other.registered) ? "unavailable" : step.pending ? "pending" : "unchecked";

/**
 * A step's row on the rail (setup-copy.md §4.4): its number, label, hint,
 * state word and Required or Optional tag, the button named by its label
 * and described by the rest.
 */
const RailRow = ({ step, index, state, shown, choose }: { readonly step: SetupStepView; readonly index: number; readonly state: SetupState; readonly shown: boolean; readonly choose: () => void }) => {
  const row = useId();
  const tag = index === 0 ? "Required" : "Optional";
  return (
    <li>
      <Tooltip content={step.label} keys="Tab, Enter">
        <button
          type="button"
          aria-label={step.label}
          aria-describedby={`${row}-hint ${row}-state ${row}-tag`}
          aria-current={shown ? "step" : undefined}
          onClick={choose}
          className={classes(
            "flex min-h-[50px] w-full items-start gap-2.5 rounded-md border border-transparent p-2 text-left outline-none hover:bg-wash focus-visible:outline-2 focus-visible:outline-beam",
            shown ? "border-hairline-strong bg-wash-strong" : undefined,
            !step.registered ? "text-ink-faint" : shown ? "text-ink" : "text-ink-muted",
          )}
        >
          <span aria-hidden="true" className="w-[18px] shrink-0 font-mono text-[11px] leading-5">{index + 1}</span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-xs leading-5 font-medium">
              <span>{step.label}</span>
              <span id={`${row}-tag`} className={classes("ml-auto shrink-0 rounded-full bg-raised px-1.5 text-[11px] leading-4", index === 0 ? "text-beam-text" : "text-ink-muted")}>{tag}</span>
            </span>
            <span id={`${row}-hint`} className="block text-[11px] leading-4 text-ink-faint">{STEP_HINTS[step.id]}</span>
            <span id={`${row}-state`}><StateBadge state={state} /></span>
          </span>
        </button>
      </Tooltip>
    </li>
  );
};

/**
 * Set up as the whole window (docs/specs/gui.md, "Set up in the window";
 * ADR 0016; setup-copy.md §4.4): "Setting up:" with the computer picker (the
 * one the last `environment` pane picked, else the home environment) and
 * Close across the top, the eleven steps on a rail with their state words,
 * and the chosen step's card beside it; a line in their place while there is
 * no computer, and one saying it reads the computer's setup until the first
 * result comes. Opening it, or pointing it at another computer, checks every
 * step there; the window regaining focus checks the shown step again.
 */
export const ChecklistView = () => {
  const phone = usePhoneSettings();
  const { step: shown, choose, close } = useChecklist();
  const picked = usePickedEnvironment();
  const view = useSetupView(picked?.environmentId);
  useCheckOnOpen(picked?.environmentId);
  useCheckOnFocus(picked?.environmentId, shown);
  const heading = useId();
  const railId = useId();
  const [railOpen, setRailOpen] = useState(false);
  const frame = useWindowFrame();
  const step = view?.steps.find((candidate) => candidate.id === shown);
  const reading = view === undefined || (view.reach.status === "reachable" && !view.steps.some((candidate) => candidate.registered));
  const rail = (
    <nav id={railId} aria-label="Set up steps" className="flex w-[280px] max-w-full min-h-0 shrink-0 flex-col overflow-y-auto border-r border-hairline bg-panel px-2.5 pt-4 pb-2.5">
      <ol className="flex flex-col gap-0.5">
        {view?.steps.map((candidate, index) => (
          <RailRow
            key={candidate.id}
            step={candidate}
            index={index}
            state={stepState(view, candidate)}
            shown={candidate.id === shown}
            choose={() => { choose(candidate.id); setRailOpen(false); }}
          />
        ))}
      </ol>
    </nav>
  );
  return (
    <section data-phone-setup aria-labelledby={heading} className="flex h-dvh min-h-0 flex-col overflow-hidden bg-abyss text-ink">
      <header {...nativeFrame(frame)} className="flex h-11 shrink-0 items-center gap-4 border-b border-hairline bg-panel px-4">
        <h1 id={heading} className="text-base font-semibold text-ink">
          Set up
        </h1>
        <Tooltip content="Choose a computer to set up" keys="Tab, arrow keys">
          <span className="inline-flex items-center gap-2"><ListChecks aria-hidden="true" className="size-4 text-ink-muted" /><EnvironmentPicker label="Setting up:" /></span>
        </Tooltip>
        <Tooltip content="Close Set up" keys="Tab, Enter">
          <Button aria-label="Close Set up" className="ml-auto" onClick={close}><X aria-hidden="true" />Close</Button>
        </Tooltip>
        <WindowControls state={frame} />
      </header>
      <CredentialNoticeHost />
      {picked === undefined ? (
        <p className="px-4 py-[34px] text-sm text-ink-muted md:px-10">Choose a computer to set up.</p>
      ) : (
        <>
          {view !== undefined && <ReachLine view={view} environment={picked} />}
          {reading && <p role="status" className="border-b border-hairline px-4 py-2 text-sm text-ink-muted">Reading {picked.name ?? "this computer"}&apos;s setup…</p>}
          <div className="relative flex min-h-0 flex-1 flex-col min-[640px]:flex-row">
            {phone ? <PhoneNavigation title="Set up steps" open={railOpen} onOpenChange={setRailOpen}>{rail}</PhoneNavigation> : rail}
            {step !== undefined && view !== undefined && <StepCard key={`${picked.environmentId} ${step.id}`} environmentId={picked.environmentId} step={step} state={stepState(view, step)} computer={picked.name} />}
          </div>
        </>
      )}
    </section>
  );
};
