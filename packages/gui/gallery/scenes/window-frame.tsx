import { fakeShell } from "@agent-harness/client-runtime/testing";
import type { ShellWindowState } from "@agent-harness/client-runtime";
import type { LadderName } from "@agent-harness/theme";
import { useEffect, useLayoutEffect, useRef } from "react";
import { Header } from "../../src/frame/header.js";
import { PaneGridProvider } from "../../src/grid/grid.js";
import { KeyDispatch } from "../../src/keys/key-dispatch.js";
import { DEFAULT_KEY_MAP } from "../../src/keys/key-map.js";
import { NewSessionSurfaces } from "../../src/new-session/surfaces.js";
import { SettingsProvider } from "../../src/settings/settings-window.js";
import { ChecklistProvider } from "../../src/setup/checklist-window.js";
import { TerminalPanesProvider } from "../../src/terminal/terminal-panes.js";
import { TooltipProvider } from "../../src/ui/tooltip.js";
import { WindowProvider } from "../../src/window-context.js";
import { prepareWorld, startWorld } from "../world.js";

const cases: readonly { readonly name: string; readonly state: ShellWindowState | undefined }[] = [
  { name: "windows", state: { platform: "win32", focused: true, maximized: false, fullScreen: false } },
  { name: "windows-restore", state: { platform: "win32", focused: false, maximized: true, fullScreen: false } },
  { name: "linux", state: { platform: "linux", focused: true, maximized: false, fullScreen: false } },
  { name: "macos", state: { platform: "darwin", focused: true, maximized: false, fullScreen: false } },
  { name: "macos-fullscreen", state: { platform: "darwin", focused: true, maximized: false, fullScreen: true } },
  { name: "browser", state: undefined },
];

async function frameScene() {
  const prepared = await prepareWorld({ environments: [] });
  const holders = await startWorld(prepared, []);
  const frames = cases.map(({ name, state }) => {
    const shell = fakeShell();
    shell.answer("window.state", async () => state);
    return { name, state, shell };
  });
  const Frame = ({ name }: { readonly name: string }) => {
    const ref = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
      const box = ref.current;
      if (box === null) return;
      const observer = new ResizeObserver(() => {
        const header = box.querySelector("header");
        if (header !== null) box.dataset["frameFits"] = String(header.scrollWidth <= header.clientWidth);
      });
      observer.observe(box);
      return () => observer.disconnect();
    }, []);
    return <div ref={ref} data-frame={name}>
      <p className="px-2 py-2 text-xs text-ink-muted">{name}</p>
      <KeyDispatch macOS={name.startsWith("macos")} keyMap={DEFAULT_KEY_MAP}>
        <SettingsProvider><ChecklistProvider><TerminalPanesProvider><PaneGridProvider><NewSessionSurfaces><Header /></NewSessionSurfaces></PaneGridProvider></TerminalPanesProvider></ChecklistProvider></SettingsProvider>
      </KeyDispatch>
    </div>;
  };
  return function WindowFrameScene({ ladder }: { readonly ladder: LadderName }) {
    useEffect(() => {
      holders.presentation.set("lightOrDark", ladder);
      return () => { holders.stopFollowing(); void holders.presentation.close(); void holders.runtime.close(); };
    }, [ladder]);
    return <TooltipProvider><main className="bg-abyss text-ink">
      {frames.map(({ name, shell }) => <WindowProvider key={name} {...holders} clock={prepared.clock} version={prepared.version} shell={shell}><Frame name={name} /></WindowProvider>)}
    </main></TooltipProvider>;
  };
}

export default await frameScene();

/** look §9.1: fixed header and 28px controls, no overflow at either capture width. */
export const geometry = [
  ...cases.map(({ name }) => ({ selector: `[data-frame="${name}"][data-frame-fits="true"] header`, height: 44 })),
  { selector: '[aria-label="Window controls"] button', width: 28, height: 28 },
];
