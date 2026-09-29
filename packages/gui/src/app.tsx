import type { Clock, Runtime, Shell } from "@agent-harness/client-runtime";
import { LocalServiceProvider } from "./connections/local-service.js";
import { PairingProvider } from "./connections/pairing.js";
import { Frame } from "./frame/frame.js";
import { KeyDispatch } from "./keys/key-dispatch.js";
import { CommandPalette } from "./palette/palette.js";
import type { Presentation } from "./presentation.js";
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
  /** Whether the keys' `Mod` is ⌘ (macOS) or Ctrl (everywhere else). */
  readonly macOS: boolean;
  /** The desktop's shell, the platform's own: what only a desktop can do. Absent in a browser tab. */
  readonly shell?: Shell | undefined;
}

/**
 * The desktop window's renderer (docs/specs/gui.md): the frame over one
 * client runtime, painted with the home environment's theme from its first
 * frame (the one cached, until the window reads it again), its keys
 * dispatched through the GUI column of the shared action list, and the
 * command palette over it. What the window chose for a session's next runs
 * is held for the life of the window (`RunChoicesProvider`).
 */
export const App = ({ runtime, presentation, clock, macOS, shell }: AppProps) => (
  <WindowProvider runtime={runtime} presentation={presentation} clock={clock} shell={shell}>
    <WindowTheme />
    <LocalServiceProvider>
      <PairingProvider>
        <KeyDispatch macOS={macOS}>
          <CommandPalette>
            <RunChoicesProvider>
              <Frame />
            </RunChoicesProvider>
          </CommandPalette>
        </KeyDispatch>
      </PairingProvider>
    </LocalServiceProvider>
  </WindowProvider>
);
