import { settingsDeepLink } from "@agent-harness/client-runtime";
import type { LadderName } from "@agent-harness/theme";
import { useEffect } from "react";
import { App } from "../src/app.js";
import type { SceneGeometry, SceneViewport } from "./scene-registry.js";
import { prepareWorld, startWorld } from "./world.js";

/** Settings owns one bounded scrollport, including when long notices exceed it. */
export async function settingsNoticesScene(stacked: boolean, textSize = 14) {
  const sessionId = "0199dd00-0000-4000-8000-000000000001";
  const prepared = await prepareWorld({ environments: [{ name: "desk", reach: "local", accounts: [{ label: "Personal" }], sessions: [{ id: sessionId, title: "Receipt check" }] }] }, { presentation: { textSize } });
  const holders = await startWorld(prepared, prepared.paired);
  const env = prepared.world.environment("desk");
  await env.wire.server.request("environment.subscribe");
  env.notice("environment.draining", { drainingSince: "2026-09-24T00:00:01.000Z", trigger: "launcher" });
  if (stacked) {
    env.notice("environment.updated", { fromVersion: "0.5.0", toVersion: "0.5.1" });
    for (const suffix of ["1", "2", "3"]) env.notice("routine.delivered", {
      routineId: `0199cc00-0000-4000-8000-0000000000a${suffix}`, name: `Receipt check ${suffix}`,
      entryId: `0199cc00-0000-4000-8000-0000000000b${suffix}`, entryKind: "firing", sessionId, outcome: "failed",
      summary: "The workspace is unavailable. Your draft is kept; continue when the workspace returns. The receipt report has a long explanation that wraps onto several lines without hiding its controls.", body: "Workspace unavailable.",
    });
  }
  return function SettingsNotices({ ladder }: { readonly ladder: LadderName }) {
    useEffect(() => {
      holders.presentation.set("lightOrDark", ladder);
      prepared.shell.openDeepLink(settingsDeepLink("accounts.accounts"));
      return () => { holders.stopFollowing(); void holders.presentation.close(); void holders.runtime.close(); };
    }, [ladder]);
    return <App {...holders} clock={prepared.clock} shell={prepared.shell} version={prepared.version} macOS={false} />;
  };
}

export const readySelector = "[data-settings-notices] [data-notice-tone]";

export const settingsNoticesGeometry = (textSize = 14) => ({ width, height }: SceneViewport): readonly SceneGeometry[] => [
  { selector: "html", fontSize: 16 * textSize / 14 },
  { selector: "[data-settings-dialog]", width: Math.min(width >= 1280 ? 1440 : 1000, width - 48 * textSize / 14), height: Math.min(width >= 1280 ? 900 : 660, height - 48 * textSize / 14) },
  { selector: "[data-settings-notices]", visibleWithin: "[data-settings-dialog]" },
  { selector: '[data-settings-notices] li:first-child', visibleWithin: '[aria-label="Notifications"]', contentFits: true },
  { selector: '[data-settings-notices] li:first-child', visibleWithin: "[data-settings-notices]" },
  { selector: '[data-settings-notices] li:first-child button[aria-label="Dismiss"]', visibleWithin: "[data-settings-notices]", contentFits: true },
  { selector: "[data-settings-scroll]", minimumHeight: 200, visibleWithin: "[data-settings-body]" },
];
