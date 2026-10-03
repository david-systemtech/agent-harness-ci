import { readdir } from "node:fs/promises";
import { sceneName } from "./scene-registry.js";

/** Read filenames only: component modules are renderer code, never Node capture dependencies. */
export async function sceneFiles(directory: string): Promise<readonly string[]> {
  return (await readdir(directory, { withFileTypes: true }))
    .filter((file) => file.isFile() && file.name.endsWith(".tsx"))
    .map((file) => sceneName(file.name)).sort();
}

export function captureCases(scenes: readonly string[]) {
  return scenes.flatMap((scene) => (["light", "dark"] as const).map((ladder) => ({ scene, ladder, name: `${scene}.${ladder}` })));
}
