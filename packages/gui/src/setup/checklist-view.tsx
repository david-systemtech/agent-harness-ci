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
import { HealthDot } from "./health-dot.js";
import { ReachLine } from "./reach-line.js";
import { STEP_ICONS, StepCard } from "./step-card.js";
import { useCheckOnOpen, useSetupView } from "./use-setup.js";

/**
 * Set up as the whole window (docs/specs/gui.md, "Set up in the window";
 * ADR 0016): the environment it checks with a picker (the one the last
 * `environment` pane picked, else the home environment) and Close across the
 * top, the eleven steps on a rail with their dots, and the chosen step's
 * card beside it. Opening it, or pointing it at another environment, checks
 * every step there.
 */
export const ChecklistView = () => {
  const phone = usePhoneSettings();
  const { step: shown, choose, close } = useChecklist();
  const picked = usePickedEnvironment();
  const view = useSetupView(picked?.environmentId);
  useCheckOnOpen(picked?.environmentId);
  const heading = useId();
  const railId = useId();
  const [railOpen, setRailOpen] = useState(false);
  const frame = useWindowFrame();
  const step = view?.steps.find((candidate) => candidate.id === shown);
  const rail = (
    <nav id={railId} aria-label="Set up steps" className="flex w-[280px] max-w-full min-h-0 shrink-0 flex-col overflow-y-auto border-r border-hairline bg-panel px-2.5 pt-4 pb-2.5">
          <ol className="flex flex-col gap-0.5">
            {view?.steps.map((candidate, index) => {
              const Icon = STEP_ICONS[candidate.id];
              return (
                <li key={candidate.id}>
                  <Tooltip content={candidate.label} keys="Tab, Enter">
                    <button
                      type="button"
                      aria-label={candidate.label}
                      aria-current={candidate.id === shown ? "step" : undefined}
                      onClick={() => { choose(candidate.id); setRailOpen(false); }}
                      className={classes(
                        "flex min-h-[50px] w-full items-start gap-2.5 rounded-md border border-transparent p-2 text-left outline-none hover:bg-wash focus-visible:outline-2 focus-visible:outline-beam",
                        candidate.id === shown ? "border-hairline-strong bg-wash-strong" : undefined,
                        !candidate.registered ? "text-ink-faint" : candidate.id === shown ? "text-ink" : "text-ink-muted",
                      )}
                    >
                      <span aria-hidden="true" className="w-[18px] shrink-0 font-mono text-[11px] leading-5">{index + 1}</span>
                      <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 text-xs leading-5 font-medium">
                          <span>{candidate.label}</span><HealthDot state={candidate.result?.state ?? null} of={candidate.label} />
                          <span className={classes("ml-auto shrink-0 rounded-full bg-raised px-1.5 text-[11px] leading-4", index === 0 ? "text-beam-text" : "text-ink-muted")}>{index === 0 ? "Required" : "Optional"}</span>
                        </span>
                        <span className="block text-[11px] leading-4 text-ink-faint">{STEP_HINTS[candidate.id]}</span>
                      </span>
                    </button>
                  </Tooltip>
                </li>
              );
            })}
          </ol>
        </nav>
  );
  return (
    <section data-phone-setup aria-labelledby={heading} className="flex h-dvh min-h-0 flex-col overflow-hidden bg-abyss text-ink">
      <header {...nativeFrame(frame)} className="flex h-11 shrink-0 items-center gap-4 border-b border-hairline bg-panel px-4">
        <h1 id={heading} className="text-base font-semibold text-ink">
          Set up
        </h1>
        <Tooltip content="Choose an environment" keys="Tab, arrow keys">
          <span className="inline-flex items-center gap-2"><ListChecks aria-hidden="true" className="size-4 text-ink-muted" /><EnvironmentPicker /></span>
        </Tooltip>
        <Tooltip content="Close Set up" keys="Tab, Enter">
          <Button aria-label="Close Set up" className="ml-auto" onClick={close}><X aria-hidden="true" />Close</Button>
        </Tooltip>
        <WindowControls state={frame} />
      </header>
      <CredentialNoticeHost />
      {view !== undefined && picked !== undefined && <ReachLine view={view} environment={picked} />}
      <div className="relative flex min-h-0 flex-1 flex-col min-[640px]:flex-row">
        {phone ? <PhoneNavigation title="Set up steps" open={railOpen} onOpenChange={setRailOpen}>{rail}</PhoneNavigation> : rail}
        {step !== undefined && picked !== undefined && <StepCard key={`${picked.environmentId} ${step.id}`} environmentId={picked.environmentId} step={step} />}
      </div>
    </section>
  );
};
