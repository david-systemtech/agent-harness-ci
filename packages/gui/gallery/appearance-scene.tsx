import type { SettingsRowId } from "@agent-harness/contracts";
import type { SceneModule } from "./scene-registry.js";

/** Real Settings on the gallery-owned window, over invented environment and tool readings. */
export function appearanceScene(row: SettingsRowId, selector: string): Required<Pick<SceneModule, "script" | "presentation" | "activate" | "readySelector">> {
  return {
    script: { environments: [{ name: "desk", reach: "local", capabilities: ["managedTools"], keyManagers: { tools: [
      { tool: "bao", minimum: "2.1.1", status: "not-installed", action: "install" },
      { tool: "gh", version: "2.63.2", latest: "2.63.2", minimum: "2.40.0", method: "homebrew", status: "current", action: "update" },
    ] },
    // Its channel read once, so About says this client's build is the newest rather than waiting for that read (#1753).
    updates: { status: { lastCheck: { at: "2026-01-01T00:00:00.000Z", result: "ok" } } } }] },
    presentation: { settingsRow: row },
    activate() {
      // The window's normal settings key opens the pane selected by its saved row.
      document.dispatchEvent(new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true }));
    },
    readySelector: selector,
  };
}
