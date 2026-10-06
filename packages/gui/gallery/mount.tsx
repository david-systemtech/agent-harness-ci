import { DEFAULT_THEME } from "@agent-harness/contracts";
import { derive, type LadderName } from "@agent-harness/theme";
import { paintLadder } from "../src/theme/paint.js";
import type { SceneRegistry } from "./scene-registry.js";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../src/app.js";
import { WindowProvider } from "../src/window-context.js";
import { prepareWorld, startWorld, startWebWorld } from "./world.js";

export interface GalleryCaptureOptions { readonly platform?: "desktop" | "web"; readonly textSize?: number }

export const mountGallery = async (container: HTMLElement, scene: string, ladder: LadderName = "dark", registry: SceneRegistry | undefined = undefined, options: GalleryCaptureOptions = {}) => {
  const available = registry ?? (await import("./scenes.js")).scenes;
  const definition = available[scene];
  if (!Object.hasOwn(available, scene) || definition === undefined) throw new Error(`Unknown gallery scene: ${scene}`);
  // Floating controls must never measure the fallback font on their first layout.
  await container.ownerDocument.fonts?.load?.('14px "Archivo Variable"');
  const web = definition.platform === "web";
  if (options.platform !== undefined && options.platform !== (web ? "web" : "desktop")) throw new Error(`Gallery platform mismatch: ${scene}`);
  const presentation = { ...definition.presentation, lightOrDark: ladder, ...(options.textSize !== undefined && { textSize: options.textSize }) };
  const world = await (async () => {
    if (web) return startWebWorld(definition.script ?? { environments: [] }, presentation);
    const prepared = await prepareWorld(definition.script ?? { environments: [] }, { presentation });
    return { ...prepared, ...await startWorld(prepared, prepared.paired) };
  })();
  if (web) definition.arrangeWeb?.(world.world);
  else if (world.shell !== undefined) definition.arrange?.(world.world, world.shell);
  // A pending scene is settled by readiness or disposal, never a polling deadline.
  let resolveReady!: (ready: boolean) => void;
  const ready = new Promise<boolean>((resolve) => { resolveReady = resolve; });
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
        if (web) document.documentElement.style.setProperty("--font-scale", String(world.presentation.values.read().textSize / 14));
      }
      const stopActivation = definition.activate?.();
      let stopped = false;
      let waitingForFonts = false;
      const views = world.runtime.projections.environments;
      const mark = () => {
        // A blocked connection is settled too: it waits for a person to pair again, as a revoked scene draws it.
        const connected = Component !== undefined || views.read().every((view) => view.phase === "ready" || view.phase === "blocked");
        const drawn = definition.readySelector === undefined || container.ownerDocument.querySelector(definition.readySelector) !== null;
        if (!connected || !drawn || waitingForFonts) return;
        waitingForFonts = true;
        void (container.ownerDocument.fonts?.ready ?? Promise.resolve()).then(() => {
          if (!stopped) {
            container.dataset["galleryReady"] = scene;
            resolveReady(true);
          }
        });
      };
      const stop = views.subscribe(mark);
      const observer = new MutationObserver(mark);
      observer.observe(container.ownerDocument.body, { childList: true, subtree: true, attributes: true, characterData: true });
      mark();
      return () => { stopped = true; stop(); observer.disconnect(); stopActivation?.(); };
    }, []);
    return null;
  };
  root.render(<>{Component !== undefined ? <WindowProvider runtime={world.runtime} presentation={world.presentation} clock={world.clock} version={world.version} shell={world.shell}><Component ladder={ladder} /></WindowProvider> : <App runtime={world.runtime} presentation={world.presentation} clock={world.clock} version={world.version} macOS={world.macOS} shell={world.shell} {...(world.platform.client.kind === "web" && "persistence" in world.platform ? { web: { platform: world.platform, route: definition.route?.(world.world) ?? {} } } : {})} />}<Ready /></>);
  return {
    world,
    /** True after the ready marker is drawn; false if the gallery closes first. */
    ready,
    async close() {
      resolveReady(false);
      root.unmount();
      delete container.dataset["galleryReady"];
      delete container.dataset["galleryGeometry"];
      world.stopFollowing();
      await world.presentation.close();
      await world.runtime.close();
    },
  };
};
