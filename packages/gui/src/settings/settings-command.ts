import { noSettingsRowLine, settingsRowNamed } from "@agent-harness/client-runtime";
import { useSlashCommand } from "../composer/slash-commands.js";
import { usePaneLine } from "../session/pane-line.js";
import { useSettings } from "./settings-window.js";

/** What the pane says when `/settings <typed>` names no row: the client runtime's words, then where the window finds one. */
const noRowLine = (typed: string): string => `${noSettingsRowLine(typed)} Settings' search finds a row by its label or an old name.`;

/**
 * `/settings [row]` in a session pane's composer (docs/specs/gui.md,
 * "Settings: the rail, the rows and the addresses"; #625): bare, it opens
 * Settings on the last row opened; with an existing address or a row id
 * (`settingsRowNamed`, as the deep link reads one), on that row; any other
 * name opens nothing and says so on the pane's line. A row opens on the
 * pane's environment where its pane picks one, as the terminal UI's
 * `/settings` edits the open session's environment.
 */
export const useSettingsCommand = (environmentId: string): void => {
  const settings = useSettings();
  const [, say] = usePaneLine();
  useSlashCommand("settings", (named) => {
    if (named === "") return settings.open(null, environmentId);
    const row = settingsRowNamed(named);
    if (row === undefined) return say(noRowLine(named));
    settings.open(row, environmentId);
  });
};
