import { countsWords, plainRefusal, stepLine, stepNote, type RefusedAnswer, type SetupStepView } from "@agent-harness/client-runtime";
import { PRODUCT_NAME } from "@agent-harness/contracts";
import { useState } from "react";
import { nameOf } from "../connections/words.js";
import { usePickedEnvironment, useSettings } from "../settings/settings-window.js";
import { classes } from "../ui/classes.js";
import { RotateCw } from "lucide-react";
import { DialogAction as Button } from "../ui/dialog-action.js";
import { STEP_ICONS } from "./step-card.js";
import { useRuntime } from "../window-context.js";
import { useChecklist } from "./checklist-window.js";
import { SetupNotice } from "./notice.js";
import { ReachLine } from "./reach-line.js";
import { StateBadge } from "./state-badge.js";
import { useDetails } from "./use-details.js";
import { useCheckOnOpen, useSetupView } from "./use-setup.js";

/** What the last Check everything again found, on the environment it checked: every step fine, or the check refused. */
type Checked = { readonly environmentId: string } & ({ readonly passed: true } | { readonly passed: false; readonly refusal: RefusedAnswer });

/**
 * The Set up pane, `setup.checklist` (ADR 0027; docs/specs/gui.md, "Set up
 * in the window"; setup-copy.md §4.5): the counts on the environment its
 * picker checks, Check everything again (every step checked, then Set up
 * opened on the first step needing a fix), Open Set up, Set up another
 * computer (Your machines at Add a machine, #577), and each step with its
 * state word and its whole line, opening Set up at it. Opening it, or
 * picking another environment, checks every step there.
 */
export const SetupPane = () => {
  const runtime = useRuntime();
  const picked = usePickedEnvironment();
  const view = useSetupView(picked?.environmentId);
  useCheckOnOpen(picked?.environmentId);
  const { open: openChecklist } = useChecklist();
  const { open: openRow } = useSettings();
  const details = useDetails();
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<Checked | undefined>(undefined);
  if (picked === undefined || view === undefined) return null;
  const { environmentId } = picked;
  const name = nameOf(picked);
  const now = runtime.environmentNow(environmentId);
  /** A step's line and, after it, when it was checked or that it may be out of date. */
  const said = (step: SetupStepView) => [stepLine(step, now), stepNote(step, now, name)].filter((words) => words !== undefined).join(" ");
  const refused = `${PRODUCT_NAME} could not check ${name}.`;
  const shown = checked?.environmentId === environmentId ? checked : undefined;

  const checkEverything = async () => {
    setChecked(undefined);
    setChecking(true);
    const answer = await runtime.setup.check(environmentId).finally(() => setChecking(false));
    if (!answer.ok) return setChecked({ environmentId, passed: false, refusal: answer.error });
    const first = runtime.projections.setup(environmentId).read().counts.attention[0];
    if (first === undefined) setChecked({ environmentId, passed: true });
    else openChecklist(first);
  };

  return (
    <>
      <ReachLine view={view} environment={picked} />
      <p className="text-sm text-ink">{countsWords(view.counts)}</p>
      <div className="flex flex-wrap gap-2">
        <Button icon={RotateCw} variant="default" disabled={checking} aria-busy={checking} onClick={() => void checkEverything()}>
          {checking ? "Checking…" : "Check everything again"}
        </Button>
        <Button onClick={() => openChecklist()}>Open Set up</Button>
        <Button onClick={() => openRow("environments.machines", undefined, "add-a-machine")}>Set up another computer</Button>
      </div>
      {shown?.passed === true && <p role="status" className="text-sm text-ink-muted">Everything on {name} is set up.</p>}
      {shown?.passed === false && (
        <SetupNotice
          tone="error"
          title={refused}
          description="Choose Check everything again."
          details={details({ computer: { name }, line: `${refused} Choose Check everything again.`, details: plainRefusal(shown.refusal, "Check everything again").details })}
        />
      )}
      <div className="@container">
        <ol data-setup-summary aria-label="Steps" className="grid grid-cols-[auto_auto_auto] gap-x-2 gap-y-1 @[36rem]:grid-cols-[auto_auto_auto_minmax(0,1fr)]">
          {view.steps.map((step, index) => (
            <li key={step.id} className="col-span-full grid grid-cols-subgrid items-center">
              <span aria-hidden="true" className="w-[18px] text-right font-mono text-xs text-ink-faint">{index + 1}</span>
              <StateBadge state={step.pending ? "pending" : step.result?.state ?? "unchecked"} />
              <Button icon={STEP_ICONS[step.id]} size="sm" className={classes("w-36 justify-start", !step.registered && "text-ink-faint")} onClick={() => openChecklist(step.id)}>
                {step.label}
              </Button>
              {/* Never cut: beside the label where the pane is wide, beneath it where it is not (setup-copy.md §3). */}
              <span data-step-line className="col-start-2 col-span-2 min-w-0 pb-1 text-xs break-words text-ink-muted @[36rem]:col-span-1 @[36rem]:col-start-auto @[36rem]:pb-0">{said(step)}</span>
            </li>
          ))}
        </ol>
      </div>
    </>
  );
};
