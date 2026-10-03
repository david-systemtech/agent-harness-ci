import { SETTINGS, SETTINGS_ROWS, type SettingsKey, type SettingsRowId } from "@agent-harness/contracts";
import { noSettingsRowLine, rowKeys } from "@agent-harness/client-runtime";

/**
 * `/settings`, the generic editor (docs/specs/tui.md, "Status, usage,
 * pickers"; the session-state spec's `settings.get` and `settings.update`):
 * every key of the contracts' settings table under the label of the row it
 * sits on (ADR 0027: the terminal UI needs no rail, and opens its editor by
 * row id). How a key is drawn, typed and written is the client runtime's
 * (`settings/editor.ts`), which the window's generic editor shares; this is
 * what the terminal lists: the rows and their keys, and the words for a row
 * that is not one.
 */

/** A row of Settings as the editor lists it: its id and label, and the keys that sit on it in the table's order. */
export interface EditorRow {
  readonly id: SettingsRowId;
  readonly label: string;
  readonly keys: readonly SettingsKey[];
}

const EDITOR_ROWS: readonly EditorRow[] = SETTINGS_ROWS.map((row) => ({ id: row.id, label: row.label, keys: rowKeys(row.id) }));

/** The rows that hold keys, in the rail's order: what `/settings` lists. */
export const ROWS_WITH_KEYS: readonly SettingsRowId[] = EDITOR_ROWS.filter((row) => row.keys.length > 0).map((row) => row.id);

/** What the editor lists: every row holding keys, or the one row asked for by its id, keys or none. */
export const editorRows = (id: SettingsRowId | null): readonly EditorRow[] =>
  id === null ? EDITOR_ROWS.filter((row) => row.keys.length > 0) : EDITOR_ROWS.filter((row) => row.id === id);

/** The keys the editor lists, in its order: what its cursor moves over. */
export const editorKeys = (id: SettingsRowId | null): readonly SettingsKey[] => editorRows(id).flatMap((row) => row.keys);

/** What `/settings <id>` says when no row has the id: the client runtime's words, then the rows holding settings. */
export const noRowLine = (typed: string): string => `${noSettingsRowLine(typed)} The rows holding settings: ${ROWS_WITH_KEYS.join(", ")}.`;

/** The human label used for key titles and editing prompts. */
export const settingLabel = (key: SettingsKey): string => SETTINGS[key].label;
