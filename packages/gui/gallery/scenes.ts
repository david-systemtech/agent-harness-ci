import { discoverScenes, type SceneModule } from "./scene-registry.js";

/** Each surface owns a scene file; adding one needs no registry edit. */
export const scenes = discoverScenes(import.meta.glob<SceneModule>("./scenes/*.tsx", { eager: true }));
