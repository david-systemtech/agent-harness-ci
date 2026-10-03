import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../src/app.js";
import { scenes } from "./scenes.js";
import { prepareWorld, startWorld } from "./world.js";

export const mountGallery = async (container: HTMLElement, scene: string) => {
  const script = scenes[scene];
  if (script === undefined) throw new Error(`Unknown gallery scene: ${scene}`);
  const prepared = await prepareWorld(script, { presentation: { lightOrDark: "dark" } });
  const world = { ...prepared, ...await startWorld(prepared, prepared.paired) };
  const root = createRoot(container);
  const Ready = () => {
    useEffect(() => {
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
  root.render(<><App runtime={world.runtime} presentation={world.presentation} clock={world.clock} version={world.version} macOS={world.macOS} shell={world.shell} /><Ready /></>);
  return {
    world,
    async close() {
      root.unmount();
      delete container.dataset["galleryReady"];
      world.stopFollowing();
      await world.presentation.close();
      await world.runtime.close();
    },
  };
};
