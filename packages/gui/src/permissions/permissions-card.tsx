import { restoredOutcome, type ActionOutcome } from "@agent-harness/client-runtime";
import type { DenylistSection } from "@agent-harness/contracts";
import { useState } from "react";
import type { StepCardProps } from "../setup/cards.js";
import { StepStatus, type CardRestore } from "../setup/step-status.js";
import { useObservable, useRuntime } from "../window-context.js";
import { RestorePresetsDialog } from "./denylist.js";
import { PermissionsForm } from "./permissions-pane.js";
import { useDenylist } from "./use-denylist.js";

/** A restore the card waits on a person for: the sections it names (none, every section), and how to answer the step's action. */
interface Asking {
  readonly sections: readonly DenylistSection[] | undefined;
  readonly answer: (outcome: ActionOutcome | null) => void;
}

/**
 * The Permissions step's card (the Set up specification, "10. Permissions";
 * ADR 0006; #594): where the step stands, then the permissions spec's form
 * as the Permissions row draws it (#415): the default ceiling, the
 * unattended mode with the bypass sentence and its acknowledgement, the
 * parked-prompt TTL, the containment default with each level's availability,
 * and the denylist's four sections with Test and Restore presets. The
 * step's Restore puts back the presets of the sections it names, or of
 * every section, after the one confirmation a section's Restore presets
 * asks, through the denylist the card shows, so what it put back shows at
 * once. Done once set or preset, it asks for nothing until a check fails.
 */
export const PermissionsCard = ({ environmentId, step }: StepCardProps) => {
  const runtime = useRuntime();
  const view = useObservable(runtime.projections.environments).find((environment) => environment.environmentId === environmentId);
  const denylist = useDenylist(environmentId);
  const [asking, setAsking] = useState<Asking | undefined>(undefined);
  const restore: CardRestore = (plan) => new Promise((answer) => setAsking({ sections: plan.sections, answer }));
  /** Stops asking, and answers the step's action as `then` does. */
  const settle = (then: (asked: Asking) => void) => {
    if (asking === undefined) return;
    setAsking(undefined);
    then(asking);
  };
  return (
    <>
      <StepStatus environmentId={environmentId} step={step} restore={restore} />
      {view !== undefined && <PermissionsForm view={view} denylist={denylist} />}
      <RestorePresetsDialog
        open={asking !== undefined}
        sections={asking?.sections}
        cancel={() => settle((asked) => asked.answer(null))}
        restore={() => settle((asked) => void denylist.restore(asked.sections).then((restored) => asked.answer(restoredOutcome(restored))))}
      />
    </>
  );
};
