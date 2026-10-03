import type { Script } from "@agent-harness/client-runtime/testing/scripted-environment";
import type { LadderName } from "@agent-harness/theme";
import type { ComponentType } from "react";

/** Every matching element must have these dimensions; missing selectors fail capture. */
export interface SceneGeometry {
  readonly selector: string;
  readonly width?: number;
  readonly height?: number;
  readonly tolerance?: number;
}

/** A scene file exports a default component or an app script, plus optional geometry. */
export interface SceneModule {
  readonly default?: ComponentType<{ readonly ladder: LadderName }>;
  readonly script?: Script;
  readonly geometry?: readonly SceneGeometry[];
}
export type SceneRegistry = Readonly<Record<string, SceneModule>>;

export function discoverScenes(modules: Readonly<Record<string, SceneModule>>): SceneRegistry {
  const registry = new Map<string, SceneModule>();
  for (const [path, scene] of Object.entries(modules)) {
    const name = sceneName(path);
    if (registry.has(name)) throw new Error(`Duplicate gallery scene: ${name}`);
    if (scene.default === undefined && scene.script === undefined) throw new Error(`Gallery scene ${name} exports neither a component nor a script.`);
    registry.set(name, scene);
  }
  return Object.fromEntries(registry);
}

/** Shared with the Node capture manifest, which never imports renderer components. */
export function sceneName(path: string): string {
  const name = path.split("/").at(-1)?.replace(/\.tsx$/, "") ?? "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error(`Invalid gallery scene file: ${path}`);
  return name;
}
