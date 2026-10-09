import { WebFrame, type WebFrameProps } from "./platform/web-frame.js";
import type { Clock, Runtime, Shell } from "@agent-harness/client-runtime";
import { useMemo, type ReactNode } from "react";
import { WindowAttention } from "./attention/window-attention.js";
import { LocalServiceProvider } from "./connections/local-service.js";
import { PairingProvider } from "./connections/pairing.js";
import { Frame } from "./frame/frame.js";
import { KeyDispatch } from "./keys/key-dispatch.js";
import { CommandPalette } from "./palette/palette.js";
import type { Presentation } from "./presentation.js";
import { SettingsProvider } from "./settings/settings-window.js";
import { STEP_CARDS, StepCardsContext, type StepCards } from "./setup/cards.js";
import { ChecklistProvider } from "./setup/checklist-window.js";
import { WindowSidebarProvider } from "./sidebar/window-sidebar.js";
import { RunChoicesProvider } from "./status/run-choices.js";
import { WindowThemeProvider } from "./theme/window-theme.js";
import { Toaster } from "./ui/toaster.js";
import { TooltipProvider } from "./ui/tooltip.js";
import { WindowProvider, useObservable, usePresentation, useRuntime } from "./window-context.js";

export interface AppProps {
  /** The window's one client runtime, which every component renders from (ADR 0004). */
  readonly web?: WebFrameProps | undefined;
  readonly runtime: Runtime;
  /** The window's presentation, opened on the platform's documents. */
  readonly presentation: Presentation;
  /** The platform's clock, the runtime's own. */
  readonly clock: Clock;
  /** This client's version, the bundle's: what About pins above its picker. */
  readonly version: string;
  /** Whether the keys' `Mod` is ⌘ (macOS) or Ctrl (everywhere else). */
  readonly macOS: boolean;
  /** The desktop's shell, the platform's own: what only a desktop can do. Absent in a browser tab. */
  readonly shell?: Shell | undefined;
  /** The step cards the full checklist draws, by step id: preset this build's (`STEP_CARDS`). */
  readonly stepCards?: StepCards | undefined;
}

/** The window's keys: the GUI column with this client's remaps, and app.interrupt's Esc while "Esc stops the run" is on (#418). */
const WindowKeys = ({ macOS, children }: { readonly macOS: boolean; readonly children: ReactNode }) => {
  const [remaps] = usePresentation("keyRemaps");
  const [escStopsRun] = usePresentation("escStopsRun");
  const keyMap = useMemo(() => ({ remaps, escStopsRun }), [remaps, escStopsRun]);
  return (
    <KeyDispatch macOS={macOS} keyMap={keyMap}>
      {children}
    </KeyDispatch>
  );
};

/** Safe renderer diagnostics follow the window's projection even when another Settings row or setup is open. */
const WindowEnvironmentState = () => {
  const environments = useObservable(useRuntime().projections.environments);
  const state = environments.map(({ environmentId, name, kind, phase, blocked, action }) => ({ environmentId, name, kind, phase, blocked, action }));
  return <span hidden data-window-environments={JSON.stringify(state)} />;
};

/**
 * The desktop window's renderer (docs/specs/gui.md): the frame over one
 * client runtime, painted with the home environment's theme from its first
 * frame (the one cached, until the window reads it again; a theme picker's
 * preview over it while one is shown), its keys
 * dispatched through the GUI column of the shared action list with this
 * client's remaps, Settings,
 * Set up as the whole window on first launch (the full checklist) with the
 * step cards registered, the command palette over it, every notice as a
 * banner above the grid, and the window's title, badge and notifications (#405). The
 * account a hand-off forked a session onto
 * is held for the life of the window (`RunChoicesProvider`), as is what the
 * sidebar keeps while it is hidden (`WindowSidebarProvider`).
 */
export const App = ({ runtime, presentation, clock, version, macOS, shell, web, stepCards = STEP_CARDS }: AppProps) => (
  <WindowProvider runtime={runtime} presentation={presentation} clock={clock} version={version} shell={shell}>
    <WindowThemeProvider>
      <TooltipProvider>
        <LocalServiceProvider>
          <PairingProvider>
            <WindowKeys macOS={macOS}>
              <SettingsProvider>
                <StepCardsContext value={stepCards}>
                  <ChecklistProvider>
                    <CommandPalette>
                      <RunChoicesProvider>
                        <WindowSidebarProvider>
                          {web ? <WebFrame {...web} /> : <Frame />}
                        </WindowSidebarProvider>
                      </RunChoicesProvider>
                    </CommandPalette>
                    <WindowAttention />
                    <WindowEnvironmentState />
                  </ChecklistProvider>
                </StepCardsContext>
              </SettingsProvider>
            </WindowKeys>
          </PairingProvider>
        </LocalServiceProvider>
        <Toaster />
      </TooltipProvider>
    </WindowThemeProvider>
  </WindowProvider>
);
