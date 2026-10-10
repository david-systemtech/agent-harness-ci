import type { Writable } from "@agent-harness/client-runtime";
import type { AttachmentInput } from "@agent-harness/contracts";
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { panesOf } from "../grid/layout.js";
import { usePresentation } from "../window-context.js";

/**
 * What the window keeps for its new-session surfaces (docs/specs/gui.md, "A
 * new session"; #420), which the pane layout does not: its pending first
 * message and accepted environment identity, by the surface's id. These
 * survive temporary views such as pairing while the pane holds the surface,
 * and go once no pane holds it; the surface a gesture
 * just showed, whose message box takes the focus; and the New session
 * control being dragged, which a drop anywhere in the window reads.
 */

/** A New session control: the environment it carries, a heading's own; null for the header's, which carries the focused pane's. */
export interface NewSessionControl {
  readonly environmentId: string | null;
}

/** A pending first message stays with its pane through temporary view changes. */
export interface NewSessionMessage {
  readonly text: string;
  readonly attachments: readonly AttachmentInput[];
  /** Once creation is accepted, retries must use this environment. */
  readonly environmentId: string | null;
  /** An exists rejection proves the reserved id is used even when the list has not caught up. */
  readonly collisionEnvironmentId: string | null;
  readonly starting: boolean;
  readonly line: string | undefined;
}

interface Surfaces {
  readonly messages: Map<string, Writable<NewSessionMessage>>;
  /** The surface whose message box takes the focus next, by its id; null while none is to. */
  readonly focusAsked: { readonly id: string } | null;
  askFocus(id: string | null): void;
  /** The control being dragged; null while none is. */
  readonly dragged: NewSessionControl | null;
  /** The control being dragged now, read when the drag ends: a drop on the grid has taken it (null) or not. */
  draggedNow(): NewSessionControl | null;
  setDragged(control: NewSessionControl | null): void;
}

const SurfacesContext = createContext<Surfaces | null>(null);

export const NewSessionSurfaces = ({ children }: { readonly children: ReactNode }) => {
  const [layout] = usePresentation("paneLayout");
  const [messages] = useState(() => new Map<string, Writable<NewSessionMessage>>());
  const [focusAsked, setFocusAsked] = useState<{ readonly id: string } | null>(null);
  const [dragged, setDraggedState] = useState<NewSessionControl | null>(null);
  const draggedRef = useRef<NewSessionControl | null>(null);
  const setDragged = useCallback((control: NewSessionControl | null) => {
    draggedRef.current = control;
    setDraggedState(control);
  }, []);
  // A closed surface or one replaced by its session releases the pending message.
  useEffect(() => {
    const held = new Set(panesOf(layout).flatMap((pane) => (pane.newSession === undefined ? [] : [pane.newSession.id])));
    for (const id of messages.keys()) if (!held.has(id)) messages.delete(id);
  }, [layout, messages]);
  const surfaces = useMemo<Surfaces>(
    () => ({
      messages,
      focusAsked,
      askFocus: (id) => setFocusAsked(id === null ? null : { id }),
      dragged,
      draggedNow: () => draggedRef.current,
      setDragged,
    }),
    [messages, focusAsked, dragged, setDragged],
  );
  return <SurfacesContext value={surfaces}>{children}</SurfacesContext>;
};

export const useSurfaces = (): Surfaces => {
  const surfaces = use(SurfacesContext);
  if (surfaces === null) throw new Error("A new-session surface is drawn inside the window's frame, which keeps what is typed on it.");
  return surfaces;
};

/** The New session control being dragged (null while none is), and the setter that starts or ends a drag. */
export const useDraggedControl = (): readonly [NewSessionControl | null, (control: NewSessionControl | null) => void] => {
  const { dragged, setDragged } = useSurfaces();
  return [dragged, setDragged];
};
