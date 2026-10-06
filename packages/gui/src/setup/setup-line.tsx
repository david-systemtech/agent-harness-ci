import { homeEnvironment } from "@agent-harness/client-runtime";
import { FIRST_ROW, STEP_LABELS } from "@agent-harness/contracts";
import { ListChecks } from "lucide-react";
import { useFirstKey } from "../keys/key-dispatch.js";
import { nameOf } from "../connections/words.js";
import { useSettings } from "../settings/settings-window.js";
import { Button, Tooltip } from "../ui/index.js";
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
  const keys = useFirstKey("app.settings.toggle");
  if (home === undefined || view === undefined) return null;
  const { attention } = view.counts;
  if (attention.length === 0) return null;
  const label = `Set up: ${attention.length} ${attention.length === 1 ? "needs" : "need"} attention`;
  const detail = `Set up on ${nameOf(home)}: ${attention.length} ${attention.length === 1 ? "step needs" : "steps need"} attention (${attention.map((step) => STEP_LABELS[step]).join(", ")})`;
  return <Tooltip content={detail} keys={keys}>
    <Button aria-label={label} size="xs" variant="ghost" className="h-[22px] max-w-40 text-amber border border-amber/45 bg-amber/10 hover:bg-amber/20" onClick={() => open(FIRST_ROW, home.environmentId)}>
      <ListChecks aria-hidden="true" /><span className="truncate">{label}</span>
    </Button>
  </Tooltip>;
};
