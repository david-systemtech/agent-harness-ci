import { STEP_ORDER } from "@agent-harness/contracts";
import { useEffect, useLayoutEffect, useRef } from "react";
import type { LadderName } from "@agent-harness/theme";
import { Header } from "../../src/frame/header.js";
import { PaneGridProvider } from "../../src/grid/grid.js";
import { showSession } from "../../src/grid/layout.js";
import { KeyDispatch } from "../../src/keys/key-dispatch.js";
import { DEFAULT_KEY_MAP } from "../../src/keys/key-map.js";
import { NewSessionSurfaces } from "../../src/new-session/surfaces.js";
import { SettingsProvider } from "../../src/settings/settings-window.js";
import { TerminalPanesProvider } from "../../src/terminal/terminal-panes.js";
import { TooltipProvider } from "../../src/ui/tooltip.js";
import { WindowProvider } from "../../src/window-context.js";
import { prepareWorld, startWorld } from "../world.js";

async function headerScene() {
const prepared = await prepareWorld({ environments: [{
  name: "Desk with a deliberately long environment name", reach: "local", capabilities: ["setup", "updates"],
  sessions: [{ title: "A deliberately long session title that yields room to the window controls", workspace: { kind: "directory", path: "/work/a-deliberately-long-workspace-name" } }],
  setup: {
    ...Object.fromEntries(STEP_ORDER.map((step) => [step, null])),
    account: { state: "needs-attention", reason: "Choose an account." },
    "carry-over": { state: "needs-attention", reason: "Review past work." },
    "key-manager": { state: "needs-attention", reason: "Connect a key manager." },
    "memory-bank": { state: "needs-attention", reason: "Choose a memory bank." },
  },
  updates: { status: { newest: "0.6.0" }, desktopBuild: { path: "/data/test-update.pkg", version: "0.6.0", sha256: "a".repeat(64) } },
}] });
const holders = await startWorld(prepared, prepared.paired);
// A component scene is marked ready immediately; hold its staged update on the event before exporting it.
await new Promise<void>((resolve, reject) => {
  const ready = () => {
    const { build } = holders.runtime.desktopUpdate.view.read();
    if (build.state === "ready") { unsubscribe(); resolve(); }
    else if (build.state === "failed" || build.state === "unsupported" || build.state === "current") {
      unsubscribe(); reject(new Error("The header scene needs a staged desktop update."));
    }
  };
  const unsubscribe = holders.runtime.desktopUpdate.view.subscribe(ready);
  ready();
});
const env = prepared.world.environment("Desk with a deliberately long environment name");
const sessionId = env.sessionId();
const stop = holders.runtime.projections.runs.subscribe(() => {});
env.startRun(sessionId, "Check the receipts");
env.openPrompt(sessionId, { summary: "May I read the receipts?" });
holders.presentation.set("sidebarShown", false);
holders.presentation.set("paneLayout", showSession(holders.presentation.values.read().paneLayout, holders.presentation.values.read().paneLayout.focused, { environmentId: env.environmentId, sessionId }));

/** Capture checks this measured flag as well as the fixed dimensions, without changing the shared gallery runner. */
const HeaderWidth = ({ width }: { readonly width: number }) => {
  const container = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const wrapper = container.current;
    const header = wrapper?.querySelector<HTMLElement>("header");
    if (wrapper === null || header === null || header === undefined) return;
    const measure = () => {
      const bounds = header.getBoundingClientRect();
      const title = header.querySelector<HTMLElement>("[data-header-session-title]");
      const children = Array.from(header.querySelectorAll("*")).map((child) => child.getBoundingClientRect()).filter((rect) => rect.width > 0 && rect.height > 0);
      wrapper.dataset["headerFits"] = String((title?.getBoundingClientRect().width ?? 0) >= 47.5 && header.scrollWidth <= header.clientWidth && children.every((rect) => rect.height <= 30.5 && rect.left >= bounds.left - 0.5 && rect.right <= bounds.right + 0.5));
    };
    const observer = new ResizeObserver(measure);
    const changes = new MutationObserver(measure);
    changes.observe(header, { childList: true, subtree: true, attributes: true, characterData: true });
    observer.observe(header);
    for (const child of header.children) observer.observe(child);
    measure();
    return () => { observer.disconnect(); changes.disconnect(); };
  }, []);
  return <div ref={container} data-header-width={width} style={{ width, maxWidth: "100%" }}>
    <KeyDispatch macOS={false} keyMap={DEFAULT_KEY_MAP}>
      <SettingsProvider><TerminalPanesProvider><PaneGridProvider><NewSessionSurfaces><Header /></NewSessionSurfaces></PaneGridProvider></TerminalPanesProvider></SettingsProvider>
    </KeyDispatch>
  </div>;
};

/** look §9.1: four Set up steps needing attention, every chip populated, and long context at both acceptance widths. */
return function HeaderScene({ ladder }: { readonly ladder: LadderName }) {
  useEffect(() => {
    holders.presentation.set("lightOrDark", ladder);
    return () => {
      stop();
      holders.stopFollowing();
      void holders.presentation.close();
      void holders.runtime.close();
    };
  }, [ladder]);
  return <WindowProvider {...holders} clock={prepared.clock} version={prepared.version} shell={prepared.shell}>
    <TooltipProvider><div className="flex flex-col gap-4"><HeaderWidth width={1400} /><HeaderWidth width={1024} /></div></TooltipProvider>
  </WindowProvider>;
}

}

export default await headerScene();

export const geometry = [1400, 1024].flatMap((width) => [
  { selector: `[data-header-width="${width}"][data-header-fits="true"] header`, width: Math.min(width, window.innerWidth), height: 44 },
  { selector: `[data-header-width="${width}"] button[aria-label="More"]`, width: 28, height: 28 },
  { selector: `[data-header-width="${width}"] button[aria-label="Settings"]`, width: 28, height: 28 },
  { selector: `[data-header-width="${width}"] button[aria-label="Search sessions and commands"]`, height: 24 },
  { selector: `[data-header-width="${width}"] [role="radiogroup"]`, height: 30 },
  { selector: `[data-header-width="${width}"] button[aria-label="Set up: 4 need attention"]`, height: 22 },
  { selector: `[data-header-width="${width}"] button[aria-label="Parked asks, 1 waiting"]`, height: 22 },
  { selector: `[data-header-width="${width}"] button[aria-label="Restart to update"]`, height: 22 },
  { selector: `[data-header-width="${width}"] button[aria-label="Restart to update"] > span`, contentFits: true, fontSize: 11 },
]);
