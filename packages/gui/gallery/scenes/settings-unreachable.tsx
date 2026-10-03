import type { LadderName } from "@agent-harness/theme";
import { settingsDeepLink } from "@agent-harness/client-runtime";
import { useEffect } from "react";
import { useObservable } from "../../src/window-context.js";
import { App } from "../../src/app.js";
import { prepareWorld, startWorld } from "../world.js";
import { settingsGeometry } from "../settings-scene.js";
const prepared = await prepareWorld({ environments: [{ name: "desk", reach: "paired", accounts: [{ label: "Project" }] }] });
const holders = await startWorld(prepared, prepared.paired);
const env = prepared.world.environment("desk");
/** look.md §12 and §16: a remembered environment goes unreachable with cached Settings intact. */
export default function UnreachableSettings({ ladder }: { readonly ladder: LadderName }) {
  const disconnected = useObservable(holders.runtime.projections.environments).some((view) => view.environmentId === env.environmentId && view.unreachableSince !== null);
  useEffect(() => {
    holders.presentation.set("lightOrDark", ladder);
    prepared.shell.openDeepLink(settingsDeepLink("accounts.accounts"));
    let disconnected = false;
    const drop = () => {
      if (disconnected || document.querySelector('[data-account-card]') === null) return;
      disconnected = true;
      env.server.drop();
    };
    const observer = new MutationObserver(drop);
    observer.observe(document.body, { childList: true, subtree: true });
    drop();
    return () => { observer.disconnect(); holders.stopFollowing(); void holders.presentation.close(); void holders.runtime.close(); };
  }, [ladder]);
  return <><App {...holders} clock={prepared.clock} shell={prepared.shell} version={prepared.version} macOS={false} />{disconnected && <span hidden data-unreachable-scene-ready />}</>;
}
export const geometry = settingsGeometry;
export const readySelector = "[data-unreachable-scene-ready]";
