import { countsWords, stepLine } from "@agent-harness/client-runtime";
import { useState } from "react";
import { nameOf } from "../connections/words.js";
import { usePickedEnvironment, useSettings } from "../settings/settings-window.js";
import { classes } from "../ui/classes.js";
import { RotateCw } from "lucide-react";
import { DialogAction as Button } from "../ui/dialog-action.js";
import { Tooltip } from "../ui/tooltip.js";
import { STEP_ICONS } from "./step-card.js";
import { useRuntime } from "../window-context.js";
import { useChecklist } from "./checklist-window.js";
import { HealthDot } from "./health-dot.js";
import { ReachLine } from "./reach-line.js";
import { useCheckOnOpen, useSetupView } from "./use-setup.js";

/**
 * The Set up pane, `setup.checklist` (ADR 0027; docs/specs/gui.md, "Set up
 * in the window"): the counts on the environment its picker checks, Re-run
 * (every step checked, then the full checklist opened on the first step
 * needing attention), Open the full checklist, Set up another machine (Your
 * machines at Add a machine, #577), and each step with its dot and its
 * line, named by a link to its home row. Opening it, or picking another
 * environment, checks every step there.
 */
export const SetupPane = () => {
  const runtime = useRuntime();
  const picked = usePickedEnvironment();
  const view = useSetupView(picked?.environmentId);
  useCheckOnOpen(picked?.environmentId);
  const { open: openChecklist } = useChecklist();
  const { open: openRow } = useSettings();
  const [line, setLine] = useState<string | undefined>(undefined);
  if (picked === undefined || view === undefined) return null;
  const { environmentId } = picked;
  const now = runtime.environmentNow(environmentId);

  const rerun = async () => {
    setLine(undefined);
    const answer = await runtime.setup.check(environmentId);
    if (!answer.ok) return setLine(`Not checked: ${answer.error.message}`);
    const first = runtime.projections.setup(environmentId).read().counts.attention[0];
    if (first === undefined) setLine(`Every step ${nameOf(picked)} checks passes.`);
    else openChecklist(first);
  };

  return (
    <>
      <ReachLine view={view} environment={picked} />
      <p className="text-sm text-ink">{countsWords(view.counts)}</p>
      <div className="flex flex-wrap gap-2">
        <Button icon={RotateCw} variant="default" onClick={() => void rerun()}>
          Re-run
        </Button>
        <Button onClick={() => openChecklist()}>Open the full checklist</Button>
        <Button onClick={() => openRow("environments.machines", undefined, "add-a-machine")}>Set up another machine</Button>
      </div>
      {line !== undefined && <p className="text-sm text-ink-muted">{line}</p>}
      <ol data-setup-summary aria-label="Steps" className="flex flex-col gap-1">
        {view.steps.map((step, index) => (
          <li key={step.id} className="flex min-w-0 items-center gap-2">
            <span aria-hidden="true" className="w-[18px] shrink-0 text-right font-mono text-xs text-ink-faint">{index + 1}</span>
            <span className="flex w-1.5 shrink-0 justify-center">
              <HealthDot state={step.result?.state ?? null} of={step.label} />
            </span>
            <Button icon={STEP_ICONS[step.id]} size="sm" className={classes("w-36 shrink-0 justify-start", !step.registered && "text-ink-faint")} onClick={() => openRow(step.home, environmentId)}>
              {step.label}
            </Button>
            {/* Cut short at a narrow width: the whole line on hover, and on keyboard focus (#1698). */}
            <Tooltip content={stepLine(step, now)}>
              <span tabIndex={0} className="min-w-0 truncate rounded-sm text-xs text-ink-muted outline-none focus-visible:outline-2 focus-visible:outline-beam">{stepLine(step, now)}</span>
            </Tooltip>
          </li>
        ))}
      </ol>
    </>
  );
};
