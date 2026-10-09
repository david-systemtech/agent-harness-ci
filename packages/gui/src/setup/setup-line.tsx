import { homeEnvironment } from "@agent-harness/client-runtime";
import { STEP_LABELS } from "@agent-harness/contracts";
import { ListChecks } from "lucide-react";
import { nameOf } from "../connections/words.js";
import { useSettings } from "../settings/settings-window.js";
import { Button, Tooltip } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";
import { useChecklist } from "./checklist-window.js";
import { useSetupView } from "./use-setup.js";

/**
 * The header's Set up chip (docs/specs/gui.md, "The window and the
 * sidebar"; setup-copy.md §4.5): while a step on the home environment needs
 * a fix, how many, whole, for the header gives it the width it needs; it
 * opens Set up there at the first step needing one. Nothing otherwise.
 */
export const SetupLine = () => {
  const home = homeEnvironment(useObservable(useRuntime().projections.environments));
  const view = useSetupView(home?.environmentId);
  const { pick } = useSettings();
  const { open } = useChecklist();
  if (home === undefined || view === undefined) return null;
  const [first, ...rest] = view.counts.attention;
  if (first === undefined) return null;
  const count = rest.length + 1;
  const label = `Set up: ${count} to fix`;
  const detail = `Set up on ${nameOf(home)}: ${count} ${count === 1 ? "step needs" : "steps need"} a fix (${view.counts.attention.map((step) => STEP_LABELS[step]).join(", ")})`;
  return <Tooltip content={detail}>
    <Button aria-label={label} size="xs" variant="ghost" className="h-[22px] shrink-0 text-amber border border-amber/45 bg-amber/10 hover:bg-amber/20" onClick={() => { pick(home.environmentId); open(first); }}>
      <ListChecks aria-hidden="true" /><span>{label}</span>
    </Button>
  </Tooltip>;
};
