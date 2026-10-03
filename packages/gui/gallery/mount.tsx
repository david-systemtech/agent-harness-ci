import { DEFAULT_THEME } from "@agent-harness/contracts";
import { derive, type LadderName } from "@agent-harness/theme";
import { paintLadder } from "../src/theme/paint.js";
import type { SceneRegistry } from "./scene-registry.js";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../src/app.js";
import { WindowProvider } from "../src/window-context.js";
import { scenes } from "./scenes.js";
import { prepareWorld, startWorld } from "./world.js";

export const mountGallery = async (container: HTMLElement, scene: string, ladder: LadderName = "dark", registry: SceneRegistry = scenes) => {
  const definition = registry[scene];
  if (!Object.hasOwn(registry, scene) || definition === undefined) throw new Error(`Unknown gallery scene: ${scene}`);
  const prepared = await prepareWorld(definition.script ?? { environments: [] }, { presentation: { ...definition.presentation, lightOrDark: ladder } });
  const world = { ...prepared, ...await startWorld(prepared, prepared.paired) };
  definition.arrange?.(world.world);
  const root = createRoot(container);
  const Component = definition.default;
  const geometry = typeof definition.geometry === "function"
    ? definition.geometry({ width: window.innerWidth, height: window.innerHeight })
    : definition.geometry ?? [];
  container.dataset["galleryGeometry"] = JSON.stringify(geometry);
  const Ready = () => {
    useEffect(() => {
      if (Component !== undefined) {
        paintLadder(document.documentElement, derive(DEFAULT_THEME)[ladder], ladder);
        container.dataset["galleryReady"] = scene;
        return;
      }
      const views = world.runtime.projections.environments;
      const mark = () => {
        if (views.read().every((view) => view.phase === "ready")) container.dataset["galleryReady"] = scene;
      };
      const stop = views.subscribe(mark);
      mark();
      return stop;
    }, []);
    return null;
  };
  root.render(<>{Component !== undefined ? <WindowProvider runtime={world.runtime} presentation={world.presentation} clock={world.clock} version={world.version} shell={world.shell}><Component ladder={ladder} /></WindowProvider> : <App runtime={world.runtime} presentation={world.presentation} clock={world.clock} version={world.version} macOS={world.macOS} shell={world.shell} />}<Ready /></>);
  return {
    world,
    async close() {
      root.unmount();
      delete container.dataset["galleryReady"];
      delete container.dataset["galleryGeometry"];
      world.stopFollowing();
      await world.presentation.close();
      await world.runtime.close();
    },
  };
};
