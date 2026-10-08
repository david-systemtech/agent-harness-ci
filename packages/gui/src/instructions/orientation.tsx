import type { EnvironmentView } from "@agent-harness/client-runtime";
import { NO_ACCOUNT_ORIENTATION_LINE, STEP_LABELS, unreadSetupLine, unreadSetupSteps, type OrientationRow, type StepId } from "@agent-harness/contracts";
import { ArrowRight, Lock, Power } from "lucide-react";
import { useState } from "react";
import { Part } from "../settings/part.js";
import { useSettingsValues } from "../settings/settings-values.js";
import { useSettings } from "../settings/settings-window.js";
import { useChecklist } from "../setup/checklist-window.js";
import { Button, Switch, Tooltip, Fold } from "../ui/index.js";
import { Markdown } from "../transcript/markdown.js";
import { useRuntime } from "../window-context.js";
import { InstructionAccounts } from "./instruction-accounts.js";

/** The fold, and the Settings part, that hold what the orientation block tells agents (setup-copy.md §5.10). */
const ORIENTATION_TITLE = "What agents are told about this computer";

/**
 * Go to {Step} for each step whose part of this computer's setup the block
 * could not read (setup-copy.md §5.10): the step inside Set up, on this
 * environment, opening Set up when it is not shown.
 */
export const GoToSteps = ({ environmentId, steps }: { readonly environmentId: string; readonly steps: readonly StepId[] }) => {
  const { pick } = useSettings();
  const checklist = useChecklist();
  const go = (step: StepId) => {
    pick(environmentId);
    if (checklist.shown) checklist.choose(step);
    else checklist.open(step);
  };
  return (
    <div data-go-to-steps className="flex flex-wrap gap-2">
      {steps.map((step) => (
        <Tooltip key={step} content={`Go to ${STEP_LABELS[step]}`} keys="Tab, Enter">
          <Button variant="outline" onClick={() => go(step)}><ArrowRight aria-hidden="true" />Go to {STEP_LABELS[step]}</Button>
        </Tooltip>
      ))}
    </div>
  );
};

/**
 * What agents are told about this computer: the rendered block, read-only,
 * and the environment's switch for it, the only thing here that is written.
 * In Set up it is a fold whose unread parts the step's line names; in
 * Settings it is a part that names them itself, with the accounts it reaches.
 */
export const Orientation = ({ view, row, setup = false }: { readonly view: EnvironmentView; readonly row: OrientationRow; readonly setup?: boolean }) => {
  const runtime = useRuntime();
  const settings = useSettingsValues(view.environmentId);
  const [line, say] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const offer = runtime.capability(view.environmentId, "settings.update");
  const on = settings.values?.["instructions.orientation"];
  const unread = unreadSetupSteps(row.unreadRegistries);
  const save = async (enabled: boolean) => {
    say(undefined);
    setSending(true);
    try {
      const answer = await settings.save("instructions.orientation", enabled);
      if (!answer.ok) say(`Not saved: ${answer.line}`);
    } finally {
      setSending(false);
    }
  };
  const preview = row.text === null ? (setup ? null : <p className="text-sm text-ink-muted">{NO_ACCOUNT_ORIENTATION_LINE}</p>) : <div className="text-sm leading-[1.6]"><Markdown text={row.text} /></div>;
  const body = (
    <>
      <label className="flex items-center gap-2 text-sm text-ink">
        <Tooltip content="Tell agents about this computer" keys="Space"><Switch
          aria-label="Tell agents about this computer"
          checked={typeof on === "boolean" ? on : row.enabled}
          disabled={sending || offer.status === "absent" || settings.values === null}
          onCheckedChange={(enabled) => void save(enabled)}
        /></Tooltip>
        <Power aria-hidden="true" className="size-3.5" />Tell agents about this computer
        {!setup && <span className="flex items-center gap-1 rounded-md border border-hairline px-1 text-2xs text-ink-muted"><Lock aria-hidden="true" className="size-3" />Built-in</span>}
      </label>
      <p className="text-sm text-ink-muted">If you turn this off, agents will not know where your forges, keys and notebooks are.</p>
      {offer.status === "absent" && <p className="text-xs text-ink-faint">{offer.message}</p>}
      {preview}
      {!setup && row.unreadRegistries.length > 0 && (
        <>
          <p className="text-sm text-amber">{unreadSetupLine(unread)}</p>
          <GoToSteps environmentId={view.environmentId} steps={unread} />
        </>
      )}
      {line !== undefined && (
        <p role="status" className="text-sm text-signal">
          {line}
        </p>
      )}
    </>
  );
  return setup ? (
    <Fold summary={ORIENTATION_TITLE} open={open} onOpenChange={setOpen}>
      <div className="flex flex-col gap-2">{body}</div>
    </Fold>
  ) : (
    <Part title={ORIENTATION_TITLE}>
      {body}
      <Fold summary="Source and accounts" open={open} onOpenChange={setOpen}>
        <p className="text-2xs text-ink-faint">Built from this environment's connected tools and memory banks at the start of a run.</p>
        <InstructionAccounts accounts={row.accounts} />
      </Fold>
    </Part>
  );
};
