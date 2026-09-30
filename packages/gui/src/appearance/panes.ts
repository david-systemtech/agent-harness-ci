import type { SettingsRowId } from "@agent-harness/contracts";
import type { ComponentType } from "react";
import { ShortcutsPane } from "./shortcuts-pane.js";
import { ThemePane } from "./theme-pane.js";

/** The Appearance band's two `client` rows (ADR 0027): each pane, keyed by its row. */
export const APPEARANCE_PANES: Partial<Readonly<Record<SettingsRowId, ComponentType>>> = {
  "appearance.theme": ThemePane,
  "appearance.shortcuts": ShortcutsPane,
};
