import { settingsDeepLink } from "@agent-harness/client-runtime";
import type { LadderName } from "@agent-harness/theme";
import { useEffect, useState } from "react";
import { App } from "../src/app.js";
import { prepareWorld, startWorld } from "./world.js";

/** Access panes over the real Settings modal, with invented local browser data. */
export async function accessSettingsScene(row: "access.permissions" | "access.browser") {
  const prepared = await prepareWorld({ environments: [{ name: "desk", reach: "local", accounts: [{ label: "Personal" }] }] }, { presentation: { settingsRow: row } });
  const desk = prepared.world.environment("desk");
  desk.wire.answer("browser.status", () => ({ result: {
    listener: { state: "listening", port: 47615 },
    folder: { path: "/test/extension", problem: null }, shippedVersion: "0.1.0", unpairedConnected: true,
    headless: { allowRuns: false, availability: { available: true, source: { kind: "launched", executable: "/test/chromium" } }, liveContexts: 0 },
  } }));
  desk.wire.answer("browser.chromes.list", () => ({ result: { chromes: [{
    id: "0199aa00-0000-4000-8000-000000000041", name: "Project Chrome", connected: true, outdated: false,
    pairedAt: "2026-09-24T00:00:00.000Z", lastConnectedAt: "2026-09-24T00:00:00.000Z", lastReportedVersion: "0.1.0",
  }] } }));
  desk.wire.answer("browser.pairing.code", () => ({ result: { code: "ABCD2345", expiresAt: new Date(prepared.clock.now().getTime() + 300_000).toISOString() } }));
  const holders = await startWorld(prepared, prepared.paired);
  return function AccessSettingsScene({ ladder }: { readonly ladder: LadderName }) {
    const [ready, markReady] = useState(false);
    useEffect(() => {
      holders.presentation.set("lightOrDark", ladder);
      prepared.shell.openDeepLink(settingsDeepLink(row));
      let pairing = false;
      const check = () => {
        if (row === "access.browser" && !pairing) {
          const button = [...document.querySelectorAll<HTMLButtonElement>("[data-settings-pane] button")].find((candidate) => candidate.textContent === "Pair another Chrome");
          if (button !== undefined && !button.disabled) { pairing = true; button.click(); }
        }
        const selector = row === "access.browser" ? 'input[aria-label="Pairing code"]' : '[data-settings-pane] form[aria-label="Add to Hosts"]';
        if (document.querySelector(selector) === null) return;
        observer.disconnect();
        markReady(true);
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      check();
      return () => observer.disconnect();
    }, [ladder]);
    useEffect(() => () => {
      holders.stopFollowing();
      void holders.presentation.close();
      void holders.runtime.close();
    }, []);
    return <><App {...holders} clock={prepared.clock} shell={prepared.shell} version={prepared.version} macOS={false} />{ready && <span data-access-scene-ready hidden />}</>;
  };
}
