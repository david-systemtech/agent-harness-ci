import { createContext, use, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import type { PaneSession } from "../presentation.js";
import { showPane, useSideColumn } from "../side-column/column.js";

/**
 * What a session pane's documents are asked from wherever they are shown
 * (docs/specs/gui.md, "The seven panes and the grid"; #410): the document
 * the Preview pane shows, which the Documents pane and the transcript's
 * document tiles open, and the call the transcript is asked to show, which
 * the Documents pane asks for. Each opening is a new one, so opening the
 * same document again reads it again (a preview is a snapshot), and asking
 * for the same call again shows it again. Nothing here is kept: another
 * session in the pane starts with none.
 */

/** The document the Preview pane shows, and which opening of it this is. */
export interface Previewed {
  /** Relative to the session's workspace. */
  readonly path: string;
  readonly opening: number;
}

/** The call the transcript is asked to show, and which asking this is. */
export interface Revealed {
  readonly toolCallId: string;
  readonly asking: number;
}

export interface PaneDocuments {
  readonly session: PaneSession;
  readonly previewed: Previewed | null;
  readonly revealed: Revealed | null;
  /** Opens `path` in the Preview pane, showing it in the side column, and reads it afresh. */
  preview(path: string): void;
  /** Shows the call in the transcript: unfolded, scrolled to and focused. */
  reveal(toolCallId: string): void;
}

const DocumentsContext = createContext<PaneDocuments | null>(null);

export const PaneDocumentsProvider = ({ session, children }: { readonly session: PaneSession; readonly children: ReactNode }) => {
  const [, change] = useSideColumn(session);
  const [previewed, setPreviewed] = useState<Previewed | null>(null);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const count = useRef(0);
  const preview = useCallback(
    (path: string) => {
      setPreviewed({ path, opening: ++count.current });
      change((held) => showPane(held, "preview"));
    },
    [change],
  );
  const reveal = useCallback((toolCallId: string) => setRevealed({ toolCallId, asking: ++count.current }), []);
  const value = useMemo(() => ({ session, previewed, revealed, preview, reveal }), [session, previewed, revealed, preview, reveal]);
  return <DocumentsContext value={value}>{children}</DocumentsContext>;
};

export const usePaneDocuments = (): PaneDocuments => {
  const documents = use(DocumentsContext);
  if (documents === null) throw new Error("A session's documents are asked for inside a session pane, which holds them.");
  return documents;
};
