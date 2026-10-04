import "../src/styles.css";
import { mountGallery } from "./mount.js";
import { discoverScenes, type SceneModule } from "./scene-registry.js";

const container = document.getElementById("root");
if (container === null) throw new Error("The gallery has no #root.");
const params = new URL(window.location.href).searchParams;
const scene = params.get("scene") ?? "window-empty";
const ladder = params.get("ladder") ?? "dark";
if (ladder !== "light" && ladder !== "dark") throw new Error(`Unknown gallery ladder: ${ladder}`);
const platform = params.get("platform") ?? "desktop";
if (platform !== "desktop" && platform !== "web") throw new Error(`Unknown gallery platform: ${platform}`);
const textSize = Number(params.get("textSize") ?? 14);
if (!Number.isInteger(textSize) || textSize < 11 || textSize > 20) throw new Error("Invalid gallery text size.");
// Load only this capture's module: other scenes may initialise runtimes and browser storage.
const modules = import.meta.glob<SceneModule>("./scenes/*.tsx");
const path = `./scenes/${scene}.tsx`;
if (!Object.hasOwn(modules, path)) throw new Error(`Unknown gallery scene: ${scene}`);
const registry = discoverScenes({ [path]: await modules[path]!() });
await mountGallery(container, scene, ladder, registry, { platform, ...(params.has("textSize") && { textSize }) });
