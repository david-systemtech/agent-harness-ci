import { writable, type DesktopBuildView, type DesktopUpdate } from "@agent-harness/client-runtime";
import { useEffect } from "react";
import type { LadderName } from "@agent-harness/theme";
import { TooltipProvider } from "../../src/ui/tooltip.js";
import { RestartButton, RestartToUpdate } from "../../src/updates/restart-to-update.js";
import { WindowProvider } from "../../src/window-context.js";
import { prepareWorld, startWorld } from "../world.js";

/* eslint-disable agent-harness/no-client-organisation-state -- The views a desktop update is held in: the runtime's own shape, not renderer-owned state. */
const newer = { path: "/data/test-update.pkg", version: "0.1.10", sha256: "a".repeat(64) };

/** Every state the header's update chip draws, at a two-digit patch version (#1806). */
const STATES: readonly (readonly [string, DesktopBuildView])[] = [
  ["ready", { state: "ready", version: "0.1.9", staged: newer }],
  ["ready-after-failed-check", { state: "failed", version: "0.1.9", failure: "check", message: "The release channel could not be read.", staged: newer }],
  ["checking", { state: "checking", version: "0.1.9" }],
  ["staging", { state: "staging", version: "0.1.9", toVersion: "0.1.10" }],
  ["applying", { state: "applying", version: "0.1.9", staged: newer }],
  ["failed", { state: "failed", version: "0.1.9", failure: "stage", message: "The test download is unavailable.", staged: null }],
  ["install-failed", { state: "failed", version: "0.1.9", failure: "install", message: "The installer could not run.", staged: newer }],
];
/* eslint-enable agent-harness/no-client-organisation-state */

/** A desktop update held in one state: the chip is drawn, never clicked. */
const held = (build: DesktopBuildView): DesktopUpdate => ({
  view: writable({ build, bundledServer: { state: "none" } }),
  restart: () => Promise.resolve(build),
  checkAgain: () => Promise.resolve(build),
  applyBundledServer: () => Promise.resolve({ state: "none" }),
});

async function updateChipScene() {
const prepared = await prepareWorld({ environments: [] });
const holders = await startWorld(prepared, prepared.paired);
const rows = STATES.map(([name, build]) => [name, { ...holders.runtime, desktopUpdate: held(build) }] as const);

/** look §9.1 "Update chip": each state in a header's run of chips, and the ready ones also as About's 750px card draws them. */
return function UpdateChipScene({ ladder }: { readonly ladder: LadderName }) {
  useEffect(() => {
    holders.presentation.set("lightOrDark", ladder);
    return () => {
      holders.stopFollowing();
      void holders.presentation.close();
      void holders.runtime.close();
    };
  }, [ladder]);
  return <TooltipProvider><main className="flex min-h-screen flex-col gap-3 bg-abyss p-6 text-sm text-ink">
    {rows.map(([name, runtime]) => <WindowProvider key={name} {...holders} runtime={runtime} clock={prepared.clock} version={prepared.version} shell={prepared.shell}>
      <div data-update-chip={name} className="flex items-start gap-6">
        <div data-geometry="header" className="flex h-11 shrink-0 items-center gap-1"><RestartToUpdate /></div>
        <div data-geometry="about" className="flex w-[750px] flex-col gap-3 text-xs"><RestartButton /></div>
      </div>
    </WindowProvider>)}
  </main></TooltipProvider>;
};
}

export default await updateChipScene();

export const geometry = [
  ...STATES.flatMap(([name]) => [
    { selector: `[data-update-chip="${name}"] [data-geometry="header"] :is(button, [role="status"]) > span`, contentFits: true, fontSize: 11 },
    { selector: `[data-update-chip="${name}"] [data-geometry="header"] :is(button, [role="status"])`, height: 22 },
  ]),
  { selector: '[data-update-chip="ready"] [data-geometry="about"] button > span', contentFits: true, fontSize: 11 },
  { selector: '[data-update-chip="ready"] [data-geometry="about"] button', height: 22 },
];
