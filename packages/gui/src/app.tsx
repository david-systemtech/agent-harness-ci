import type { Clock, Runtime, Shell } from "@agent-harness/client-runtime";
import { LocalServiceProvider } from "./connections/local-service.js";
import { PairingProvider } from "./connections/pairing.js";
import { Frame } from "./frame/frame.js";
import { KeyDispatch } from "./keys/key-dispatch.js";
import { CommandPalette } from "./palette/palette.js";
import type { Presentation } from "./presentation.js";
import { SettingsProvider } from "./settings/settings-window.js";
import { STEP_CARDS, StepCardsContext, type StepCards } from "./setup/cards.js";
import { ChecklistProvider } from "./setup/checklist-window.js";
import { RunChoicesProvider } from "./status/run-choices.js";
import { WindowTheme } from "./theme/window-theme.js";
import { WindowProvider } from "./window-context.js";

export interface AppProps {
  /** The window's one client runtime, which every component renders from (ADR 0004). */
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

/**
 * The desktop window's renderer (docs/specs/gui.md): the frame over one
 * client runtime, painted with the home environment's theme from its first
 * frame (the one cached, until the window reads it again), its keys
 * dispatched through the GUI column of the shared action list, Settings,
 * Set up as the whole window on first launch (the full checklist) with the
 * step cards registered, and the command palette over it. What the window chose for a session's next runs
 * is held for the life of the window (`RunChoicesProvider`).
 */
export const App = ({ runtime, presentation, clock, version, macOS, shell, stepCards = STEP_CARDS }: AppProps) => (
  <WindowProvider runtime={runtime} presentation={presentation} clock={clock} version={version} shell={shell}>
    <WindowTheme />
    <LocalServiceProvider>
      <PairingProvider>
        <KeyDispatch macOS={macOS}>
          <SettingsProvider>
            <StepCardsContext value={stepCards}>
              <ChecklistProvider>
                <CommandPalette>
                  <RunChoicesProvider>
                    <Frame />
                  </RunChoicesProvider>
                </CommandPalette>
              </ChecklistProvider>
            </StepCardsContext>
          </SettingsProvider>
        </KeyDispatch>
      </PairingProvider>
    </LocalServiceProvider>
  </WindowProvider>
);
