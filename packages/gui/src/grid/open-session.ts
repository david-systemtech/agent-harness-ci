import { useCallback } from "react";
import type { PaneSession } from "../presentation.js";
import { useSettings } from "../settings/settings-window.js";
import { usePresentation } from "../window-context.js";
import { showSession } from "./layout.js";

/**
 * Opens a session in the focused pane from outside the grid (docs/specs/gui.md,
 * "Parked asks, attention and notices"): a row of the Parked asks view, a
 * notification clicked, a toast's Open. It shows there and is focused (one
 * another pane shows already is focused where it is, as the grid has it), and
 * Settings closes so the session is seen. Its id is lowercased, as the
 * runtime keys sessions and the sidebar opens them.
 */
export const useOpenInFocusedPane = (): ((session: PaneSession) => void) => {
  const [, setLayout] = usePresentation("paneLayout");
  const { close } = useSettings();
  return useCallback(
    (session: PaneSession) => {
      close();
      setLayout((held) => showSession(held, held.focused, { environmentId: session.environmentId, sessionId: session.sessionId.toLowerCase() }));
    },
    [close, setLayout],
  );
};
