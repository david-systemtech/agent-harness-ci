import { Button } from "../ui/index.js";
import { SettingsRail } from "./rail.js";
import { RowPane } from "./row-pane.js";
import { useSettings } from "./settings-window.js";

/**
 * Settings (docs/specs/gui.md, "Settings: the rail, the rows and the
 * addresses"; ADR 0027): the rail on the left, the pane of the row open on
 * the right, and the control that closes it. It takes the window below the
 * header while it is open.
 */
export const SettingsView = () => {
  const { row, close } = useSettings();
  return (
    <section aria-label="Settings" className="flex min-h-0 flex-1 bg-abyss text-ink">
      <SettingsRail current={row} />
      <RowPane key={row} row={row} />
      <Button aria-label="Close Settings" className="m-3 shrink-0" onClick={close}>
        Close
      </Button>
    </section>
  );
};
