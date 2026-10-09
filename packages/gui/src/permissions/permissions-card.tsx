import { plainRefusal, restoredOutcome, sandboxSetup, SETUP_ACTION_WORDS, type ActionOutcome } from "@agent-harness/client-runtime";
import type { DenylistSection } from "@agent-harness/contracts";
import { useMemo, useState, type ReactNode } from "react";
import type { StepCardProps } from "../setup/cards.js";
import { MoreOptions } from "../setup/more-options.js";
import { StepStatus, type CardRestore } from "../setup/step-status.js";
import { checkSetup } from "../setup/use-setup.js";
import { useSettingsValues } from "../settings/settings-values.js";
import { useObservable, useRuntime } from "../window-context.js";
import { RestorePresetsDialog } from "./denylist.js";
import { FieldError } from "./field-error.js";
import { PermissionsForm, type SafetySettings } from "./permissions-pane.js";
import { SandboxSetupFold } from "./sandbox-setup.js";
import { useDenylist } from "./use-denylist.js";

/** A restore the card waits on a person for: the sections it names (none, every section), and how to answer the step's action. */
interface Asking {
  readonly sections: readonly DenylistSection[] | undefined;
  readonly answer: (outcome: ActionOutcome | null) => void;
}

/** The step's safety settings sit in its one fold, named as setup-copy.md §5.12 names it. */
const MoreSafety: SafetySettings = ({ children }) => <MoreOptions step="permissions" label="More safety settings">{children}</MoreOptions>;

/**
 * The Permissions step's card (setup-copy.md §5.12; the Set up
 * specification, "10. Permissions"; ADR 0006; #594, #1858): where the step
 * stands, then how much agents may do without asking as four plain
 * choices, and More safety settings holding scheduled runs, the timeout of
 * a question nobody answers, the sandbox and the always-ask list. A sandbox
 * this computer cannot give offers Turn the sandbox off, which writes the
 * default off and checks the step again, and How to fix it with the OS's
 * commands. The step's Restore them puts back the built-in entries of the
 * lists it names, or of every list, after the one confirmation a list's
 * own Restore asks, through the list the card shows, so what it put back
 * shows at once. Done once set or preset, it asks for nothing until a
 * check fails.
 */
export const PermissionsCard = ({ environmentId, step }: StepCardProps) => {
  const runtime = useRuntime();
  const view = useObservable(runtime.projections.environments).find((environment) => environment.environmentId === environmentId);
  const denylist = useDenylist(environmentId);
  const settings = useSettingsValues(environmentId);
  const permissions = useObservable(useMemo(() => runtime.requests.cached(environmentId, "permissions.settings.get", {}), [runtime, environmentId]));
  const [asking, setAsking] = useState<Asking | undefined>(undefined);
  const [turning, setTurning] = useState(false);
  const [refused, say] = useState<{ readonly line: string; readonly details: readonly string[] }>();
  const restore: CardRestore = (plan) => new Promise((answer) => setAsking({ sections: plan.sections, answer }));
  /** Stops asking, and answers the step's action as `then` does. */
  const settle = (then: (asked: Asking) => void) => {
    if (asking === undefined) return;
    setAsking(undefined);
    then(asking);
  };
  const turnOff = () => {
    setTurning(true);
    say(undefined);
    void settings
      .save("permissions.containment.default", "off")
      .then((saved) => {
        if (saved.ok) return void checkSetup(runtime, environmentId, "permissions");
        say(saved.refusal === undefined ? { line: saved.line, details: [] } : plainRefusal(saved.refusal, SETUP_ACTION_WORDS["turn-sandbox-off"]));
      })
      .finally(() => setTurning(false));
  };
  const chosen = settings.values?.["permissions.containment.default"];
  const report = permissions.result?.containment;
  const availability = report?.levels.find((level) => level.level === chosen);
  const fixFold: ReactNode =
    step.result?.failing.includes("permissions.containment") === true && report !== undefined && availability !== undefined && !availability.available
      ? <SandboxSetupFold summary="How to fix it" setups={[sandboxSetup(availability, report.container.declared || report.container.detected)]} />
      : undefined;
  const writable = view?.phase === "ready" && runtime.capability(environmentId, "permissions.settings.set").status === "present";
  return (
    <>
      <StepStatus
        environmentId={environmentId}
        step={step}
        restore={restore}
        actions={{ "turn-sandbox-off": { disabled: !writable || turning, run: turnOff } }}
        {...(fixFold !== undefined && { fixFold })}
      />
      {refused !== undefined && <FieldError line={refused.line} details={refused.details} />}
      {view !== undefined && <PermissionsForm view={view} denylist={denylist} safety={MoreSafety} />}
      <RestorePresetsDialog
        open={asking !== undefined}
        sections={asking?.sections}
        cancel={() => settle((asked) => asked.answer(null))}
        restore={() => settle((asked) => void denylist.restore(asked.sections).then((restored) => asked.answer(restoredOutcome(restored))))}
      />
    </>
  );
};
