import type { LadderName } from "@agent-harness/theme";
import { useEffect, useState } from "react";
import { App, type AppProps } from "../../src/app.js";
import { prepareWorld, startWorld } from "../world.js";
export { geometry } from "./setup-introduction.js";
export const readySelector = '[data-setup-begin]:not(:disabled)';
/** look.md §13.1: the introduction after this machine has started. */
export default function SetupReady({ ladder }: { readonly ladder: LadderName }) {
  const [app, setApp] = useState<AppProps>();
  useEffect(() => {
    let stopped = false;
    let dispose: (() => Promise<void>) | undefined;
    void (async () => {
      const prepared = await prepareWorld({ environments: [{ name: "desk", reach: "local" }] }, { firstLaunch: true, presentation: { lightOrDark: ladder } });
      const world = await startWorld(prepared, prepared.paired);
      dispose = async () => { world.stopFollowing(); await world.presentation.close(); await world.runtime.close(); };
      if (stopped) { await dispose(); return; }
      setApp({ ...world, clock: prepared.clock, shell: prepared.shell, version: prepared.version, macOS: false });
    })();
    return () => { stopped = true; void dispose?.(); };
  }, [ladder]);
  return app === undefined ? null : <App {...app} />;
}
