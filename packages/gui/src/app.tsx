import type { Clock, Runtime } from "@agent-harness/client-runtime";
import { DEFAULT_THEME } from "@agent-harness/contracts";
import { useLayoutEffect } from "react";
import { Frame } from "./frame/frame.js";
import { KeyDispatch } from "./keys/key-dispatch.js";
import type { Presentation } from "./presentation.js";
import { osLadder, paintTheme } from "./theme/paint.js";
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
}

/**
 * The desktop window's renderer (docs/specs/gui.md): the frame over one
 * client runtime, painted with the theme's tokens before its first frame
 * (the preset's, until the window reads a theme of its own), its keys
 * dispatched through the GUI column of the shared action list.
 */
export const App = ({ runtime, presentation, clock, macOS }: AppProps) => {
  useLayoutEffect(() => paintTheme(document.documentElement, DEFAULT_THEME, osLadder(window)), []);
  return (
    <WindowProvider runtime={runtime} presentation={presentation} clock={clock}>
      <KeyDispatch macOS={macOS}>
        <Frame />
      </KeyDispatch>
    </WindowProvider>
  );
};
