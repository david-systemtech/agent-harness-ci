import { settingsDeepLink } from "@agent-harness/client-runtime";
import type { LadderName } from "@agent-harness/theme";
import { useEffect } from "react";
import { App } from "../src/app.js";
import { routineFixture } from "./routine-fixtures.js";
import { prepareWorld, startWorld } from "./world.js";

/** The live pane and strip over two neutral environments; one keeps a stale reading. */
export async function routinesScene(settings: boolean) {
  const prepared = await prepareWorld({ environments: [{ name: "desk", reach: "local", accounts: [{ label: "Project" }] }, { name: "laptop", reach: "paired", accounts: [{ label: "Travel" }] }] });
  for (const name of ["desk", "laptop"]) prepared.world.environment(name).wire.answer("routines.list", () => ({ result: { routines: settings ? [routineFixture(name === "desk" ? "Morning digest" : "Backup check")] : Array.from({ length: 3 }, (_, index) => routineFixture(`${name} digest ${index + 1}`, index + 1)) } }));
  const holders = await startWorld(prepared, prepared.paired);
  const routines = holders.runtime.projections.routines;
  let stopFollowing: () => void = () => undefined;
  await new Promise<void>((resolve) => {
    const ready = () => { if (routines.read().groups.length === 2 && routines.read().groups.every((group) => group.fetchedAt !== null)) resolve(); };
    stopFollowing = routines.subscribe(ready);
    ready();
  });
  prepared.world.environment("laptop").server.drop();
  return function RoutinesScene({ ladder }: { readonly ladder: LadderName }) {
    useEffect(() => {
      holders.presentation.set("lightOrDark", ladder);
      if (settings) prepared.shell.openDeepLink(settingsDeepLink("routines.routines"));
    }, [ladder]);
    useEffect(() => () => {
      stopFollowing();
      holders.stopFollowing();
      void holders.presentation.close();
      void holders.runtime.close();
    }, []);
    return <App {...holders} clock={prepared.clock} shell={prepared.shell} version={prepared.version} macOS={false} />;
  };
}
