import { readdir } from "node:fs/promises";
import { sceneName } from "./scene-registry.js";

/** Read filenames only: component modules are renderer code, never Node capture dependencies. */
export async function sceneFiles(directory: string): Promise<readonly string[]> {
  return (await readdir(directory, { withFileTypes: true }))
    .filter((file) => file.isFile() && file.name.endsWith(".tsx"))
    .map((file) => sceneName(file.name)).sort();
}

/** look.md §16 names the light subset; every other scene still gets the dark ladder. */
export function captureCases(scenes: readonly string[]) {
  const light = (scene: string) => /^(window-empty|window-not-ready|window-start-failed|primitives|session-conversation|session-tools|dock-diff|prompt-.*|composer-.*|status-line|context-usage|run-picker.*|palette-.*|dialogs|dialog-.*|notices|settings-accounts|settings-permissions|settings-theme|setup-introduction.*|setup-account|setup-appearance|setup-close-confirmation)$/.test(scene);
  return scenes.flatMap((scene) => (light(scene) ? ["light", "dark"] as const : ["dark"] as const).map((ladder) => ({ scene, ladder, name: `${scene}.${ladder}` })));
}
