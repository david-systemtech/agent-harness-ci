import { Settings as SettingsIcon } from "lucide-react";
import { useFirstKey } from "../keys/key-dispatch.js";
import { Button, Tooltip } from "../ui/index.js";
import { useSettings } from "./settings-window.js";

/** Opens Settings from the header, with the shortcut currently in force. */
export const SettingsControl = () => {
  const settings = useSettings();
  const key = useFirstKey("app.settings.toggle");
  return (
    <Tooltip content="Settings" keys={key}>
      <Button aria-label="Settings" className="h-7 px-2 text-xs" onClick={() => settings.open()}>
        <SettingsIcon aria-hidden="true" size={16} />
        Settings
      </Button>
    </Tooltip>
  );
};
