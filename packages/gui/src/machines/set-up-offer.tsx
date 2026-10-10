import { ListChecks, X } from "lucide-react";
import type { EnvironmentView } from "@agent-harness/client-runtime";
import { STEP_ORDER } from "@agent-harness/contracts";
import { nameOf } from "../connections/words.js";
import { useSettings } from "../settings/settings-window.js";
import { useChecklist } from "../setup/checklist-window.js";
import { Button } from "../ui/index.js";
import { useRuntime } from "../window-context.js";

/**
 * Set up this machine (ADR 0025): the checklist's picker switched to the
 * environment and every step there checked, then the full checklist opened
 * on its first step needing attention, or its first step when none does or
 * the check could not run.
 */
export const useSetUpThisMachine = () => {
  const runtime = useRuntime();
  const { pick } = useSettings();
  const { open } = useChecklist();
  return async (environmentId: string): Promise<void> => {
    pick(environmentId);
    const answer = await runtime.setup.check(environmentId);
    const first = answer.ok ? runtime.projections.setup(environmentId).read().counts.attention[0] : undefined;
    open(first ?? STEP_ORDER[0]);
  };
};

/**
 * What a card Add a machine made offers (ADR 0025; the Set up spec, "Your
 * machines"; #577): Set up this machine, or Not now, which leaves the card.
 */
export const SetUpOffer = ({ view, decline }: { readonly view: EnvironmentView; readonly decline: () => void }) => {
  const setUp = useSetUpThisMachine();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="text-sm text-ink">Paired with {nameOf(view)}: set it up now?</p>
      <Button variant="default" onClick={() => void setUp(view.environmentId)} title="Set up this machine (Enter or Space)">
        <ListChecks aria-hidden="true" data-icon="inline-start" />Set up this machine
      </Button>
      <Button onClick={decline} title="Not now (Enter or Space)"><X aria-hidden="true" data-icon="inline-start" />Not now</Button>
    </div>
  );
};
