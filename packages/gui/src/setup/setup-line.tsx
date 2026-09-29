import { homeEnvironment } from "@agent-harness/client-runtime";
import { FIRST_ROW, STEP_LABELS } from "@agent-harness/contracts";
import { nameOf } from "../connections/words.js";
import { useSettings } from "../settings/settings-window.js";
import { Button } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";
import { useSetupView } from "./use-setup.js";

/**
 * The header's Set up line (docs/specs/gui.md, "The window and the
 * sidebar"; the Set up specification, "The checklist in the GUI"): while a
 * step on the home environment needs attention, how many and which, opening
 * the Set up pane on it; nothing otherwise.
 */
export const SetupLine = () => {
  const home = homeEnvironment(useObservable(useRuntime().projections.environments));
  const view = useSetupView(home?.environmentId);
  const { open } = useSettings();
  if (home === undefined || view === undefined) return null;
  const { attention } = view.counts;
  if (attention.length === 0) return null;
  const steps = attention.length === 1 ? "1 step needs" : `${attention.length} steps need`;
  return (
    <Button className="text-amber" onClick={() => open(FIRST_ROW, home.environmentId)}>
      Set up on {nameOf(home)}: {steps} attention ({attention.map((step) => STEP_LABELS[step]).join(", ")})
    </Button>
  );
};
