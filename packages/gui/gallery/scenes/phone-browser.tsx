import { useObservable, useRuntime } from "../../src/window-context.js";
import { WebBrowserPane } from "../../src/browser/web-browser-pane.js";
import type { SceneModule } from "../scene-registry.js";

export const platform = "web";
export const script: SceneModule["script"] = { environments: [{ name: "desk", reach: "paired", scopes: ["read", "sessions:write", "runs:drive"], hello: { ceiling: "acceptEdits" }, sessions: [{}] }] };
export const arrangeWeb: SceneModule["arrangeWeb"] = world => {
  const env = world.environment("desk");
  env.wire.answer("browser.status", () => ({ result: {
    listener: { state: "listening", port: 47615 }, folder: { path: "/test/extension", problem: null }, shippedVersion: "0.1.0", unpairedConnected: false,
    headless: { allowRuns: true, availability: { available: true, source: { kind: "launched", executable: "/test/chromium" } }, liveContexts: 0 },
  } }));
  env.wire.answer("browser.chromes.list", () => ({ result: { chromes: [{
    id: "0199aa00-0000-4000-8000-000000000041", name: "Project Chrome", connected: false, outdated: false,
    pairedAt: "2026-09-24T00:00:00.000Z", lastConnectedAt: "2026-09-24T00:00:00.000Z", lastReportedVersion: "0.1.0",
  }] } }));
};
export default function PhoneBrowser() {
  const runtime = useRuntime();
  const environment = useObservable(runtime.projections.environments)[0];
  const sessions = useObservable(runtime.projections.sessionList);
  const session = sessions.rows[0];
  return <main data-phone-browser className="mx-auto flex h-dvh w-full min-w-0 max-w-[390px] flex-col bg-abyss p-4 text-ink">
    <h1 className="mb-3 shrink-0 text-base font-semibold">Environment browser</h1>
    <div className="min-h-0 overflow-y-auto">{environment && session && <WebBrowserPane environmentId={environment.environmentId} sessionId={session.summary.id} />}</div>
  </main>;
}
export const readySelector = '[data-web-browser] option[value="2"]';
export const geometry = [
  { selector: "[data-phone-browser]", maxWidth: 390 },
  { selector: "[data-web-browser]", contentFits: true },
  { selector: "[data-web-browser] :is(button, input, select)", minimumWidth: 44, minimumHeight: 44 },
  { selector: 'form[aria-label="Open a page"] button', visibleWithin: "[data-phone-browser]" },
];
